// Zero-config local inference: find the server the user is already running
// instead of asking them to type a URL they do not know. Mirrored by hand from
// clients/shared/src/agent/discovery.ts - the endpoint list, the ordering rule
// and the probe timeout are that file's values, and the two must be changed
// together.
//
// RULE 0 NOTE (same carve-out as OpenAiCompatibleModel.kt and
// clients/shared/src/edge/ollamaEngine.ts): every 127.0.0.1 below is the USER'S
// OWN inference server on their own machine, not a browser-facing platform URL
// or a token issuer. Nothing in this file may ever be used to default a
// platform URL - VegadutaSettingsState.apiBase()/authBase() stay as they are.
//
// Typed-failure contract, as everywhere in this package: nothing here throws. A
// failed probe is an absent result.

package ai.vegaduta.ide.agent

import ai.vegaduta.ide.api.WireJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean

/** discovery.ts's PROBE_TIMEOUT_MS. A closed port on loopback refuses at once,
 * so this only bounds the pathological case of something accepting the
 * connection and then stalling. */
private val DISCOVERY_PROBE_TIMEOUT: Duration = Duration.ofMillis(1_200)

data class LocalEndpoint(
    /** Product name, shown to the user as-is. */
    val label: String,
    /** Origin only, no path and no trailing slash. */
    val baseUrl: String,
    /** One line telling a user who has nothing running how to get this one
     * running. Shown when discovery finds nothing. */
    val hint: String,
)

/** Probed in this order, and the earliest one that answers wins. Ollama leads
 * because it is the most common install and the only one of the three that
 * serves without a GUI step. */
val LOCAL_ENDPOINTS: List<LocalEndpoint> = listOf(
    LocalEndpoint(
        label = "Ollama",
        baseUrl = "http://127.0.0.1:11434",
        hint = "Install Ollama from ollama.com, then run `ollama pull qwen2.5-coder` - it serves on 11434 by itself.",
    ),
    LocalEndpoint(
        label = "LM Studio",
        baseUrl = "http://127.0.0.1:1234",
        hint = "In LM Studio, load a model and switch on the local server under Developer - it listens on 1234.",
    ),
    LocalEndpoint(
        label = "llama.cpp",
        baseUrl = "http://127.0.0.1:8080",
        hint = "From a llama.cpp build, run `llama-server -m <model>.gguf --port 8080`.",
    ),
)

/**
 * Model names that have been seen to emit usable OpenAI-style tool calls.
 * discovery.ts's TOOL_CAPABLE_MODELS, without its per-model notes - this port
 * only ever prints the names in a hint, and never gates on them.
 *
 * A model id is not a contract: a fine-tune can keep a known name and lose the
 * tool-calling chat template, and plenty of capable models are not listed. So
 * this is a suggestion, never a claim, and nothing here may be used to refuse a
 * model the user chose. The real answer arrives as a `no-tool-support` failure.
 */
val TOOL_CAPABLE_MODEL_IDS: List<String> = listOf("qwen2.5-coder", "llama3.1", "mistral-nemo", "devstral")

data class DiscoveredEndpoint(
    val baseUrl: String,
    val label: String,
    /** Model ids the server reported, in its own order. Never empty - an
     * endpoint that answers with no models is not a usable discovery. */
    val models: List<String>,
)

/** The model ids a server lists, or an empty list for anything that is not a
 * reachable OpenAI-compatible endpoint. Never throws. */
private fun probeModels(endpoint: LocalEndpoint, transport: HttpTransport, cancelled: AtomicBoolean): List<String> {
    if (cancelled.get()) return emptyList()
    val reply = runCatching {
        transport.send(
            HttpCall(
                method = "GET",
                url = "${endpoint.baseUrl}/v1/models",
                headers = mapOf("Content-Type" to "application/json"),
                body = null,
                timeout = DISCOVERY_PROBE_TIMEOUT,
                cancelled = cancelled,
            )
        )
    }.getOrNull() ?: return emptyList()
    if (reply.status !in 200..299) return emptyList()

    val data = runCatching { (WireJson.parseToJsonElement(reply.body) as? JsonObject)?.get("data") as? JsonArray }
        .getOrNull()
        .orEmpty()
    return data.mapNotNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull }
        .filter { it.isNotBlank() }
}

/**
 * The first endpoint in LOCAL_ENDPOINTS order that answers with at least one
 * model, or null when none does. Never throws.
 *
 * Ordering is by list position, not by who replies fastest: a user with both
 * Ollama and LM Studio open must get the same answer every time, and a race
 * would hand them a different model depending on load.
 *
 * Differs from discovery.ts in one way: that probes all three concurrently
 * because a client calls it during startup. This one is only ever called from a
 * cancellable background task the user started, so three sequential probes of a
 * loopback port - refused immediately unless something is listening - are not
 * worth the extra threads.
 */
fun discoverLocalEndpoint(
    transport: HttpTransport = JavaHttpTransport(),
    cancelled: AtomicBoolean = AtomicBoolean(false),
): DiscoveredEndpoint? {
    for (endpoint in LOCAL_ENDPOINTS) {
        if (cancelled.get()) return null
        val models = probeModels(endpoint, transport, cancelled)
        if (models.isNotEmpty()) {
            return DiscoveredEndpoint(baseUrl = endpoint.baseUrl, label = endpoint.label, models = models)
        }
    }
    return null
}

/** The "nothing is running" help text, one line per product. */
fun localEndpointHints(): String = LOCAL_ENDPOINTS.joinToString("\n") { "- ${it.label}: ${it.hint}" }
