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
//
// Private Mode (ai.vegaduta.ide.privacy): the flag lives in
// VegadutaSettingsState, so it survives a restart and is shared by every open
// project. While it is on this host refuses hosted chat, workflow runs, sandbox
// runs and knowledge search itself - before any request is built - and
// ApiClient refuses them again as a backstop. privacy.state always says
// enforced:true because both checks are on this side of the network.

package ai.vegaduta.ide.toolwindow

import ai.vegaduta.ide.api.AgentSummary
import ai.vegaduta.ide.api.ApiClient
import ai.vegaduta.ide.api.ApiException
import ai.vegaduta.ide.api.WireJson
import ai.vegaduta.ide.api.WorkflowRun
import ai.vegaduta.ide.api.WorkflowSummary
import ai.vegaduta.ide.api.knowledgeFailureReason
import ai.vegaduta.ide.api.toProtocolJson
import ai.vegaduta.ide.api.TERMINAL_RUN_STATUSES
import ai.vegaduta.ide.api.toSandboxLanguage
import ai.vegaduta.ide.auth.DeviceFlowLoginService
import ai.vegaduta.ide.auth.TokenStore
import ai.vegaduta.ide.completions.LocalCompletionEngine
import ai.vegaduta.ide.completions.LocalServerProbe
import ai.vegaduta.ide.context.ContextResult
import ai.vegaduta.ide.context.HostEditorOps
import ai.vegaduta.ide.context.IdeContextCollector
import ai.vegaduta.ide.context.JETBRAINS_CONTEXT_KINDS
import ai.vegaduta.ide.context.MissingContext
import ai.vegaduta.ide.privacy.HostedOperation
import ai.vegaduta.ide.privacy.PrivateModeBlockedException
import ai.vegaduta.ide.privacy.PrivateModePolicy
import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ToolWindowType
import com.intellij.ui.JBColor
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JPanel

/** The chat tool window's id, as registered in plugin.xml. */
private const val CHAT_TOOL_WINDOW_ID = "VegaDuta"

class JcefBridge(private val project: Project) : Disposable, ChatSurface {
    private val log = logger<JcefBridge>()

    private val browser: JBCefBrowser = JBCefBrowser()
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    // Initial text only - the webview replaces it through engine.status once
    // it has probed (handleEngineStatus). With no local server configured the
    // engine host is never started, so this first line is also the last one.
    private val statusLabel = JBLabel(
        if (VegadutaSettingsState.getInstance().localServerBaseUrlOrNull() != null) {
            "On-device engine: probing the local server..."
        } else {
            "On-device engine: off - set a local inference server URL in Settings | Tools | VegaDuta"
        }
    ).apply {
        border = BorderFactory.createEmptyBorder(4, 8, 4, 8)
    }
    // Shown only while Private Mode is on, above the engine line.
    private val privacyLabel = JBLabel(PrivateModePolicy.STATUS_ON).apply {
        border = BorderFactory.createEmptyBorder(4, 8, 0, 8)
        toolTipText = PrivateModePolicy.STATUS_ON_DETAIL
        isVisible = VegadutaSettingsState.getInstance().privateMode
    }
    val component: JComponent

    private val activeChats = ConcurrentHashMap<String, AtomicBoolean>()
    private val disposed = AtomicBoolean(false)

    @Volatile private var pageReady = false
    private val pendingPosts = Collections.synchronizedList(mutableListOf<JsonObject>())

    private val authListener = Runnable { onAuthChanged() }
    // Settings | Tools | VegaDuta, or another project's chat panel, flipped it.
    private val privacyListener = Runnable { onPrivacyChanged() }

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
        VegadutaSettingsState.getInstance().addPrivacyListener(privacyListener)

        val status = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(privacyLabel)
            add(statusLabel)
        }
        component = JPanel(BorderLayout()).apply {
            add(browser.component, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }
        browser.loadHTML(buildHtml())
    }

    override fun dispose() {
        disposed.set(true)
        service<TokenStore>().removeAuthListener(authListener)
        VegadutaSettingsState.getInstance().removePrivacyListener(privacyListener)
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

    override fun prefill(text: String, context: List<String>, send: Boolean) {
        // Queued by post() until the page is ready AND has received init (see
        // deliverInitThenPending), so the chat app knows this host's
        // capabilities before it acts on the prefill.
        post(buildJsonObject {
            put("type", "ui.prefill")
            put("text", text)
            if (context.isNotEmpty()) putJsonArray("context") { context.forEach { add(JsonPrimitive(it)) } }
            put("send", send)
        })
    }

    // --- webview -> host -----------------------------------------------------

    private fun onWebviewMessage(raw: String) {
        val msg = runCatching { WireJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        when (msg.str("type")) {
            // init goes out FIRST, then everything queued before the page
            // booted (e.g. a ui.prefill from the action that opened this
            // window) - see deliverInitThenPending().
            "ready" -> sendInit()
            "auth.signIn" -> service<DeviceFlowLoginService>().signIn(project)
            "auth.signOut" -> service<TokenStore>().signOut() // listener posts auth.changed
            "chat.send" -> handleChatSend(msg)
            "chat.abort" -> msg.str("reqId")?.let { activeChats[it]?.set(true) }
            "workflow.run" -> handleWorkflowRun(msg)
            "engine.status" -> handleEngineStatus(msg)
            "ui.insert" -> msg.str("text")?.let { HostEditorOps.insert(project, it) }
            "ui.newFile" -> msg.str("text")?.let { HostEditorOps.newFile(project, it, msg.str("languageId")) }
            "ui.setCommitMessage" -> msg.str("text")?.let { HostEditorOps.setCommitMessage(project, it) }
            "context.request" -> handleContextRequest(msg)
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
            "ui.reveal" -> handleReveal(msg)
            "ui.popOut" -> popOut()
            "knowledge.search" -> handleKnowledgeSearch(msg)
            "privacy.mode" -> msg["private"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()?.let { on ->
                // The setter notifies every privacy listener, this bridge's
                // included - onPrivacyChanged() replies with privacy.state.
                VegadutaSettingsState.getInstance().privateMode = on
            }
            // engine.result only ever answers a host-sent engine.request,
            // which this host never sends: IDE completions run natively
            // (ai.vegaduta.ide.completions), not through the webview.
            // download.* is handled inside the shared chat app against its own
            // engine host - and in JCEF its model panel reports "no WebGPU"
            // and offers the local-server path instead of a download, so no
            // download can start here in the first place.
        }
    }

    private fun handleSdlcRun(msg: JsonObject) {
        val reqId = msg.str("reqId") ?: return
        val code = msg.str("code") ?: ""
        val languageId = msg.str("languageId")
        privateModeBlock(HostedOperation.SANDBOX_RUN)?.let { reason ->
            post(buildJsonObject {
                put("type", "sdlc.run.result")
                put("reqId", reqId)
                put("ok", false)
                put("reason", "unavailable")
                put("detail", reason)
            })
            return
        }
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

    /** ui.popOut: the panel said it is cramped and the person asked for room -
     * turn the chat tool window into its own resizable window. */
    private fun popOut() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            ToolWindowManager.getInstance(project).getToolWindow(CHAT_TOOL_WINDOW_ID)
                ?.setType(ToolWindowType.WINDOWED, null)
        }
    }

    /** ui.reveal (Code Tour): 1-based inclusive lines; HostEditorOps.reveal
     * refuses paths outside the project and does the EDT work. */
    private fun handleReveal(msg: JsonObject) {
        val start = msg["startLine"]?.jsonPrimitive?.intOrNull ?: return
        val end = msg["endLine"]?.jsonPrimitive?.intOrNull ?: start
        HostEditorOps.reveal(project, msg.str("path"), start, end)
    }

    /** knowledge.search -> knowledge.result, with this host's token (the
     * webview never holds one). JWT only: an API-key user gets "signed-out"
     * from ApiClient without a request being made. */
    private fun handleKnowledgeSearch(msg: JsonObject) {
        val reqId = msg.str("reqId") ?: return
        val blocked = privateModeBlock(HostedOperation.KNOWLEDGE_SEARCH)
        val query = msg.str("query") ?: ""
        if (blocked != null || query.isBlank()) {
            postKnowledgeFailure(reqId, blocked ?: "Type something to search for.")
            return
        }
        val topK = msg["topK"]?.jsonPrimitive?.intOrNull
        val collectionIds = (msg["collectionIds"] as? JsonArray)
            ?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val hits = service<ApiClient>().searchKnowledge(query, topK, collectionIds)
                post(buildJsonObject {
                    put("type", "knowledge.result")
                    put("reqId", reqId)
                    put("ok", true)
                    putJsonArray("hits") { hits.forEach { add(it.toProtocolJson()) } }
                })
            } catch (e: PrivateModeBlockedException) {
                postKnowledgeFailure(reqId, e.message ?: "Private Mode is on.")
            } catch (e: ApiException) {
                log.info("knowledge.search failed: ${e.status} ${e.message}")
                postKnowledgeFailure(reqId, knowledgeFailureReason(e.status))
            } catch (e: Exception) {
                log.info("knowledge.search failed", e)
                postKnowledgeFailure(reqId, "unavailable")
            }
        }
    }

    private fun postKnowledgeFailure(reqId: String, reason: String) {
        post(buildJsonObject {
            put("type", "knowledge.result")
            put("reqId", reqId)
            put("ok", false)
            put("reason", reason)
        })
    }

    /** The Private Mode refusal for [operation], or null when it may run. */
    private fun privateModeBlock(operation: HostedOperation): String? =
        PrivateModePolicy.blockReason(VegadutaSettingsState.getInstance().privateMode, operation)

    private fun privacyStateJson(): JsonObject = buildJsonObject {
        put("type", "privacy.state")
        put("private", VegadutaSettingsState.getInstance().privateMode)
        put("enforced", true)
    }

    private fun onPrivacyChanged() {
        if (disposed.get()) return
        val on = VegadutaSettingsState.getInstance().privateMode
        ApplicationManager.getApplication().invokeLater {
            if (!disposed.get()) privacyLabel.isVisible = on
        }
        post(privacyStateJson())
    }

    /** context.request -> context.result. Pooled thread: the collector waits
     * on the EDT for editor state and may read VCS revisions, neither of which
     * may block the CEF query handler this is called from. */
    private fun handleContextRequest(msg: JsonObject) {
        val reqId = msg.str("reqId") ?: return
        val kinds = (msg["kinds"] as? JsonArray)
            ?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
            .orEmpty()
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = try {
                IdeContextCollector(project).collect(kinds)
            } catch (e: Exception) {
                log.warn("context.request failed", e)
                ContextResult(
                    emptyList(),
                    kinds.map { MissingContext(it, "The IDE could not collect this: ${e.message}") },
                )
            }
            post(buildJsonObject {
                put("type", "context.result")
                put("reqId", reqId)
                putJsonArray("items") { result.items.forEach { add(it.toJson()) } }
                if (result.missing.isNotEmpty()) {
                    putJsonArray("missing") { result.missing.forEach { add(it.toJson()) } }
                }
            })
        }
    }

    private fun sendInit() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val tokens = service<TokenStore>()
            val signedIn = tokens.isSignedIn() || tokens.apiKey() != null
            val (agents, workflows) = fetchListsSafely(signedIn)
            deliverInitThenPending(buildJsonObject {
                put("type", "init")
                put("platform", "jetbrains")
                // JCEF only knows the OS preference; the IDE theme is what the
                // person is looking at (Darcula on a light-mode OS is common).
                put("theme", if (JBColor.isBright()) "light" else "dark")
                put("apiBase", VegadutaSettingsState.getInstance().apiBase())
                put("auth", authJson())
                put("agents", WireJson.encodeToJsonElement(ListSerializer(AgentSummary.serializer()), agents))
                put("workflows", WireJson.encodeToJsonElement(ListSerializer(WorkflowSummary.serializer()), workflows))
                // True once the user has pointed the plugin at a local
                // inference server, and then for the local-HTTP backend ONLY
                // (edge/ollamaEngine.ts - plain fetch at an OpenAI-compatible
                // server, no WebGPU involved). WebLLM stays off: JCEF ships no
                // WebGPU, and rather than leaning on that detection failing,
                // the seed script in buildHtml() pins edge.modelOverride to
                // "hosted", which makes webllmEngine.probe() bail before it
                // can ever report a downloadable model. So the UI cannot offer
                // a backend this host is unable to run.
                //
                // What the flag buys today, precisely: the shared chat app
                // runs the engine only to answer host-sent engine.request
                // messages (webview/chat/main.ts), and this host sends none -
                // IDE completions run natively in ai.vegaduta.ide.completions,
                // with no webview round trip and with the tool window closed.
                // So here it buys an on-device status READOUT (and a working
                // path for any future host-side engine.request), not a second
                // inference surface. Keep the README's "Local inference"
                // section saying exactly that.
                //
                // The readout that is trustworthy is the native label below
                // the browser: handleEngineStatus re-derives the "off" reason
                // from the host's own probe. The engine chip drawn inside the
                // page is shared code and still prints the shared detail - see
                // the mismatch noted on handleEngineStatus.
                put(
                    "hostLocalEngine",
                    VegadutaSettingsState.getInstance().localServerBaseUrlOrNull() != null
                )
                // What this host really services (protocol.ts HostCapabilities).
                // commitMessage: HostEditorOps.setCommitMessage fills the box
                // captured by the commit-toolbar action, and otherwise copies
                // the message and says so - a typed outcome either way.
                putJsonObject("capabilities") {
                    putJsonArray("context") { JETBRAINS_CONTEXT_KINDS.forEach { add(JsonPrimitive(it)) } }
                    put("insert", true)
                    put("newFile", true)
                    put("runCode", true)
                    put("commitMessage", true)
                    // Wave 2. reveal: HostEditorOps.reveal. knowledge: serviced
                    // for a JWT sign-in; the chat app itself only offers it when
                    // auth.mode is "jwt" and Private Mode is off, and an API-key
                    // request is answered "signed-out". privateMode: this host
                    // blocks its own hosted paths (see the header).
                    put("reveal", true)
                    put("knowledge", true)
                    put("privateMode", true)
                    put("popOut", true)
                }
            })
            // Tell the page the persisted Private Mode right after init, so a
            // freshly opened window matches what this host will enforce.
            post(privacyStateJson())
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
        privateModeBlock(HostedOperation.CHAT)?.let { reason ->
            post(buildJsonObject {
                put("type", "chat.error")
                put("reqId", reqId)
                put("message", reason)
            })
            return
        }
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
        privateModeBlock(HostedOperation.WORKFLOW_RUN)?.let { reason ->
            post(buildJsonObject {
                put("type", "workflow.error")
                put("reqId", reqId)
                put("message", reason)
            })
            return
        }
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

    /** engine.status from the webview updates the label under the browser.
     * Live whenever a local server URL is configured (see sendInit).
     *
     * The shared status `detail` is logged, never shown. It is written for a
     * host where several backends compete: when nothing probes true,
     * engineHost.ts's combinedStatus() reports WebLLM's detail and drops the
     * local-HTTP backend's own, so the string that arrives here describes the
     * WebLLM pin this host seeds ("pinned to hosted", or "on-device turned
     * off" if the page has a stored opt-out) rather than the local server the
     * user actually configured. On the "off" path this label therefore ignores
     * the webview's word for it and asks the host's own prober - the same
     * /v1/models call, against the same server, that IDE completions use.
     *
     * The mismatch this comment used to describe is FIXED in clients/shared:
     * combinedStatus() now prefers the local-HTTP backend's detail when
     * WebLLM was ruled out by this host's own pin or by a missing WebGPU, so
     * the in-page chip says what the local server said rather than "pinned to
     * hosted". This label still re-probes, because the host's prober can say
     * more than the engine's cached probe result. */
    private fun handleEngineStatus(msg: JsonObject) {
        val status = msg["status"]?.jsonObject ?: return
        val state = status.str("state") ?: "unavailable"
        val detail = status.str("detail")
        val modelId = status.str("modelId")
        val baseUrl = VegadutaSettingsState.getInstance().localServerBaseUrlOrNull()
        log.info("webview engine status: " + state + (detail?.let { " ($it)" } ?: ""))
        val off = state != "ready" && state != "loading" && state != "idle"
        val text = when {
            state == "ready" -> "On-device engine: ready" + (modelId?.let { " ($it)" } ?: "")
            state == "loading" -> "On-device engine: loading..."
            state == "idle" -> "On-device engine: available"
            baseUrl == null ->
                "On-device engine: off - set a local inference server URL in Settings | Tools | VegaDuta"
            // Interim wording, for the moment before the host's own probe
            // answers. It claims only what is certain right here: a URL is
            // configured and nothing served a model through the webview.
            else -> "On-device engine: off - checking " + baseUrl + "..."
        }
        ApplicationManager.getApplication().invokeLater {
            statusLabel.text = text
        }
        // AFTER the line above is queued, so the probe's own update (also
        // queued on the EDT) lands second and wins.
        if (off && baseUrl != null) askLocalServerWhy(baseUrl)
    }

    /** Replace the "off" label with the reason the host can actually stand
     * behind, once the local server has been asked. Pooled thread: the probe
     * is a blocking HTTP call (capped by the engine's own probe timeout), and
     * repeated calls inside the engine's memo window cost no round trip.
     *
     * No new destination is reached by this: it is a GET at the URL the user
     * typed in Settings, which the page's own ollama backend already probes
     * (edgeSeedScript seeds it whenever that URL is set). */
    private fun askLocalServerWhy(baseUrl: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            if (disposed.get()) return@executeOnPooledThread
            val probe = service<LocalCompletionEngine>().probeLocalServer()
            val text = when (probe) {
                LocalServerProbe.OK ->
                    // Two facts that disagree (a server started between the
                    // page's probe and ours would do it). State both; do not
                    // invent which one is stale.
                    "On-device engine: " + baseUrl + " lists a model, but the chat panel reported none"
                LocalServerProbe.NO_MODELS ->
                    "On-device engine: off - " + baseUrl + " answered, but lists no models"
                LocalServerProbe.REFUSED ->
                    "On-device engine: off - " + baseUrl + " refused the request (see the IDE log)"
                LocalServerProbe.UNREACHABLE ->
                    "On-device engine: off - no local inference server answering at " + baseUrl
                LocalServerProbe.NOT_CONFIGURED ->
                    "On-device engine: off - set a local inference server URL in Settings | Tools | VegaDuta"
                LocalServerProbe.NOT_PROBED ->
                    "On-device engine: off - could not reach a verdict on " + baseUrl
            }
            ApplicationManager.getApplication().invokeLater {
                if (!disposed.get()) statusLabel.text = text
            }
        }
    }

    // --- host -> webview -----------------------------------------------------

    /** Flip to ready and send init ahead of anything queued while the page
     * booted, in one critical section so no concurrent post can overtake it.
     * A repeated "ready" (page reload) just delivers a fresh init. */
    private fun deliverInitThenPending(init: JsonObject) {
        synchronized(pendingPosts) {
            pageReady = true
            deliver(init)
            val drained = pendingPosts.toList()
            pendingPosts.clear()
            for (message in drained) deliver(message)
        }
    }

    private fun post(message: JsonObject) {
        // The check-then-add here must be atomic with the "ready" handler's
        // flip-then-drain (synchronized on the same lock, pendingPosts) -
        // otherwise a post can read pageReady=false, then the ready handler
        // flips+drains (queue still empty) before this post's add() runs, and
        // the message is stranded in pendingPosts with nothing left to flush
        // it - silently dropped until some unrelated later post happens to
        // drain the backlog.
        //
        // Delivery happens inside the same lock so messages reach the page in
        // post order; executeJavaScript only enqueues, so the lock is brief.
        synchronized(pendingPosts) {
            if (!pageReady) {
                pendingPosts.add(message)
            } else {
                deliver(message)
            }
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
            " };</script>" +
            edgeSeedScript()

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

    /** Seeds the shared edge layer's preference store (EdgeKv, localStorage-
     * backed - clients/shared/src/edge/host.ts) BEFORE the app bundle runs.
     * Two jobs:
     *  - carry plugin settings into the page, which has no other way to read
     *    them: chat/main.ts calls createEngineHost() with no config, so every
     *    value comes from kv - edge.apiBase (webview/engineHost.ts) and
     *    edge.ollamaBaseUrl / edge.ollamaModel (edge/ollamaEngine.ts);
     *  - keep WebLLM off deterministically. edge.modelOverride="hosted" makes
     *    webllmEngine.probe() return false before it detects capabilities or
     *    reports a downloadable model, and edge.backend="ollama" puts the
     *    local-HTTP backend first in tryBackends()' probe order.
     *
     * The page is loaded through loadHTML(), which can land on an origin where
     * localStorage throws; createDefaultKv() would then fall back to an empty
     * in-memory map and lose these values, so a memory-backed stand-in is
     * installed under the same name first. Every step is try/catch-ed: a page
     * that cannot store preferences must still boot. */
    private fun edgeSeedScript(): String {
        val settings = VegadutaSettingsState.getInstance()
        val seed = buildJsonObject {
            put("edge.apiBase", settings.apiBase())
            put("edge.backend", "ollama")
            put("edge.modelOverride", "hosted")
            settings.localServerBaseUrlOrNull()?.let { put("edge.ollamaBaseUrl", it) }
            settings.localServerModelOrNull()?.let { put("edge.ollamaModel", it) }
        }
        val js = """
            (function () {
              var seed = ${seed};
              var store = null;
              try {
                window.localStorage.setItem('vegaduta.probe', '1');
                window.localStorage.removeItem('vegaduta.probe');
                store = window.localStorage;
              } catch (storageError) {
                store = null;
              }
              if (!store) {
                var mem = {};
                store = {
                  getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
                  setItem: function (k, v) { mem[k] = String(v); },
                  removeItem: function (k) { delete mem[k]; },
                  clear: function () { mem = {}; },
                  key: function (i) { return Object.keys(mem)[i] || null; }
                };
                try {
                  Object.defineProperty(store, 'length', { get: function () { return Object.keys(mem).length; } });
                } catch (lengthError) {}
                try {
                  Object.defineProperty(window, 'localStorage', { value: store, configurable: true });
                } catch (defineError) {}
              }
              try {
                for (var k in seed) {
                  if (Object.prototype.hasOwnProperty.call(seed, k)) { store.setItem(k, seed[k]); }
                }
              } catch (seedError) {}
            })();
        """.trimIndent()
        return "<script>" + js + "</script>"
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
