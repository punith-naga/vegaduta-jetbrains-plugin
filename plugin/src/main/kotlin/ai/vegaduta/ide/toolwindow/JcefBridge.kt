// Host side of clients/shared/src/webview/protocol.ts over JCEF.
//
// Transport (matches clients/shared/src/webview/bridge.ts):
//  - webview -> host: JBCefJSQuery, exposed to the page as window.cefQuery.
//    The shim MUST exist before the app bundle runs (detectTransport() is
//    called at boot), so it is baked into the HTML ahead of the app script.
//  - host -> webview: cefBrowser.executeJavaScript calling
//    window.__vegadutaDeliver(json). Posts are queued until the page sends
//    "ready".
//
// Page loading: the shared webview bundle is read from plugin resources
// (/webview/, populated by the copyWebview gradle task) and every
// <script src> / stylesheet <link> is INLINED into a single document for
// browser.loadHTML(). Chosen over a JBCefLocalRequestHandler-style custom
// scheme because the bundle is one js + one css with no other assets, and
// loadHTML avoids per-IDE-version CefRequestHandler API churn.
//
// Token rule: the access token NEVER enters the webview - SSE runs on this
// side and chunks are forwarded as chat.chunk messages.

package ai.vegaduta.ide.toolwindow

import ai.vegaduta.ide.api.AgentSummary
import ai.vegaduta.ide.api.ApiClient
import ai.vegaduta.ide.api.ApiException
import ai.vegaduta.ide.api.WireJson
import ai.vegaduta.ide.api.WorkflowRun
import ai.vegaduta.ide.api.WorkflowSummary
import ai.vegaduta.ide.api.TERMINAL_RUN_STATUSES
import ai.vegaduta.ide.api.toSandboxLanguage
import ai.vegaduta.ide.auth.DeviceFlowLoginService
import ai.vegaduta.ide.auth.TokenStore
import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.BorderFactory
import javax.swing.JComponent
import javax.swing.JPanel

class JcefBridge(private val project: Project) : Disposable, ChatSurface {
    private val log = logger<JcefBridge>()

    private val browser: JBCefBrowser = JBCefBrowser()
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val statusLabel = JBLabel("On-device engine: off (JCEF has no WebGPU)").apply {
        border = BorderFactory.createEmptyBorder(4, 8, 4, 8)
    }
    val component: JComponent

    private val activeChats = ConcurrentHashMap<String, AtomicBoolean>()
    private val disposed = AtomicBoolean(false)

    @Volatile private var pageReady = false
    private val pendingPosts = Collections.synchronizedList(mutableListOf<JsonObject>())

    private val authListener = Runnable { onAuthChanged() }

    init {
        query.addHandler { raw ->
            try {
                onWebviewMessage(raw)
            } catch (e: Exception) {
                log.warn("webview message failed", e)
            }
            null
        }
        Disposer.register(this, browser)
        Disposer.register(this, query)
        service<TokenStore>().addAuthListener(authListener)

        component = JPanel(BorderLayout()).apply {
            add(browser.component, BorderLayout.CENTER)
            add(statusLabel, BorderLayout.SOUTH)
        }
        browser.loadHTML(buildHtml())
    }

    override fun dispose() {
        disposed.set(true)
        service<TokenStore>().removeAuthListener(authListener)
        for (flag in activeChats.values) {
            flag.set(true)
        }
        if (!project.isDisposed) {
            project.service<ChatSurfaceRegistry>().clear(this)
        }
    }

    // --- ChatSurface ---------------------------------------------------------

    override fun sendSelection(text: String, languageId: String?, fileName: String?) {
        post(buildJsonObject {
            put("type", "selection.context")
            put("text", text)
            if (languageId != null) put("languageId", languageId)
            if (fileName != null) put("fileName", fileName)
        })
    }

    // --- webview -> host -----------------------------------------------------

    private fun onWebviewMessage(raw: String) {
        val msg = runCatching { WireJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        when (msg.str("type")) {
            "ready" -> {
                synchronized(pendingPosts) { pageReady = true }
                flushPending()
                sendInit()
            }
            "auth.signIn" -> service<DeviceFlowLoginService>().signIn(project)
            "auth.signOut" -> service<TokenStore>().signOut() // listener posts auth.changed
            "chat.send" -> handleChatSend(msg)
            "chat.abort" -> msg.str("reqId")?.let { activeChats[it]?.set(true) }
            "workflow.run" -> handleWorkflowRun(msg)
            "engine.status" -> handleEngineStatus(msg)
            "ui.insert" -> insertIntoEditor(msg.str("text"))
            "ui.copy" -> msg.str("text")?.let {
                ApplicationManager.getApplication().invokeLater {
                    CopyPasteManager.getInstance().setContents(StringSelection(it))
                }
            }
            "ui.openExternal" -> msg.str("url")?.let { url ->
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    BrowserUtil.browse(url)
                }
            }
            "sdlc.run" -> handleSdlcRun(msg)
            // engine.result / download.* only matter for hosts that run a local
            // engine; JCEF has no WebGPU today, so the shared UI never sends them.
        }
    }

    private fun handleSdlcRun(msg: JsonObject) {
        val reqId = msg.str("reqId") ?: return
        val code = msg.str("code") ?: ""
        val languageId = msg.str("languageId")
        val language = toSandboxLanguage(languageId)
        if (language == null) {
            post(buildJsonObject {
                put("type", "sdlc.run.result")
                put("reqId", reqId)
                put("ok", false)
                put("reason", "unavailable")
                put(
                    "detail",
                    if (languageId != null)
                        "\"$languageId\" isn't runnable here - the sandbox supports python, node (JS/TS), and bash."
                    else
                        "Tag the code block with a language, e.g. ```python, so the sandbox knows what to run."
                )
            })
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val result = service<ApiClient>().runCode(code, language)
                post(buildJsonObject {
                    put("type", "sdlc.run.result")
                    put("reqId", reqId)
                    put("ok", true)
                    put("stdout", result.stdout)
                    put("stderr", result.stderr)
                    put("exitCode", result.exitCode)
                    put("timedOut", result.timedOut)
                })
            } catch (e: ApiException) {
                post(buildJsonObject {
                    put("type", "sdlc.run.result")
                    put("reqId", reqId)
                    put("ok", false)
                    put("reason", if (e.status == 403) "forbidden" else "unavailable")
                    put("detail", e.message ?: "Run failed.")
                })
            } catch (e: Exception) {
                post(buildJsonObject {
                    put("type", "sdlc.run.result")
                    put("reqId", reqId)
                    put("ok", false)
                    put("reason", "unknown")
                    put("detail", e.message ?: "Run failed.")
                })
            }
        }
    }

    private fun sendInit() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val tokens = service<TokenStore>()
            val signedIn = tokens.isSignedIn() || tokens.apiKey() != null
            val (agents, workflows) = fetchListsSafely(signedIn)
            post(buildJsonObject {
                put("type", "init")
                put("platform", "jetbrains")
                put("apiBase", VegadutaSettingsState.getInstance().apiBase())
                put("auth", authJson())
                put("agents", WireJson.encodeToJsonElement(ListSerializer(AgentSummary.serializer()), agents))
                put("workflows", WireJson.encodeToJsonElement(ListSerializer(WorkflowSummary.serializer()), workflows))
                // JCEF has no WebGPU; the shared UI feature-detects navigator.gpu
                // and auto-hides local mode, but don't even ask it to try.
                put("hostLocalEngine", false)
            })
        }
    }

    private fun onAuthChanged() {
        ApplicationManager.getApplication().executeOnPooledThread {
            post(buildJsonObject {
                put("type", "auth.changed")
                put("auth", authJson())
            })
            val tokens = service<TokenStore>()
            val (agents, workflows) = fetchListsSafely(tokens.isSignedIn() || tokens.apiKey() != null)
            post(buildJsonObject {
                put("type", "agents.changed")
                put("agents", WireJson.encodeToJsonElement(ListSerializer(AgentSummary.serializer()), agents))
                put("workflows", WireJson.encodeToJsonElement(ListSerializer(WorkflowSummary.serializer()), workflows))
            })
        }
    }

    private fun fetchListsSafely(signedIn: Boolean): Pair<List<AgentSummary>, List<WorkflowSummary>> {
        if (!signedIn) {
            return Pair(emptyList(), emptyList())
        }
        val api = service<ApiClient>()
        val agents = runCatching { api.listAgents() }.getOrElse {
            log.info("listAgents failed: ${it.message}")
            emptyList()
        }
        val workflows = runCatching { api.listWorkflows() }.getOrElse {
            log.info("listWorkflows failed: ${it.message}")
            emptyList()
        }
        return Pair(agents, workflows)
    }

    private fun authJson(): JsonObject {
        val tokens = service<TokenStore>()
        return buildJsonObject {
            put("signedIn", tokens.isSignedIn() || tokens.apiKey() != null)
            tokens.usernameOrNull()?.let { put("username", it) }
            tokens.authMode()?.let { put("mode", it) }
        }
    }

    private fun handleChatSend(msg: JsonObject) {
        val reqId = msg.str("reqId") ?: return
        val agentId = msg.str("agentId") ?: return
        val message = msg.str("message") ?: return
        val sessionId = msg.str("sessionId")
        val cancelled = AtomicBoolean(false)
        activeChats[reqId] = cancelled
        ApplicationManager.getApplication().executeOnPooledThread {
            var session: String? = sessionId
            try {
                service<ApiClient>().streamChat(
                    agentId, message, sessionId, cancelled,
                    onSessionId = { session = it },
                    onChunk = { delta ->
                        post(buildJsonObject {
                            put("type", "chat.chunk")
                            put("reqId", reqId)
                            put("delta", delta)
                        })
                    }
                )
                post(buildJsonObject {
                    put("type", "chat.done")
                    put("reqId", reqId)
                    session?.let { put("sessionId", it) }
                })
            } catch (e: Exception) {
                post(buildJsonObject {
                    put("type", "chat.error")
                    put("reqId", reqId)
                    put("message", e.message ?: "Chat failed.")
                })
            } finally {
                activeChats.remove(reqId)
            }
        }
    }

    private fun handleWorkflowRun(msg: JsonObject) {
        val reqId = msg.str("reqId") ?: return
        val workflowId = msg.str("workflowId") ?: return
        val input = msg.str("input") ?: ""
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val api = service<ApiClient>()
                var run = api.runWorkflow(workflowId, input)
                postWorkflowStatus(reqId, run)
                val deadline = System.currentTimeMillis() + 10 * 60_000
                while (run.status !in TERMINAL_RUN_STATUSES && System.currentTimeMillis() < deadline && !disposed.get()) {
                    Thread.sleep(2000)
                    run = api.getWorkflowRun(workflowId, run.id)
                    postWorkflowStatus(reqId, run)
                }
                if (disposed.get()) {
                    return@executeOnPooledThread
                }
                if (run.status !in TERMINAL_RUN_STATUSES) {
                    post(buildJsonObject {
                        put("type", "workflow.error")
                        put("reqId", reqId)
                        put("message", "Still running after 10 minutes - check the web console for the result.")
                    })
                }
            } catch (e: Exception) {
                post(buildJsonObject {
                    put("type", "workflow.error")
                    put("reqId", reqId)
                    put("message", e.message ?: "Workflow run failed.")
                })
            }
        }
    }

    private fun postWorkflowStatus(reqId: String, run: WorkflowRun) {
        post(buildJsonObject {
            put("type", "workflow.status")
            put("reqId", reqId)
            put("run", WireJson.encodeToJsonElement(WorkflowRun.serializer(), run))
        })
    }

    /** engine.status from the webview just updates this label - JCEF has no
     * WebGPU today, so the shared UI reports "unavailable" and hides local mode. */
    private fun handleEngineStatus(msg: JsonObject) {
        val status = msg["status"]?.jsonObject ?: return
        val state = status.str("state") ?: "unavailable"
        val detail = status.str("detail")
        ApplicationManager.getApplication().invokeLater {
            statusLabel.text = "On-device engine: $state" + (detail?.let { " ($it)" } ?: "")
        }
    }

    private fun insertIntoEditor(text: String?) {
        if (text.isNullOrEmpty()) return
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return@invokeLater
            WriteCommandAction.runWriteCommandAction(project) {
                editor.document.insertString(editor.caretModel.offset, text)
            }
        }
    }

    // --- host -> webview -----------------------------------------------------

    private fun post(message: JsonObject) {
        // The check-then-add here must be atomic with the "ready" handler's
        // flip-then-drain (synchronized on the same lock, pendingPosts) -
        // otherwise a post can read pageReady=false, then the ready handler
        // flips+drains (queue still empty) before this post's add() runs, and
        // the message is stranded in pendingPosts with nothing left to flush
        // it - silently dropped until some unrelated later post happens to
        // drain the backlog.
        val deliverNow = synchronized(pendingPosts) {
            if (!pageReady) {
                pendingPosts.add(message)
                false
            } else {
                true
            }
        }
        if (deliverNow) {
            deliver(message)
        }
    }

    private fun flushPending() {
        val drained = synchronized(pendingPosts) {
            val copy = pendingPosts.toList()
            pendingPosts.clear()
            copy
        }
        for (message in drained) {
            deliver(message)
        }
    }

    private fun deliver(message: JsonObject) {
        // browser is Disposer-registered to `this` and torn down on dispose();
        // long-lived background work (workflow polling in particular) can
        // still be mid-flight when that happens, so guard the use-after-dispose.
        if (disposed.get()) return
        // Double-encode: the payload JSON becomes a JS string literal argument.
        val literal = WireJson.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(message.toString()))
        val js = "window.__vegadutaDeliver && window.__vegadutaDeliver($literal);"
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    // --- page assembly -------------------------------------------------------

    private fun buildHtml(): String {
        val html = readResource("webview/index.html")
            ?: return "<html><body>VegaDuta webview bundle missing - rebuild with clients/shared `npm run build:webview`.</body></html>"

        // The cefQuery shim must be defined before the app bundle evaluates
        // (bridge.ts detects window.cefQuery at boot).
        val shim = "<script>window.cefQuery = function (args) { " +
            query.inject("args.request") +
            " };</script>"

        var out = html
        // Inline scripts. NOTE: assumes the bundle contains no literal "</script>"
        // (esbuild escapes it in string literals); acceptable for our own bundle.
        // Must preserve type="module" from the original tag: build-webview.mjs
        // builds chat.js with format:"esm", so it ends in a top-level `export`
        // statement - only legal inside a module-context script. Dropping the
        // module type here makes the browser fail to parse the inlined script
        // (SyntaxError), so bootChatApp() never runs and the tool window stays
        // blank - silently, since executeJavaScript swallows the parse error.
        out = Regex("""<script([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*</script>""").replace(out) { m ->
            val attrs = m.groupValues[1] + m.groupValues[3]
            val asset = readResource("webview/" + m.groupValues[2].trimStart('.', '/'))
            val openTag = if (Regex("""\btype=["']module["']""").containsMatchIn(attrs)) {
                "<script type=\"module\">"
            } else {
                "<script>"
            }
            if (asset != null) "$openTag\n$asset\n</script>" else ""
        }
        // Inline stylesheets.
        out = Regex("""<link\b[^>]*>""").replace(out) { m ->
            val tag = m.value
            if (!tag.contains("stylesheet")) return@replace tag
            val href = Regex("""\bhref=["']([^"']+)["']""").find(tag)?.groupValues?.get(1)
                ?: return@replace tag
            val asset = readResource("webview/" + href.trimStart('.', '/'))
            if (asset != null) "<style>\n$asset\n</style>" else ""
        }

        out = if (out.contains("<head>")) {
            out.replaceFirst("<head>", "<head>$shim")
        } else {
            shim + out
        }
        return out
    }

    private fun readResource(path: String): String? =
        javaClass.classLoader.getResourceAsStream(path)?.use {
            String(it.readAllBytes(), Charsets.UTF_8)
        }

    companion object {
        fun isWebviewBundleAvailable(): Boolean =
            JcefBridge::class.java.classLoader.getResource("webview/index.html") != null
    }
}

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
