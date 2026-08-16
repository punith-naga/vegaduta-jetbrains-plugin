// Blocking HTTP client for the platform API over java.net.http. Call only
// from background threads (pooled thread / Task.Backgroundable). Mirrors
// clients/shared/src/api/client.ts + sse.ts:
//  - Authorization bearer from TokenStore; on 401 refresh-once-and-retry;
//  - SSE chat via BodyHandlers.ofLines() with the EXACT-5-char "data:" strip;
//  - vmcp_ API-key mode transparently reroutes to the blocking /api/dev/v1
//    surface (devApi.ts twin) - streaming stays JWT-only by design.

package ai.vegaduta.ide.api

import ai.vegaduta.ide.auth.TokenStore
import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean
import java.util.stream.Collectors
import java.util.stream.Stream

/** Mirror of AgentController.STREAM_ERROR_MARKER (see clients/shared/src/api/sse.ts). */
const val STREAM_ERROR_MARKER = "@@AGENT_CHAT_STREAM_ERROR_9f2b1c@@"

/** Plain result holder (not @Serializable - built by hand in runCode() like
 * devChat()'s Pair, not decoded from a data class - matches this file's
 * existing convention for small ad-hoc response shapes). */
data class RunCodeResult(val stdout: String, val stderr: String, val exitCode: Int, val timedOut: Boolean)

/** Mirror of clients/shared/src/api/sdlc.ts's toSandboxLanguage(): maps a
 * common editor languageId to E2B's three supported runtimes. Returns null
 * for anything else - callers must not guess a fallback. */
fun toSandboxLanguage(languageId: String?): String? = when (languageId?.lowercase()) {
    "python" -> "python"
    "javascript", "typescript", "javascriptreact", "typescriptreact" -> "node"
    "shellscript", "bash", "sh" -> "bash"
    else -> null
}

@Service(Service.Level.APP)
class ApiClient {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    private fun apiBase(): String = VegadutaSettingsState.getInstance().apiBase().trimEnd('/')

    /** vmcp_ keys only authenticate the /api/dev/v1 surface; the path shapes
     * are otherwise identical, so API-key mode is a prefix swap. */
    private fun surfacePath(path: String): String {
        val tokens = service<TokenStore>()
        return if (!tokens.isSignedIn() && tokens.apiKey() != null) {
            path.replaceFirst("/api/", "/api/dev/v1/")
        } else {
            path
        }
    }

    private fun builder(path: String, token: String?): HttpRequest.Builder {
        val b = HttpRequest.newBuilder(URI.create(apiBase() + path))
            .timeout(Duration.ofSeconds(120))
        if (token != null) {
            b.header("Authorization", "Bearer $token")
        }
        return b
    }

    /** JSON request with the shared 401-refresh-once-retry rule. */
    private fun send(path: String, method: String = "GET", body: String? = null): HttpResponse<String> {
        val tokens = service<TokenStore>()

        fun attempt(token: String?): HttpResponse<String> {
            val b = builder(path, token)
            if (body != null) {
                b.header("Content-Type", "application/json")
                b.method(method, HttpRequest.BodyPublishers.ofString(body))
            } else {
                b.method(method, HttpRequest.BodyPublishers.noBody())
            }
            return http.send(b.build(), HttpResponse.BodyHandlers.ofString())
        }

        var response = attempt(tokens.bearerToken())
        if (response.statusCode() == 401) {
            val refreshed = tokens.refreshBlocking()
            if (refreshed != null) {
                response = attempt(refreshed)
            }
        }
        return response
    }

    private fun okBody(response: HttpResponse<String>): String {
        if (response.statusCode() !in 200..299) {
            throw ApiException(response.statusCode(), extractError(response.body(), response.statusCode()))
        }
        return response.body()
    }

    /** Surfaces core's GlobalExceptionHandler `{ error }` body verbatim. */
    private fun extractError(body: String?, status: Int): String {
        if (!body.isNullOrBlank()) {
            runCatching {
                val obj = WireJson.parseToJsonElement(body).jsonObject
                (obj["error"] ?: obj["message"])?.jsonPrimitive?.contentOrNull?.let { return it }
            }
        }
        return if (status == 401) "Not signed in. Sign in via Tools > VegaDuta." else "HTTP $status"
    }

    fun listAgents(): List<AgentSummary> =
        WireJson.decodeFromString(
            ListSerializer(AgentSummary.serializer()),
            okBody(send(surfacePath("/api/agents")))
        )

    fun listWorkflows(): List<WorkflowSummary> =
        WireJson.decodeFromString(
            ListSerializer(WorkflowSummary.serializer()),
            okBody(send(surfacePath("/api/workflows")))
        )

    fun runWorkflow(workflowId: String, input: String): WorkflowRun {
        val body = buildJsonObject { put("input", input) }.toString()
        return WireJson.decodeFromString(
            WorkflowRun.serializer(),
            okBody(send(surfacePath("/api/workflows/$workflowId/run"), "POST", body))
        )
    }

    fun getWorkflowRun(workflowId: String, runId: String): WorkflowRun =
        WireJson.decodeFromString(
            WorkflowRun.serializer(),
            okBody(send(surfacePath("/api/workflows/$workflowId/runs/$runId")))
        )

    /**
     * Streams POST /api/agents/{id}/chat. Framing is `data:<content>` with NO
     * separator space from Spring's writer: strip EXACTLY the 5-char "data:"
     * prefix (substring(5)) - never a 6th char. A lone word-boundary token
     * arrives as "data: "; eating a 6th char silently drops every one of those
     * and replies render with no spaces between words. That bug shipped once
     * in web/ - do not reintroduce it here.
     *
     * onSessionId receives the server-assigned X-Session-Id (or the passed-in
     * id) before the first chunk. A mid-stream provider failure arrives as one
     * final chunk prefixed with STREAM_ERROR_MARKER and is thrown as
     * ApiException, never forwarded as text. Setting `cancelled` stops the
     * read and closes the connection.
     */
    fun streamChat(
        agentId: String,
        message: String,
        sessionId: String?,
        cancelled: AtomicBoolean,
        onSessionId: (String?) -> Unit,
        onChunk: (String) -> Unit,
    ) {
        val tokens = service<TokenStore>()
        if (!tokens.isSignedIn() && tokens.apiKey() != null) {
            // dev/v1 has no streaming surface - deliver the blocking reply as one chunk.
            val result = devChat(agentId, message, sessionId)
            onSessionId(result.second ?: sessionId)
            if (!cancelled.get()) {
                onChunk(result.first)
            }
            return
        }

        val payload = buildJsonObject {
            if (!sessionId.isNullOrBlank()) put("sessionId", sessionId)
            put("message", message)
        }.toString()

        fun attempt(token: String?): HttpResponse<Stream<String>> {
            val request = builder("/api/agents/$agentId/chat", token)
                .header("Content-Type", "application/json")
                .timeout(Duration.ofMinutes(10))
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build()
            return http.send(request, HttpResponse.BodyHandlers.ofLines())
        }

        var response = attempt(tokens.bearerToken())
        if (response.statusCode() == 401) {
            val refreshed = tokens.refreshBlocking()
            if (refreshed != null) {
                response.body().close()
                response = attempt(refreshed)
            }
        }
        if (response.statusCode() !in 200..299) {
            val body = response.body().use { it.collect(Collectors.joining("\n")) }
            throw ApiException(response.statusCode(), extractError(body, response.statusCode()))
        }

        onSessionId(response.headers().firstValue("X-Session-Id").orElse(sessionId))

        response.body().use { lines ->
            val iterator = lines.iterator()
            // `cancelled` is only checked BETWEEN reads below, but iterator.next()
            // blocks on the socket - if the server goes quiet mid-turn (e.g.
            // during a tool call), setting `cancelled` alone does nothing until
            // the next line/keep-alive arrives. Bridge it to actually closing
            // the stream so a blocked read unblocks promptly instead of only on
            // the next chunk or the 10-minute request timeout.
            val watcher = Thread {
                try {
                    while (!cancelled.get()) {
                        Thread.sleep(200)
                    }
                    runCatching { lines.close() }
                } catch (_: InterruptedException) {
                    // Loop finished normally - nothing to close.
                }
            }.apply { isDaemon = true; start() }
            try {
                while (iterator.hasNext()) {
                    if (cancelled.get()) {
                        return
                    }
                    val line = iterator.next()
                    if (!line.startsWith("data:")) {
                        continue // comments / blank keep-alives
                    }
                    val delta = line.substring(5)
                    if (delta.startsWith(STREAM_ERROR_MARKER)) {
                        val detail = delta.substring(STREAM_ERROR_MARKER.length)
                        throw ApiException(0, detail.ifBlank { "The response was interrupted. Please try again." })
                    }
                    onChunk(delta)
                }
            } catch (e: Exception) {
                // A cancellation-triggered lines.close() surfaces here as some
                // flavor of IOException from the blocked read - treat it as the
                // clean "user pressed Stop" path, not a chat error.
                if (cancelled.get()) return
                throw e
            } finally {
                watcher.interrupt()
            }
        }
    }

    /**
     * POST /api/sdlc/sandbox/run-code - stateless, disposable-sandbox
     * execution. Gated server-side to ROLE_tenant-admin/ROLE_agent-builder
     * (SecurityConfig, "IDE/browser plugin SDLC alignment 2026-08-09").
     * JWT surface only - dev/v1 has no /api/sdlc routes, so an apiKey-only
     * user gets a clear ApiException instead of a confusing 404.
     */
    fun runCode(code: String, language: String, timeoutSeconds: Int? = null): RunCodeResult {
        val tokens = service<TokenStore>()
        if (!tokens.isSignedIn()) {
            throw ApiException(0, "Running code in a sandbox needs a full sign-in (not an API key) - Tools > VegaDuta > Sign In.")
        }
        val body = buildJsonObject {
            put("code", code)
            put("language", language)
            timeoutSeconds?.let { put("timeoutSeconds", it) }
        }.toString()
        val obj = WireJson.parseToJsonElement(okBody(send("/api/sdlc/sandbox/run-code", "POST", body))).jsonObject
        return RunCodeResult(
            stdout = obj["stdout"]?.jsonPrimitive?.contentOrNull ?: "",
            stderr = obj["stderr"]?.jsonPrimitive?.contentOrNull ?: "",
            exitCode = obj["exitCode"]?.jsonPrimitive?.int ?: -1,
            timedOut = obj["timedOut"]?.jsonPrimitive?.boolean ?: false,
        )
    }

    /** Blocking POST /api/dev/v1/agents/{id}/chat -> (reply, sessionId). */
    private fun devChat(agentId: String, message: String, sessionId: String?): Pair<String, String?> {
        val body = buildJsonObject {
            put("message", message)
            if (!sessionId.isNullOrBlank()) put("sessionId", sessionId)
        }.toString()
        val json = okBody(send("/api/dev/v1/agents/$agentId/chat", "POST", body))
        val obj = WireJson.parseToJsonElement(json).jsonObject
        return Pair(
            obj["reply"]?.jsonPrimitive?.contentOrNull ?: "",
            obj["sessionId"]?.jsonPrimitive?.contentOrNull
        )
    }
}
