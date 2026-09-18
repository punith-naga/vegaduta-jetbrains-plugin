// One AgentModel implementation that covers both halves of the free story,
// because they speak the same wire protocol:
//
//   local, $0, no account   - Ollama / LM Studio / llama.cpp on 127.0.0.1
//   BYOK, $0 on free tiers  - Groq, Cerebras, OpenRouter, Together, OpenAI, ...
//
// Anything serving POST /v1/chat/completions with OpenAI-shaped `tools` works.
// That is the whole reason this adapter exists instead of one per provider.
//
// RULE 0 NOTE (same carve-out as clients/shared/src/edge/ollamaEngine.ts): the
// 127.0.0.1 default below is the USER'S OWN inference server on their own
// machine. It is not a browser-facing platform URL or a token issuer, so the
// no-localhost rule does not apply to it. There is deliberately no default for
// a hosted `baseUrl` - a BYOK caller must pass one. Platform URLs
// (VegadutaSettingsState.apiBase() etc.) still never default to localhost.
//
// HTTP style matches ApiClient: java.net.http, blocking, off the EDT.

package ai.vegaduta.ide.agent

import ai.vegaduta.ide.api.WireJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** Ollama's OpenAI-compatible endpoint. LM Studio defaults to :1234. */
const val DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434"

private val PROBE_TIMEOUT: Duration = Duration.ofMillis(1_500)
private val REQUEST_TIMEOUT: Duration = Duration.ofSeconds(180)

/** How often the transport re-checks the caller's cancel flag while a request
 * is in flight. java.net.http has no cancel on a blocking send(), so requests
 * go out async and are polled. */
private const val CANCEL_POLL_MS = 200L

// ---------------------------------------------------------------------------
// The HTTP seam
// ---------------------------------------------------------------------------

data class HttpCall(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
    val timeout: Duration,
    val cancelled: AtomicBoolean,
)

data class HttpReply(val status: Int, val body: String)

/** The seam the TypeScript port fills with an injected `fetchImpl`: it exists so
 * the adapter's request shaping and response handling are testable without a
 * server. Implementations throw only on transport failure - a non-2xx is a
 * perfectly ordinary HttpReply. */
fun interface HttpTransport {
    fun send(call: HttpCall): HttpReply
}

class JavaHttpTransport(
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build(),
) : HttpTransport {
    override fun send(call: HttpCall): HttpReply {
        val builder = HttpRequest.newBuilder(URI.create(call.url)).timeout(call.timeout)
        call.headers.forEach { (name, value) -> builder.header(name, value) }
        val publisher = call.body
            ?.let { HttpRequest.BodyPublishers.ofString(it) }
            ?: HttpRequest.BodyPublishers.noBody()
        builder.method(call.method, publisher)

        val future = http.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofString())
        while (true) {
            if (call.cancelled.get()) {
                future.cancel(true)
                throw CancellationException("cancelled by caller")
            }
            try {
                val response = future.get(CANCEL_POLL_MS, TimeUnit.MILLISECONDS)
                return HttpReply(response.statusCode(), response.body() ?: "")
            } catch (_: TimeoutException) {
                // Still in flight - loop and re-check the cancel flag.
            } catch (e: ExecutionException) {
                throw e.cause ?: e
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Argument repair
// ---------------------------------------------------------------------------

private val EMPTY_ARGS = JsonObject(emptyMap())

/**
 * Small models emit invalid JSON for tool arguments often enough that failing
 * the turn on it is the wrong default. Two repairs, both conservative: parse as
 * given, then parse the outermost brace span. Anything past that is guesswork,
 * so it is reported back to the model rather than silently reshaped.
 *
 * Returns null when it could not be repaired - callers must not invent args.
 */
fun parseToolArguments(raw: String?): JsonObject? {
    if (raw == null) return EMPTY_ARGS
    val text = raw.trim()
    if (text.isEmpty()) return EMPTY_ARGS

    asObject(text)?.let { return it }

    val start = text.indexOf('{')
    val end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
        asObject(text.substring(start, end + 1))?.let { return it }
    }
    return null
}

/** Parses to a JSON *object* or gives up. An array or a bare primitive is not a
 * usable argument bag, so it is treated exactly like a parse failure. */
private fun asObject(text: String): JsonObject? =
    runCatching { WireJson.parseToJsonElement(text) as? JsonObject }.getOrNull()

// ---------------------------------------------------------------------------
// Wire shaping
// ---------------------------------------------------------------------------

/** Our AgentMessage to the OpenAI chat wire shape. */
internal fun toWireMessages(messages: List<AgentMessage>): JsonArray = buildJsonArray {
    for (message in messages) {
        when (message) {
            is AgentMessage.Tool -> addJsonObject {
                put("role", "tool")
                put("tool_call_id", message.toolCallId)
                put("name", message.name)
                put("content", message.content)
            }

            is AgentMessage.Assistant -> addJsonObject {
                put("role", "assistant")
                if (message.toolCalls.isEmpty()) {
                    put("content", message.content)
                } else {
                    // Providers reject an empty string here where they accept
                    // null on a tool-calling turn.
                    put("content", if (message.content.isEmpty()) JsonNull else JsonPrimitive(message.content))
                    putJsonArray("tool_calls") {
                        for (call in message.toolCalls) {
                            addJsonObject {
                                put("id", call.id)
                                put("type", "function")
                                putJsonObject("function") {
                                    put("name", call.name)
                                    put("arguments", call.args.toString())
                                }
                            }
                        }
                    }
                }
            }

            is AgentMessage.System -> addJsonObject {
                put("role", "system")
                put("content", message.content)
            }

            is AgentMessage.User -> addJsonObject {
                put("role", "user")
                put("content", message.content)
            }
        }
    }
}

internal fun toWireTools(tools: List<ToolSpec>): JsonArray = buildJsonArray {
    for (tool in tools) {
        addJsonObject {
            put("type", "function")
            putJsonObject("function") {
                put("name", tool.name)
                put("description", tool.description)
                put("parameters", tool.parameters)
            }
        }
    }
}

/** Providers disagree on how they reject an unsupported `tools` payload, but all
 * of them say so in the body. Matching the body beats matching the status. */
fun looksLikeNoToolSupport(status: Int, body: String): Boolean {
    if (status != 400 && status != 404 && status != 422) return false
    val lower = body.lowercase()
    return lower.contains("tool") &&
        (
            lower.contains("not supported") ||
                lower.contains("does not support") ||
                lower.contains("unsupported") ||
                lower.contains("unknown parameter") ||
                lower.contains("unrecognized")
            )
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

data class OpenAiCompatibleOptions(
    /** Origin only, no path. Trailing slashes tolerated. */
    val baseUrl: String? = null,
    /** Omitted for a local server; required by every hosted provider. */
    val apiKey: String? = null,
    /** Model id on that server. When unset, probe() adopts the first one listed. */
    val model: String? = null,
    /** Sent as-is; providers that ignore it are unaffected. */
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    /** Injected by tests and by hosts that want their own HttpClient. */
    val transport: HttpTransport = JavaHttpTransport(),
)

class OpenAiCompatibleModel(private val options: OpenAiCompatibleOptions = OpenAiCompatibleOptions()) : AgentModel {

    private val base: String =
        (options.baseUrl?.trim().takeUnless { it.isNullOrEmpty() } ?: DEFAULT_LOCAL_BASE_URL).trimEnd('/')

    /** Mutated by probe() when the caller configured no model. Volatile because
     * probe and chat can legitimately run on different pooled threads. */
    @Volatile
    private var model: String = options.model?.trim().orEmpty()

    override val id: String
        get() = if (model.isNotEmpty()) "$base ($model)" else base

    private fun headers(): Map<String, String> = buildMap {
        put("Content-Type", "application/json")
        options.apiKey?.trim()?.takeIf { it.isNotEmpty() }?.let { put("Authorization", "Bearer $it") }
    }

    override fun probe(): Boolean {
        val reply = runCatching {
            options.transport.send(
                HttpCall("GET", "$base/v1/models", headers(), null, PROBE_TIMEOUT, AtomicBoolean(false))
            )
        }.getOrNull() ?: return false
        if (reply.status !in 200..299) return false

        val data = runCatching { (WireJson.parseToJsonElement(reply.body) as? JsonObject)?.get("data") as? JsonArray }
            .getOrNull()
            .orEmpty()
        val ids = data.mapNotNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull }
            .filter { it.isNotEmpty() }

        // An unset model adopts whatever the server actually has, so "I started
        // Ollama and pulled one model" needs no configuration at all.
        if (model.isEmpty() && ids.isNotEmpty()) model = ids.first()
        return ids.isNotEmpty() || model.isNotEmpty()
    }

    override fun chat(
        messages: List<AgentMessage>,
        tools: List<ToolSpec>,
        cancelled: AtomicBoolean,
    ): ModelResult {
        if (model.isEmpty() && !probe()) {
            return AgentFailure(AgentFailureReason.NO_MODEL, "nothing reachable at $base")
        }

        val payload = buildJsonObject {
            put("model", model)
            put("messages", toWireMessages(messages))
            if (tools.isNotEmpty()) {
                put("tools", toWireTools(tools))
                put("tool_choice", "auto")
            }
            options.temperature?.let { put("temperature", it) }
            options.maxTokens?.let { put("max_tokens", it) }
            put("stream", false)
        }.toString()

        val reply = try {
            options.transport.send(
                HttpCall("POST", "$base/v1/chat/completions", headers(), payload, REQUEST_TIMEOUT, cancelled)
            )
        } catch (e: Throwable) {
            if (cancelled.get() || e is CancellationException) return AgentFailure(AgentFailureReason.ABORTED)
            return AgentFailure(AgentFailureReason.MODEL_FAILED, e.message ?: e.toString())
        }

        if (reply.status !in 200..299) {
            val detail = "${reply.status}: ${reply.body.take(400)}"
            val reason = if (looksLikeNoToolSupport(reply.status, reply.body)) {
                AgentFailureReason.NO_TOOL_SUPPORT
            } else {
                AgentFailureReason.MODEL_FAILED
            }
            return AgentFailure(reason, detail)
        }

        val root = runCatching { WireJson.parseToJsonElement(reply.body) as? JsonObject }.getOrNull()
            ?: return AgentFailure(AgentFailureReason.MODEL_FAILED, "unparseable response body")
        val choice = (root["choices"] as? JsonArray)?.firstOrNull() as? JsonObject
            ?: return AgentFailure(AgentFailureReason.EMPTY_REPLY, "no choices in response")
        if ((choice["finish_reason"] as? JsonPrimitive)?.contentOrNull == "content_filter") {
            return AgentFailure(AgentFailureReason.MODEL_REFUSED)
        }

        val message = choice["message"] as? JsonObject
        val content = ((message?.get("content")) as? JsonPrimitive)?.contentOrNull.orEmpty()

        val calls = mutableListOf<ToolCall>()
        val wireCalls = (message?.get("tool_calls") as? JsonArray).orEmpty()
        for ((index, element) in wireCalls.withIndex()) {
            val wire = element as? JsonObject ?: continue
            val function = wire["function"] as? JsonObject
            val name = (function?.get("name") as? JsonPrimitive)?.contentOrNull
            if (name.isNullOrEmpty()) continue
            val args = parseToolArguments((function["arguments"] as? JsonPrimitive)?.contentOrNull)
            calls += ToolCall(
                id = (wire["id"] as? JsonPrimitive)?.contentOrNull ?: "call_$index",
                name = name,
                // A failed parse is NOT dropped: the loop must still answer this
                // tool_call_id or the next request is malformed. Empty args become
                // a readable error from the executor, which the model can correct.
                args = args ?: EMPTY_ARGS,
            )
        }

        if (content.isBlank() && calls.isEmpty()) return AgentFailure(AgentFailureReason.EMPTY_REPLY)
        return ModelReply(content = content, toolCalls = calls, modelId = model)
    }
}
