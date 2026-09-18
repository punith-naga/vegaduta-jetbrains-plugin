package ai.vegaduta.ide.runtime

import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RuntimeFilesTest {
    private lateinit var dir: Path

    // sha256("hello\n")
    private val helloSha = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"

    @BeforeTest
    fun setUp() {
        dir = Files.createTempDirectory("vd-runtime-test")
    }

    @AfterTest
    fun tearDown() {
        deleteTree(dir)
    }

    @Test
    fun `sha256 of a small file matches the known digest`() {
        val f = dir.resolve("hello.txt").also { it.writeText("hello\n") }
        assertEquals(helloSha, sha256Hex(f))
        assertEquals(helloSha, sha256Hex("hello\n".toByteArray()))
    }

    @Test
    fun `isVerified accepts the right hash, writes a marker, then trusts it`() {
        val f = dir.resolve("hello.txt").also { it.writeText("hello\n") }
        assertTrue(isVerified(f, 6, helloSha))
        assertEquals("$helloSha 6", markerFor(f).readText())
        // With a matching marker the file is not re-read: prove it by
        // changing the content but not the size.
        f.writeText("jello\n")
        assertTrue(isVerified(f, 6, helloSha))
    }

    @Test
    fun `isVerified rejects a wrong hash, a wrong size and a missing file`() {
        val f = dir.resolve("hello.txt").also { it.writeText("hello\n") }
        assertFalse(isVerified(f, 6, "0".repeat(64)))
        assertFalse(Files.exists(markerFor(f)))
        assertFalse(isVerified(f, 7, helloSha))
        assertFalse(isVerified(dir.resolve("absent"), 6, helloSha))
    }

    @Test
    fun `a stale marker is not trusted when the size differs`() {
        val f = dir.resolve("hello.txt").also { it.writeText("hello\n") }
        assertTrue(isVerified(f, 6, helloSha))
        f.writeText("hello, longer\n")
        assertFalse(isVerified(f, 6, helloSha))
    }

    @Test
    fun `safeEntryPath rejects zip-slip entries`() {
        val dest = dir.resolve("out")
        for (bad in listOf("../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/Windows/evil.dll", "..\\evil.txt", "a\\..\\..\\evil")) {
            assertFailsWith<RuntimeInstallException>(bad) { safeEntryPath(dest, bad) }
        }
        assertEquals(dest.toAbsolutePath().normalize().resolve("llama/bin/llama-server"), safeEntryPath(dest, "llama/bin/llama-server"))
        assertEquals(dest.toAbsolutePath().normalize().resolve("b"), safeEntryPath(dest, "a/../b"))
    }

    @Test
    fun `extractZip refuses an archive with an escaping entry and writes nothing outside`() {
        val zip = dir.resolve("evil.zip")
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            out.putNextEntry(ZipEntry("ok.txt")); out.write("ok".toByteArray()); out.closeEntry()
            out.putNextEntry(ZipEntry("../escaped.txt")); out.write("bad".toByteArray()); out.closeEntry()
        }
        assertFailsWith<RuntimeInstallException> { extractZip(zip, dir.resolve("out")) }
        assertFalse(Files.exists(dir.resolve("escaped.txt")))
    }

    @Test
    fun `extractZip unpacks nested folders and findServerBinary finds the server`() {
        val zip = dir.resolve("good.zip")
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            out.putNextEntry(ZipEntry("build/bin/")); out.closeEntry()
            out.putNextEntry(ZipEntry("build/bin/llama-server.exe")); out.write("MZ".toByteArray()); out.closeEntry()
            out.putNextEntry(ZipEntry("build/bin/ggml.dll")); out.write("MZ".toByteArray()); out.closeEntry()
        }
        val out = dir.resolve("out")
        extractZip(zip, out)
        val server = assertNotNull(findServerBinary(out, windows = true))
        assertEquals("llama-server.exe", server.fileName.toString())
        assertNull(findServerBinary(out, windows = false))
        assertNull(findServerBinary(dir.resolve("missing"), windows = true))
    }

    @Test
    fun `pickFreePort returns a loopback port that can be bound`() {
        val port = pickFreePort()
        assertTrue(port in 1..65535)
        ServerSocket(port, 1, InetAddress.getLoopbackAddress()).use { assertEquals(port, it.localPort) }
        assertEquals("http://127.0.0.1:$port", runtimeBaseUrl(port))
    }

    @Test
    fun `formatBytes speaks in MB and GB`() {
        assertEquals("4.7 GB", formatBytes(4683073536L))
        assertEquals("1.1 GB", formatBytes(1117320768L))
        assertEquals("412 MB", formatBytes(412_000_000L))
    }
}
