// Fill-in-the-middle completions from the user's OWN local inference server:
// any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp server).
// Kotlin twin of clients/shared/src/edge/ollamaEngine.ts +
// clients/shared/src/edge/completions.ts - same /v1/models probe, same short
// system prompt, same "text after the insertion point" framing, same fence
// strip, and the same never-throw contract (failures come back as null, no
// exception ever reaches the completion contributor).
//
// Why a port instead of calling the bundled TypeScript engine: that engine
// only runs inside the chat webview (JCEF), so every completion would need
// the VegaDuta tool window open and a cefQuery round trip. IDE completions
// have to work with the tool window closed, so the local-HTTP backend is
// reimplemented here. The two are expected to stay in step - if the prompt or
// the fence strip changes in clients/shared/src/edge/completions.ts, change it
// here too.
//
// RULE 0 NOTE (the same exception ollamaEngine.ts documents): a 127.0.0.1 URL
// here is the USER'S OWN inference server on their own machine - not a
// browser-facing platform URL and not a token issuer - so the no-localhost
// rule does not apply to it. There is no default anyway: nothing is probed
// until the user types a URL in Settings | Tools | VegaDuta.

package ai.vegaduta.ide.completions

import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/** One completion ask: the window of code around the caret. */
data class LocalCompletionRequest(
    val prefix: String,
    val suffix: String,
    val languageId: String?,
    val deadlineMs: Long,
)

/**
 * What a /v1/models probe of the user's configured server last found.
 *
 * Kept host-side because the webview cannot answer it: when no backend probes
 * true, engineHost.ts's combinedStatus() reports WebLLM's `detail` and drops
 * the local-HTTP backend's own ("no local inference server" / "local server
 * has no models" / "local server answered NNN"). The tool window therefore
 * asks this engine, which talks to the same server the completions do.
 */
enum class LocalServerProbe {
    /** No local server URL set in Settings | Tools | VegaDuta. */
    NOT_CONFIGURED,

    /** Never asked, or the answer was dropped by [LocalCompletionEngine.invalidate]. */
    NOT_PROBED,

    /** Answered /v1/models and listed at least one model. */
    OK,

    /** Answered /v1/models and listed nothing. */
    NO_MODELS,

    /** Answered, but with a status outside 200..299. */
    REFUSED,

    /** Did not answer: connection refused, timed out, or a URL this HTTP
     * client cannot use (bad scheme, unparseable). */
    UNREACHABLE,
}

@Service(Service.Level.APP)
class LocalCompletionEngine {
    private val log = logger<LocalCompletionEngine>()

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(CONNECT_TIMEOUT_MS))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build()

    /** accessOrder=true + removeEldestEntry = the LRU(32) the VS Code provider
     * uses (clients/vscode/src/completions/provider.ts). Guarded by `cache`
     * itself: completions run on pooled threads. */
    private val cache = object : LinkedHashMap<String, String>(CACHE_SIZE, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
            size > CACHE_SIZE
    }

    // Probe memo. A server that ANSWERED is not re-listed on every invocation
    // (PROBE_CACHE_MS - the same 30s window as ollamaEngine.ts). A server that
    // did NOT answer is memoized as the failure it was, for its own much
    // shorter window (FAILED_PROBE_CACHE_MS), and completions are skipped
    // while it holds. Two windows on purpose: remembering a success for 30s
    // costs nothing, but remembering a failure that long would keep the
    // feature dark for 30s after the user starts their server - and caching
    // the failure as if it were a hit (what this used to do) would send every
    // completion in the window straight to /v1/chat/completions on a server
    // that had just refused, to wait out the whole generation deadline there.
    // These fields are @Volatile, not a single atomic tuple: concurrent
    // completions racing the same expiry can each start a probe, and one can
    // read the URL from a write whose outcome is not yet published. The cost
    // is a redundant probe, not a wrong answer, and the alternative is a lock
    // on the typing path.
    @Volatile private var probedBaseUrl: String? = null
    @Volatile private var probedModel: String? = null
    @Volatile private var probeOutcome = LocalServerProbe.NOT_PROBED
    @Volatile private var probedAt = 0L

    /**
     * Blocking - call from a pooled thread, never the EDT. Returns the
     * completion text, or null for every failure (no server, no model, HTTP
     * error, deadline, empty reply). Never throws.
     */
    fun complete(request: LocalCompletionRequest): String? {
        val settings = VegadutaSettingsState.getInstance()
        val baseUrl = settings.localServerBaseUrlOrNull() ?: return null
        if (request.prefix.isBlank()) return null
        return try {
            val model = resolveModel(baseUrl, settings.localServerModelOrNull()) ?: return null
            val key = cacheKey(baseUrl, model, request)
            synchronized(cache) { cache[key] }?.let { return it }
            val text = generate(baseUrl, model, request) ?: return null
            synchronized(cache) { cache[key] = text }
            text
        } catch (e: Exception) {
            // Belt-and-braces: the contributor must never see an exception from
            // here. Message only - the code around the caret is never logged.
            log.info("local completion failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    /** Forget the memoized probe and cached answers - called when the settings
     * change, so a newly started (or newly re-pointed) server is picked up
     * without restarting the IDE. */
    fun invalidate() {
        probedBaseUrl = null
        probedModel = null
        probeOutcome = LocalServerProbe.NOT_PROBED
        probedAt = 0L
        synchronized(cache) { cache.clear() }
    }

    /**
     * What the configured local server says about itself, probing it when the
     * memo above has expired. BLOCKING - call from a pooled thread, never the
     * EDT. Shares the memo with [complete], so asking does not add a round
     * trip to the completion path.
     */
    fun probeLocalServer(): LocalServerProbe {
        val settings = VegadutaSettingsState.getInstance()
        val baseUrl = settings.localServerBaseUrlOrNull() ?: return LocalServerProbe.NOT_CONFIGURED
        return try {
            resolveModel(baseUrl, settings.localServerModelOrNull())
            // Another thread may have re-pointed the memo at a different URL
            // between the call and this read; say "not probed" rather than
            // report someone else's server as this one's answer.
            if (probedBaseUrl == baseUrl) probeOutcome else LocalServerProbe.NOT_PROBED
        } catch (e: Exception) {
            // resolveModel catches its own HTTP and parse failures; this is
            // belt-and-braces, same contract as complete().
            log.info("local server probe failed: ${e.javaClass.simpleName}: ${e.message}")
            LocalServerProbe.UNREACHABLE
        }
    }

    /** The configured model if there is one, else the first model the server
     * lists - ollamaEngine.ts's pickModel(). A configured model is still
     * verified against a server that answered: the first call after the memo
     * expires pays the probe's own timeout here rather than the whole
     * generation budget, and a call inside a memoized FAILURE window returns
     * null without any HTTP at all. */
    private fun resolveModel(baseUrl: String, configured: String?): String? {
        val now = System.currentTimeMillis()
        val answered = probeOutcome == LocalServerProbe.OK || probeOutcome == LocalServerProbe.NO_MODELS
        val window = if (answered) PROBE_CACHE_MS else FAILED_PROBE_CACHE_MS
        if (probedBaseUrl == baseUrl &&
            probeOutcome != LocalServerProbe.NOT_PROBED &&
            now - probedAt < window
        ) {
            return if (answered) configured ?: probedModel else null
        }
        val response = try {
            http.send(
                HttpRequest.newBuilder(URI.create("$baseUrl/v1/models"))
                    .timeout(Duration.ofMillis(PROBE_TIMEOUT_MS))
                    .GET()
                    .build(),
                HttpResponse.BodyHandlers.ofString()
            )
        } catch (e: Exception) {
            log.info("no local inference server at $baseUrl (${e.javaClass.simpleName})")
            remember(baseUrl, now, LocalServerProbe.UNREACHABLE, null)
            return null
        }
        if (response.statusCode() !in 200..299) {
            log.info("local inference server at $baseUrl answered ${response.statusCode()}")
            remember(baseUrl, now, LocalServerProbe.REFUSED, null)
            return null
        }
        val models = try {
            Json.parseToJsonElement(response.body()).jsonObject["data"]?.jsonArray
                ?.mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull }
                ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
        val listed = models.firstOrNull()
        if (listed == null) {
            log.info("local inference server at $baseUrl lists no models")
        }
        remember(
            baseUrl,
            now,
            if (listed != null) LocalServerProbe.OK else LocalServerProbe.NO_MODELS,
            listed
        )
        return configured ?: listed
    }

    /** Publish one probe result. `probedAt` is written LAST because it is the
     * field the memo branch gates on: a reader that sees a fresh timestamp has
     * already seen the outcome that goes with it. */
    private fun remember(baseUrl: String, at: Long, outcome: LocalServerProbe, model: String?) {
        probedModel = model
        probeOutcome = outcome
        probedBaseUrl = baseUrl
        probedAt = at
    }

    /** One non-streaming /v1/chat/completions call. Non-streaming on purpose:
     * a lookup item has nowhere to render partial tokens, and the request
     * timeout is then the whole budget - completions.ts's soft deadline
     * expressed as an HTTP timeout. */
    private fun generate(baseUrl: String, model: String, request: LocalCompletionRequest): String? {
        val userContent = if (request.suffix.isNotBlank()) {
            "${request.prefix}\n\n[TEXT AFTER THE INSERTION POINT - your output must join up with it]\n${request.suffix}"
        } else {
            request.prefix
        }
        val body = buildJsonObject {
            put("model", model)
            put("stream", false)
            put("max_tokens", MAX_TOKENS)
            putJsonArray("messages") {
                addJsonObject {
                    put("role", "system")
                    put("content", systemPrompt(request.languageId))
                }
                addJsonObject {
                    put("role", "user")
                    put("content", userContent)
                }
            }
        }
        val response = try {
            http.send(
                HttpRequest.newBuilder(URI.create("$baseUrl/v1/chat/completions"))
                    .timeout(Duration.ofMillis(request.deadlineMs))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                    .build(),
                HttpResponse.BodyHandlers.ofString()
            )
        } catch (e: Exception) {
            // Includes the deadline (HttpTimeoutException) and the pooled
            // thread being interrupted when the user cancels the completion.
            log.info("local completion did not finish: ${e.javaClass.simpleName}")
            return null
        }
        if (response.statusCode() !in 200..299) {
            log.info("local inference server answered ${response.statusCode()} to a completion")
            return null
        }
        val content = try {
            Json.parseToJsonElement(response.body()).jsonObject["choices"]?.jsonArray
                ?.firstOrNull()?.jsonObject?.get("message")?.jsonObject
                ?.get("content")?.jsonPrimitive?.contentOrNull
        } catch (e: Exception) {
            null
        } ?: return null
        return stripFence(content).ifBlank { null }
    }

    /** NUL-joined so no other prefix/suffix split can alias this one - the
     * same "what produced it is part of the key" care the VS Code provider
     * takes (clients/vscode/src/completions/provider.ts). */
    private fun cacheKey(baseUrl: String, model: String, request: LocalCompletionRequest): String =
        listOf(baseUrl, model, request.languageId ?: "", request.prefix, request.suffix)
            .joinToString("\u0000")

    companion object {
        /** completions.ts DEFAULT_MAX_TOKENS - completions must stay short. */
        const val MAX_TOKENS = 128
        private const val CACHE_SIZE = 32
        private const val CONNECT_TIMEOUT_MS = 2_000L
        private const val PROBE_TIMEOUT_MS = 800L

        /** How long a server that ANSWERED /v1/models is taken at its word. */
        private const val PROBE_CACHE_MS = 30_000L

        /** How long a server that did NOT answer is remembered as down. Short,
         * because the user's next gesture is usually starting that server; long
         * enough that a burst of completions costs one probe, not one each. */
        private const val FAILED_PROBE_CACHE_MS = 3_000L

        /** SHORT on purpose, and word-for-word the prompt completions.ts
         * sends - a 1-3B model pays for every system token twice, in context
         * budget and in latency. */
        fun systemPrompt(languageId: String?): String {
            val language = if (languageId.isNullOrBlank()) "" else "$languageId "
            return "You are an inline ${language}code completion engine. " +
                "Given the code before the cursor (and possibly the code after it), output ONLY the code " +
                "that belongs at the cursor - it must join both sides seamlessly. " +
                "Output only code, no fences, no commentary. " +
                "Prefer short completions: finish the current statement or block, then stop."
        }

        /** Port of completions.ts stripFence(): local models reliably add a
         * ``` fence despite being told not to. */
        fun stripFence(text: String): String {
            var out = text.trim()
            if (out.startsWith("```")) {
                out = out.replaceFirst(Regex("^```[a-zA-Z0-9]*\\s*"), "")
                    .replaceFirst(Regex("```\\s*$"), "")
                    .trim()
            }
            return out
        }
    }
}
