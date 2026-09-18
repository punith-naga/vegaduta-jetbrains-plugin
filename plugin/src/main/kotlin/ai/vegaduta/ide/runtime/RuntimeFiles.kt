// File-level building blocks of the bundled runtime: checksum verification
// (with a marker so a 4 GB model is not re-hashed on every start), a
// progress-reporting, cancellable, hash-while-streaming download, archive
// extraction guarded against zip-slip, locating llama-server in the result,
// and picking a free loopback port.
//
// Pure JDK, no IntelliJ API - BundledRuntimeService supplies logging, progress
// UI and threads. Every function here is unit-testable with small temp files.

package ai.vegaduta.ide.runtime

import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.time.Duration
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipInputStream

/** Thrown when the user cancelled (runtime.stop, or the IDE progress's X). */
class RuntimeCancelledException : IOException("Cancelled.")

/** Thrown for anything the person should read, already phrased for them. */
class RuntimeInstallException(message: String) : IOException(message)

private const val MARKER_SUFFIX = ".sha256-ok"
private const val BUFFER_SIZE = 256 * 1024

fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

fun sha256Hex(file: Path, cancelled: AtomicBoolean = AtomicBoolean(false)): String {
    val digest = MessageDigest.getInstance("SHA-256")
    Files.newInputStream(file).use { input ->
        val buffer = ByteArray(BUFFER_SIZE)
        while (true) {
            if (cancelled.get()) throw RuntimeCancelledException()
            val n = input.read(buffer)
            if (n < 0) break
            digest.update(buffer, 0, n)
        }
    }
    return digest.digest().toHex()
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/** <file>.sha256-ok - holds "<sha256> <size>" once [file] has been hashed. */
fun markerFor(file: Path): Path = file.resolveSibling(file.fileName.toString() + MARKER_SUFFIX)

/**
 * True when [file] exists with exactly [expectedSize] bytes and [expectedSha256].
 *
 * The hash is trusted from the marker when the marker names this hash and this
 * size; a missing or stale marker (another tool wrote the file, or its size
 * changed) means a full re-hash, and a verified file gets a fresh marker. A
 * size mismatch is decided without reading the file at all. Never deletes.
 */
fun isVerified(
    file: Path,
    expectedSize: Long,
    expectedSha256: String,
    cancelled: AtomicBoolean = AtomicBoolean(false),
): Boolean {
    if (!Files.isRegularFile(file)) return false
    val size = runCatching { Files.size(file) }.getOrElse { return false }
    if (size != expectedSize) return false
    val marker = markerFor(file)
    val recorded = runCatching { Files.readString(marker).trim() }.getOrNull()
    if (recorded == "${expectedSha256.lowercase(Locale.ROOT)} $expectedSize") return true
    val actual = sha256Hex(file, cancelled)
    if (!actual.equals(expectedSha256, ignoreCase = true)) return false
    writeMarker(file, actual, size)
    return true
}

fun writeMarker(file: Path, sha256: String, size: Long) {
    runCatching { Files.writeString(markerFor(file), "${sha256.lowercase(Locale.ROOT)} $size") }
}

/** "412 MB", "1.1 GB" - decimal units, as download pages and file managers
 * on macOS show them (the recommended model is 1,117,320,768 bytes = 1.1 GB). */
fun formatBytes(bytes: Long): String {
    val mb = bytes / 1_000_000.0
    return when {
        mb >= 1000.0 -> String.format(Locale.ROOT, "%.1f GB", mb / 1000.0)
        mb >= 1.0 -> String.format(Locale.ROOT, "%.0f MB", mb)
        else -> String.format(Locale.ROOT, "%.0f KB", bytes / 1000.0)
    }
}

/**
 * Download [url] to [target], checking it against [expectedSize] and
 * [expectedSha256]. Streams to a `.part` file next to the target, hashing as it
 * goes, and moves the file into place only once the hash matches - so [target]
 * either does not exist or is a verified copy. A mismatch deletes the partial
 * file and throws. [onProgress] gets (bytesSoFar, totalBytes) about every 1%.
 *
 * Redirects are followed: GitHub release assets and Hugging Face files both
 * answer with a redirect to a CDN.
 */
fun downloadVerified(
    http: HttpClient,
    url: String,
    target: Path,
    expectedSize: Long,
    expectedSha256: String,
    cancelled: AtomicBoolean,
    onProgress: (Long, Long) -> Unit,
) {
    Files.createDirectories(target.parent)
    // pid + a random tag: two IDEs (or this plugin and the Eclipse one), or a
    // cancelled download and its replacement in this one, never share a
    // partial file - and one's cleanup never deletes the other's.
    val tag = ProcessHandle.current().pid().toString() + "-" + java.util.UUID.randomUUID().toString().take(8)
    val part = target.resolveSibling(target.fileName.toString() + "." + tag + ".part")
    val request = HttpRequest.newBuilder(URI.create(url))
        .timeout(Duration.ofMinutes(2)) // time to response headers, not the whole body
        .header("User-Agent", "VegaDuta-JetBrains")
        .GET()
        .build()
    val response = try {
        http.send(request, HttpResponse.BodyHandlers.ofInputStream())
    } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        throw RuntimeCancelledException()
    }
    try {
        response.body().use { body ->
            if (response.statusCode() !in 200..299) {
                throw RuntimeInstallException("The download server answered HTTP ${response.statusCode()} for ${target.fileName}.")
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            var lastReportedPercent = -1
            Files.newOutputStream(part).use { out ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    if (cancelled.get()) throw RuntimeCancelledException()
                    val n = body.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    digest.update(buffer, 0, n)
                    written += n
                    if (written > expectedSize) {
                        throw RuntimeInstallException("${target.fileName} is larger than expected - the download was refused.")
                    }
                    val percent = ((written * 100) / expectedSize.coerceAtLeast(1)).toInt()
                    if (percent != lastReportedPercent) {
                        lastReportedPercent = percent
                        onProgress(written, expectedSize)
                    }
                }
            }
            if (written != expectedSize) {
                throw RuntimeInstallException(
                    "${target.fileName} arrived incomplete (${formatBytes(written)} of ${formatBytes(expectedSize)}). Try again."
                )
            }
            val actual = digest.digest().toHex()
            if (!actual.equals(expectedSha256, ignoreCase = true)) {
                throw RuntimeInstallException(
                    "${target.fileName} failed its checksum check and was deleted. Try again; if it keeps failing, " +
                        "something between you and the download server is changing the file."
                )
            }
            moveIntoPlace(part, target)
            writeMarker(target, actual, written)
        }
    } finally {
        Files.deleteIfExists(part)
    }
}

/** Atomic rename where the file system can, a plain replace where it cannot. */
fun moveIntoPlace(source: Path, target: Path) {
    try {
        Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } catch (e: AtomicMoveNotSupportedException) {
        Files.move(source, target, StandardCopyOption.REPLACE_EXISTING)
    }
}

/**
 * Where archive entry [entryName] would land under [destDir], or a thrown
 * [RuntimeInstallException] if it would land anywhere else (zip-slip: `..`
 * segments, absolute paths, drive letters). Pure path arithmetic - nothing is
 * touched on disk.
 */
fun safeEntryPath(destDir: Path, entryName: String): Path {
    val root = destDir.toAbsolutePath().normalize()
    val cleaned = entryName.replace('\\', '/')
    if (cleaned.startsWith("/") || Regex("^[A-Za-z]:").containsMatchIn(cleaned)) {
        throw RuntimeInstallException("The runtime archive contains an absolute path ($entryName) and was refused.")
    }
    val resolved = root.resolve(cleaned).normalize()
    if (!resolved.startsWith(root)) {
        throw RuntimeInstallException("The runtime archive tries to write outside its folder ($entryName) and was refused.")
    }
    return resolved
}

/** Extract a .zip into [destDir], refusing any entry that escapes it. */
fun extractZip(archive: Path, destDir: Path, cancelled: AtomicBoolean = AtomicBoolean(false)) {
    Files.createDirectories(destDir)
    ZipInputStream(Files.newInputStream(archive)).use { zip ->
        while (true) {
            if (cancelled.get()) throw RuntimeCancelledException()
            val entry = zip.nextEntry ?: break
            val out = safeEntryPath(destDir, entry.name)
            if (entry.isDirectory) {
                Files.createDirectories(out)
            } else {
                Files.createDirectories(out.parent)
                Files.copy(zip as InputStream, out, StandardCopyOption.REPLACE_EXISTING)
            }
            zip.closeEntry()
        }
    }
}

/**
 * Extract a .tar.gz into [destDir] with the platform's own `tar` (always there
 * on macOS and Linux). `tar` is used rather than a Java library because the
 * macOS and Linux builds carry shared-library SYMLINKS (libggml.dylib ->
 * libggml.0.dylib ...) and file modes, which it restores exactly. The entry
 * list is checked with [safeEntryPath] BEFORE anything is extracted.
 */
fun extractTarGz(archive: Path, destDir: Path, cancelled: AtomicBoolean = AtomicBoolean(false)) {
    Files.createDirectories(destDir)
    val listing = runTar(listOf("tar", "-tzf", archive.toString()), destDir, cancelled)
    listing.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.forEach { safeEntryPath(destDir, it) }
    runTar(listOf("tar", "-xzf", archive.toString(), "-C", destDir.toString()), destDir, cancelled)
}

private fun runTar(command: List<String>, workDir: Path, cancelled: AtomicBoolean): String {
    val process = ProcessBuilder(command).directory(workDir.toFile()).redirectErrorStream(true).start()
    val output = StringBuilder()
    val reader = Thread {
        runCatching { process.inputStream.bufferedReader().forEachLine { output.appendLine(it) } }
    }.apply { isDaemon = true; start() }
    while (!process.waitFor(200, TimeUnit.MILLISECONDS)) {
        if (cancelled.get()) {
            process.destroyForcibly()
            throw RuntimeCancelledException()
        }
    }
    reader.join(2_000)
    if (process.exitValue() != 0) {
        throw RuntimeInstallException("Unpacking the runtime failed (tar exited ${process.exitValue()}): ${output.toString().trim().take(400)}")
    }
    return output.toString()
}

/** The llama-server executable somewhere under [dir], or null. */
fun findServerBinary(dir: Path, windows: Boolean): Path? {
    if (!Files.isDirectory(dir)) return null
    val name = if (windows) "llama-server.exe" else "llama-server"
    return Files.walk(dir).use { paths ->
        paths.filter { Files.isRegularFile(it) && it.fileName.toString() == name }
            .sorted(compareBy { it.nameCount })
            .findFirst()
            .orElse(null)
    }
}

/** chmod u+x on every regular file under [dir] - the binaries and the shared
 * libraries next to them. No-op on a file system without POSIX permissions. */
fun markExecutable(dir: Path) {
    Files.walk(dir).use { paths ->
        paths.filter { Files.isRegularFile(it) && !Files.isSymbolicLink(it) }.forEach { file ->
            runCatching {
                val perms = Files.getPosixFilePermissions(file).toMutableSet()
                perms += PosixFilePermission.OWNER_EXECUTE
                perms += PosixFilePermission.OWNER_READ
                Files.setPosixFilePermissions(file, perms)
            }
        }
    }
}

/** Recursively delete [dir]; best effort. */
fun deleteTree(dir: Path) {
    if (!Files.exists(dir)) return
    runCatching {
        Files.walk(dir).use { paths ->
            paths.sorted(Comparator.reverseOrder()).forEach { runCatching { Files.deleteIfExists(it) } }
        }
    }
}

/** Rename a fully extracted folder into its final place. When another process
 * won the race and the folder already exists, the winner's copy is kept. */
fun publishDir(staging: Path, finalDir: Path) {
    try {
        Files.move(staging, finalDir, StandardCopyOption.ATOMIC_MOVE)
    } catch (e: FileAlreadyExistsException) {
        deleteTree(staging)
    } catch (e: AtomicMoveNotSupportedException) {
        Files.move(staging, finalDir)
    } catch (e: java.nio.file.DirectoryNotEmptyException) {
        deleteTree(staging)
    }
}

/**
 * A TCP port on 127.0.0.1 that nothing was listening on a moment ago: bind
 * port 0, read what the OS picked, close. Another process can take it before
 * llama-server binds it - a startup failure then says so and a retry picks
 * another.
 */
fun pickFreePort(): Int = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
