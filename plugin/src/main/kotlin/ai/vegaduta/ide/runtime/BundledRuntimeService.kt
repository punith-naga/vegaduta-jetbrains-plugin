// The bundled on-device runtime: one click downloads llama.cpp's llama-server
// and a GGUF model (both pinned and SHA-256-checked, RuntimeCatalog.kt), runs
// the server on 127.0.0.1, and points the plugin's EXISTING local-server
// settings at it - so chat (JcefBridge's hostLocalEngine + the webview's
// OpenAI-compatible backend), code completions (LocalCompletionEngine) and a
// coding agent with no endpoint of its own (StartCodingTaskAction) all use it
// with no further setup.
//
// Why it exists: JCEF has no WebGPU, so the webview's WebLLM engine can never
// run in this host, and without this an IntelliJ user got on-device AI only by
// installing Ollama or LM Studio themselves.
//
// Driven from three places, all through this one service: the chat webview
// (runtime.query / runtime.install / runtime.stop, see JcefBridge), the
// "Bundled on-device model" row in Settings | Tools | VegaDuta, and
// BundledRuntimeStartup, which restarts the last-used model when the IDE opens.
//
// Threads: nothing here blocks the EDT. Downloads, hashing, extraction and
// the health wait run inside a Task.Backgroundable (so the IDE's own progress
// bar shows them too); listeners are called on whatever thread changed the
// state and must hop to the EDT themselves for Swing work.
//
// Privacy: a model download carries none of the person's content, so Private
// Mode does not gate it (protocol.ts runtime.install says the same). The
// server binds 127.0.0.1 only.
//
// RULE 0 carve-out: every 127.0.0.1 URL here is the user's own process on
// their own machine, not a browser-facing platform URL or token issuer.

package ai.vegaduta.ide.runtime

import ai.vegaduta.ide.completions.LocalCompletionEngine
import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.ArrayDeque
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Who wants to hear about the runtime. Called off the EDT. */
interface BundledRuntimeListener {
    /** Every state change, including each ~1% of download progress. */
    fun statusChanged(status: RuntimeStatusSnapshot)

    /** localServerBaseUrl / localServerModel were just rewritten by the
     * runtime (it started, or the person stopped it). Chat surfaces re-send
     * init; the settings dialog refreshes its fields. */
    fun localServerSettingsChanged() {}
}

@Service(Service.Level.APP)
class BundledRuntimeService : Disposable {
    private val log = logger<BundledRuntimeService>()

    private val http: HttpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL) // GitHub and Hugging Face redirect to CDNs
        .connectTimeout(Duration.ofSeconds(30))
        .build()
    private val probeHttp: HttpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(2))
        .build()

    private val listeners = CopyOnWriteArrayList<BundledRuntimeListener>()
    private val lock = Any()

    /** Bumped by every install and stop: a worker whose generation is no
     * longer current has been superseded and must neither publish nor start. */
    private val generation = AtomicLong()
    private val autoStartDone = AtomicBoolean(false)

    // Guarded by [lock].
    private var current = RuntimeStatusSnapshot(RuntimeState.ABSENT)
    private var cancelFlag: AtomicBoolean? = null
    private var indicator: ProgressIndicator? = null
    private var process: Process? = null
    private var activeModelId: String? = null

    private val outputTail = ArrayDeque<String>()

    private val shutdownHook = Thread({ killProcessTree(process) }, "VegaDuta runtime shutdown")

    init {
        // Belt and braces for an IDE that exits without disposing services
        // (a crash of the EDT, kill -TERM): never leave a llama-server behind.
        runCatching { Runtime.getRuntime().addShutdownHook(shutdownHook) }
        current = idleStatus()
    }

    // --- public API ------------------------------------------------------

    fun addListener(listener: BundledRuntimeListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: BundledRuntimeListener) {
        listeners.remove(listener)
    }

    /** The whole state, with each model's installed flag re-read from disk
     * (cheap: size + marker, never a re-hash). */
    fun status(): RuntimeStatusSnapshot = synchronized(lock) { current }.copy(models = modelInfos())

    /** (baseUrl, modelId) while the server is up and healthy, else null. */
    fun runningEndpoint(): Pair<String, String>? {
        val s = synchronized(lock) { current }
        return if (s.state == RuntimeState.RUNNING && s.baseUrl != null && s.modelId != null) s.baseUrl to s.modelId else null
    }

    /**
     * Download (whatever is missing) and start [modelId], stopping any other.
     * [userAsked] = a click, which may overwrite a hand-typed local-server URL;
     * the automatic start on IDE open may not (BundledRuntimeSettings).
     */
    fun install(modelId: String, userAsked: Boolean = true) {
        // Off the caller's thread: stopping a previous server waits for it to
        // exit, and callers include the EDT (Settings) and the CEF query thread.
        ApplicationManager.getApplication().executeOnPooledThread { installNow(modelId, userAsked) }
    }

    private fun installNow(modelId: String, userAsked: Boolean) {
        val model = catalogModel(modelId)
        if (model == null) {
            publish(generation.get(), RuntimeStatusSnapshot(RuntimeState.ERROR, modelId, detail = "Unknown model \"$modelId\"."))
            return
        }
        val already = synchronized(lock) {
            val busy = current.state == RuntimeState.DOWNLOADING || current.state == RuntimeState.STARTING
            current.modelId == modelId && (busy || current.state == RuntimeState.RUNNING)
        }
        if (already) {
            // Already on its way (or there): just say where it stands.
            notifyStatus(status())
            return
        }
        val archive = currentRuntimeArchive()
        if (archive == null) {
            publish(
                generation.get(),
                RuntimeStatusSnapshot(
                    RuntimeState.ERROR, modelId,
                    detail = "llama.cpp publishes no build for this computer (" +
                        System.getProperty("os.name") + " " + System.getProperty("os.arch") +
                        "). Use Ollama or LM Studio and set the local server URL instead.",
                ),
            )
            return
        }
        val gen = supersede()
        val cancelled = AtomicBoolean(false)
        synchronized(lock) { cancelFlag = cancelled }
        publish(gen, RuntimeStatusSnapshot(RuntimeState.DOWNLOADING, modelId, 0.0, "Checking what is already downloaded..."))

        val task = object : Task.Backgroundable(null, "VegaDuta: setting up the on-device model", true) {
            override fun run(progress: ProgressIndicator) {
                synchronized(lock) { if (generation.get() == gen) indicator = progress }
                progress.isIndeterminate = false
                try {
                    runInstall(gen, archive, model, cancelled, progress, userAsked)
                } catch (e: RuntimeCancelledException) {
                    if (generation.get() == gen) stopInternal(userStopped = true)
                } catch (e: RuntimeInstallException) {
                    log.info("bundled runtime: ${e.message}")
                    publish(gen, RuntimeStatusSnapshot(RuntimeState.ERROR, modelId, detail = e.message))
                } catch (e: Exception) {
                    log.warn("bundled runtime install failed", e)
                    publish(gen, RuntimeStatusSnapshot(RuntimeState.ERROR, modelId, detail = "Setup failed: ${e.message ?: e.javaClass.simpleName}"))
                } finally {
                    synchronized(lock) { if (indicator === progress) indicator = null }
                }
            }
        }
        // Background tasks must be queued from the EDT; ModalityState.any()
        // so a click inside the (modal) Settings dialog starts it at once.
        ApplicationManager.getApplication().invokeLater({ ProgressManager.getInstance().run(task) }, ModalityState.any())
    }

    /** runtime.stop: cancel a download in progress, or stop the server. */
    fun stop() {
        stopInternal(userStopped = true)
    }

    /** Called once per IDE session (BundledRuntimeStartup): restart the model
     * the person last ran, if it is fully on disk. Never downloads. */
    fun autoStartIfInstalled() {
        if (!autoStartDone.compareAndSet(false, true)) return
        val model = catalogModel(VegadutaSettingsState.getInstance().bundledRuntimeModel.trim()) ?: return
        if (!isModelInstalledQuick(model) || !isRuntimeInstalled()) {
            log.info("bundled runtime: ${model.id} is not fully downloaded - not auto-starting")
            return
        }
        install(model.id, userAsked = false)
    }

    override fun dispose() {
        generation.incrementAndGet()
        val p = synchronized(lock) {
            cancelFlag?.set(true)
            indicator?.cancel()
            process.also { process = null }
        }
        killProcessTree(p)
        runCatching { Runtime.getRuntime().removeShutdownHook(shutdownHook) }
        listeners.clear()
    }

    // --- install pipeline ------------------------------------------------

    private fun runInstall(
        gen: Long,
        archive: RuntimeArchive,
        model: CatalogModel,
        cancelled: AtomicBoolean,
        progress: ProgressIndicator,
        userAsked: Boolean,
    ) {
        fun checkCancel() {
            if (progress.isCanceled) cancelled.set(true)
            if (cancelled.get() || generation.get() != gen) throw RuntimeCancelledException()
        }

        val windows = archive.platform.os == RuntimeOs.WINDOWS
        val binDir = runtimeDir(archive.platform)
        var server = findServerBinary(binDir, windows)
        if (server == null) {
            val archiveFile = binDir.resolveSibling(archive.assetName)
            if (!isVerified(archiveFile, archive.sizeBytes, archive.sha256, cancelled)) {
                checkCancel()
                download(gen, archive.url, archiveFile, archive.sizeBytes, archive.sha256, cancelled, progress, model.id, "the runtime")
            }
            checkCancel()
            progress.text = "Unpacking the runtime"
            publish(gen, RuntimeStatusSnapshot(RuntimeState.DOWNLOADING, model.id, 1.0, "Unpacking the runtime..."))
            val staging = binDir.resolveSibling(".${binDir.fileName}.${ProcessHandle.current().pid()}-$gen.tmp")
            deleteTree(staging)
            try {
                if (archive.isZip) extractZip(archiveFile, staging, cancelled) else extractTarGz(archiveFile, staging, cancelled)
                if (!windows) markExecutable(staging)
                if (findServerBinary(staging, windows) == null) {
                    throw RuntimeInstallException("The runtime archive has no llama-server in it.")
                }
                publishDir(staging, binDir)
            } finally {
                deleteTree(staging)
            }
            // The extracted folder is the installed runtime; the archive is
            // only a way to get it.
            runCatching { Files.deleteIfExists(archiveFile); Files.deleteIfExists(markerFor(archiveFile)) }
            server = findServerBinary(binDir, windows)
                ?: throw RuntimeInstallException("The runtime was unpacked, but llama-server is missing from it.")
        }

        checkCancel()
        val gguf = modelFile(model)
        if (!isModelInstalledQuick(model)) {
            // A file without our marker (copied in, or the Eclipse plugin
            // stopped before writing one) is hashed once rather than fetched.
            if (Files.isRegularFile(gguf)) {
                progress.text = "Checking the model file"
                publish(gen, RuntimeStatusSnapshot(RuntimeState.DOWNLOADING, model.id, 0.0, "Checking the model file already on disk..."))
            }
            if (!isVerified(gguf, model.sizeBytes, model.sha256, cancelled)) {
                checkCancel()
                download(gen, model.url, gguf, model.sizeBytes, model.sha256, cancelled, progress, model.id, "the model")
            }
        }

        checkCancel()
        startServer(gen, server, gguf, model, cancelled, progress, userAsked)
    }

    private fun download(
        gen: Long,
        url: String,
        target: Path,
        size: Long,
        sha256: String,
        cancelled: AtomicBoolean,
        progress: ProgressIndicator,
        modelId: String,
        what: String,
    ) {
        progress.text = "Downloading $what"
        downloadVerified(http, url, target, size, sha256, cancelled) { done, total ->
            if (progress.isCanceled) cancelled.set(true)
            val fraction = done.toDouble() / total.coerceAtLeast(1)
            progress.fraction = fraction
            val detail = "Downloading $what - ${formatBytes(done)} of ${formatBytes(total)}"
            progress.text2 = detail
            publish(gen, RuntimeStatusSnapshot(RuntimeState.DOWNLOADING, modelId, fraction, detail))
        }
    }

    private fun startServer(
        gen: Long,
        server: Path,
        gguf: Path,
        model: CatalogModel,
        cancelled: AtomicBoolean,
        progress: ProgressIndicator,
        userAsked: Boolean,
    ) {
        // One server at a time: whatever ran before goes first.
        killProcessTree(synchronized(lock) { process.also { process = null } })

        val port = pickFreePort()
        val baseUrl = runtimeBaseUrl(port)
        val command = listOf(
            server.toString(),
            "-m", gguf.toString(),
            "--host", "127.0.0.1",
            "--port", port.toString(),
            "-c", "8192",
            "--alias", model.id,
            // Same hardening as the Eclipse plug-in: the server's default CORS
            // lets any page on this machine reach the loopback port, so switch
            // off what a stray page has no business seeing - the built-in web
            // UI and /slots (which shows what each slot is working on).
            "--no-webui",
            "--no-slots",
        )
        val binDir = server.parent
        val builder = ProcessBuilder(command).directory(binDir.toFile()).redirectErrorStream(true)
        if (System.getProperty("os.name").lowercase().startsWith("linux")) {
            val existing = System.getenv("LD_LIBRARY_PATH")
            builder.environment()["LD_LIBRARY_PATH"] =
                if (existing.isNullOrBlank()) binDir.toString() else binDir.toString() + java.io.File.pathSeparator + existing
        }
        progress.text = "Starting the on-device model"
        progress.isIndeterminate = true
        publish(gen, RuntimeStatusSnapshot(RuntimeState.STARTING, model.id, detail = "Loading ${model.displayName}..."))

        synchronized(outputTail) { outputTail.clear() }
        val proc = synchronized(lock) {
            if (generation.get() != gen) throw RuntimeCancelledException()
            builder.start().also {
                process = it
                activeModelId = model.id
            }
        }
        log.info("bundled runtime: started llama-server pid ${proc.pid()} on port $port with ${model.id}")
        Thread({ pumpOutput(proc) }, "VegaDuta llama-server output").apply { isDaemon = true; start() }

        val deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS
        while (true) {
            if (progress.isCanceled) cancelled.set(true)
            if (cancelled.get() || generation.get() != gen) throw RuntimeCancelledException()
            if (!proc.isAlive) {
                throw RuntimeInstallException(
                    "The on-device model server exited while starting (code ${proc.exitValue()})." + tailForError()
                )
            }
            if (isHealthy(baseUrl)) break
            if (System.currentTimeMillis() > deadline) {
                killProcessTree(proc)
                throw RuntimeInstallException(
                    "The on-device model server did not become ready within ${HEALTH_TIMEOUT_MS / 1000} seconds." + tailForError()
                )
            }
            Thread.sleep(HEALTH_POLL_MS)
        }

        // Up. Point the plugin at it, then tell everyone.
        val settingsChanged = synchronized(lock) {
            if (generation.get() != gen) throw RuntimeCancelledException()
            BundledRuntimeSettings.applyRunning(VegadutaSettingsState.getInstance(), baseUrl, model.id, userAsked)
        }
        if (!settingsChanged) {
            log.info("bundled runtime: running at $baseUrl, but the local server setting points elsewhere - left as the user set it")
        }
        publish(gen, RuntimeStatusSnapshot(RuntimeState.RUNNING, model.id, detail = "${model.displayName} is running on this computer.", baseUrl = baseUrl))
        if (settingsChanged) announceSettingsChanged()

        proc.onExit().thenAccept { exited ->
            val stillCurrent = synchronized(lock) { process === exited && generation.get() == gen }
            if (stillCurrent) {
                synchronized(lock) { process = null }
                publish(
                    gen,
                    RuntimeStatusSnapshot(
                        RuntimeState.ERROR, model.id,
                        detail = "The on-device model server stopped unexpectedly (code ${exited.exitValue()})." + tailForError(),
                    ),
                )
            }
        }
    }

    /** GET /health (200 once the model is loaded, 503 while loading); an old
     * or unusual server without it gets GET /v1/models instead. */
    private fun isHealthy(baseUrl: String): Boolean {
        val health = httpStatus("$baseUrl/health")
        if (health == 200) return true
        if (health == 404) return httpStatus("$baseUrl/v1/models") == 200
        return false
    }

    private fun httpStatus(url: String): Int = try {
        val request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(3)).GET().build()
        probeHttp.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
    } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        -1
    } catch (e: Exception) {
        -1
    }

    private fun pumpOutput(proc: Process) {
        runCatching {
            proc.inputStream.bufferedReader().forEachLine { line ->
                log.debug("llama-server: $line")
                synchronized(outputTail) {
                    outputTail.addLast(line)
                    while (outputTail.size > OUTPUT_TAIL_LINES) outputTail.removeFirst()
                }
            }
        }
    }

    private fun tailForError(): String {
        val lines = synchronized(outputTail) { outputTail.toList() }.takeLast(ERROR_TAIL_LINES)
        return if (lines.isEmpty()) "" else "\nLast output:\n" + lines.joinToString("\n")
    }

    // --- stop / state ----------------------------------------------------

    /** A new generation: cancels whatever install is running and stops the
     * server, WITHOUT publishing a stopped state (the caller publishes next). */
    private fun supersede(): Long {
        val gen = generation.incrementAndGet()
        val p = synchronized(lock) {
            cancelFlag?.set(true)
            cancelFlag = null
            indicator?.cancel()
            indicator = null
            activeModelId = null
            process.also { process = null }
        }
        killProcessTree(p)
        return gen
    }

    private fun stopInternal(userStopped: Boolean) {
        val gen = supersede()
        var settingsChanged = false
        if (userStopped) {
            settingsChanged = BundledRuntimeSettings.clearAfterStop(VegadutaSettingsState.getInstance())
        }
        publish(gen, idleStatus())
        if (settingsChanged) announceSettingsChanged()
    }

    private fun announceSettingsChanged() {
        runCatching { service<LocalCompletionEngine>().invalidate() }
        for (l in listeners) runCatching { l.localServerSettingsChanged() }
    }

    /** Set the state (unless [gen] was superseded) and tell every listener. */
    private fun publish(gen: Long, snapshot: RuntimeStatusSnapshot) {
        synchronized(lock) {
            if (generation.get() != gen) return
            current = snapshot
        }
        notifyStatus(snapshot.copy(models = modelInfos()))
    }

    private fun notifyStatus(snapshot: RuntimeStatusSnapshot) {
        for (l in listeners) {
            runCatching { l.statusChanged(snapshot) }.onFailure { log.warn("runtime listener failed", it) }
        }
    }

    /** "stopped" once anything usable is on disk, else "absent". */
    private fun idleStatus(): RuntimeStatusSnapshot {
        val anyInstalled = isRuntimeInstalled() && CATALOG_MODELS.any { isModelInstalledQuick(it) }
        return if (anyInstalled) {
            RuntimeStatusSnapshot(RuntimeState.STOPPED, detail = "The on-device model is downloaded but not running.")
        } else {
            RuntimeStatusSnapshot(RuntimeState.ABSENT)
        }
    }

    private fun modelInfos(): List<RuntimeModelInfo> = CATALOG_MODELS.map {
        RuntimeModelInfo(it.id, it.displayName, it.sizeBytes, isModelInstalledQuick(it), it.recommended)
    }

    /** Size + marker only - never hashes, so it is safe on any thread, often. */
    private fun isModelInstalledQuick(model: CatalogModel): Boolean {
        val file = modelFile(model)
        return runCatching {
            Files.isRegularFile(file) && Files.size(file) == model.sizeBytes &&
                Files.readString(markerFor(file)).trim() == "${model.sha256} ${model.sizeBytes}"
        }.getOrDefault(false)
    }

    private fun isRuntimeInstalled(): Boolean {
        val archive = currentRuntimeArchive() ?: return false
        return runCatching { findServerBinary(runtimeDir(archive.platform), archive.platform.os == RuntimeOs.WINDOWS) != null }
            .getOrDefault(false)
    }

    private companion object {
        const val HEALTH_TIMEOUT_MS = 180_000L
        const val HEALTH_POLL_MS = 500L
        const val OUTPUT_TAIL_LINES = 60
        const val ERROR_TAIL_LINES = 12
    }
}

/** Stop [process] and everything it spawned: descendants first, then the
 * process, then force whatever is left after a short grace period. */
internal fun killProcessTree(process: Process?) {
    if (process == null) return
    val handle = process.toHandle()
    val children = runCatching { handle.descendants().toList() }.getOrDefault(emptyList())
    children.forEach { runCatching { it.destroy() } }
    runCatching { process.destroy() }
    runCatching {
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly()
    }
    children.forEach { if (it.isAlive) runCatching { it.destroyForcibly() } }
}
