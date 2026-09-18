// The bundled runtime's state as the chat webview sees it (runtime.status in
// clients/shared/src/webview/protocol.ts - RuntimeStatus / RuntimeModel; the
// field names here must match that file exactly), and the one place that
// writes the runtime's address into the plugin's local-server settings.
//
// Pure: no IntelliJ API beyond the settings class itself, so it is unit-tested.

package ai.vegaduta.ide.runtime

import ai.vegaduta.ide.settings.VegadutaSettingsState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject

/** protocol.ts RuntimeStatus.state. */
enum class RuntimeState(val wire: String) {
    ABSENT("absent"),
    DOWNLOADING("downloading"),
    STARTING("starting"),
    RUNNING("running"),
    STOPPED("stopped"),
    ERROR("error"),
}

/** protocol.ts RuntimeModel. */
data class RuntimeModelInfo(
    val id: String,
    val displayName: String,
    val sizeBytes: Long,
    val installed: Boolean,
    val recommended: Boolean,
)

/** protocol.ts RuntimeStatus. */
data class RuntimeStatusSnapshot(
    val state: RuntimeState,
    val modelId: String? = null,
    val progress: Double? = null,
    val detail: String? = null,
    val baseUrl: String? = null,
    val models: List<RuntimeModelInfo> = emptyList(),
) {
    /** The runtime.status message, `type` included. Optional fields are
     * omitted rather than sent as null, as the TypeScript `?:` fields expect. */
    fun toMessageJson(): JsonObject = buildJsonObject {
        put("type", "runtime.status")
        put("state", state.wire)
        modelId?.let { put("modelId", it) }
        progress?.let { put("progress", it.coerceIn(0.0, 1.0)) }
        detail?.let { put("detail", it) }
        baseUrl?.let { put("baseUrl", it) }
        putJsonArray("models") {
            for (m in models) {
                addJsonObject {
                    put("id", m.id)
                    put("displayName", m.displayName)
                    put("sizeBytes", m.sizeBytes)
                    put("installed", m.installed)
                    put("recommended", m.recommended)
                }
            }
        }
    }
}

/** The loopback origin a runtime on [port] serves. RULE 0 carve-out: this is
 * the user's own process on their own machine, not a platform URL. */
fun runtimeBaseUrl(port: Int): String = "http://127.0.0.1:$port"

/**
 * Settings wiring. The bundled runtime writes the local-server settings only
 * when it STARTS, and remembers what it wrote in
 * [VegadutaSettingsState.bundledRuntimeBaseUrl] so that it never overwrites an
 * address the user typed themselves.
 */
object BundledRuntimeSettings {

    /**
     * Point the local-server settings at a runtime that just started.
     * [userAsked] = the person clicked Download & run (or picked a model in
     * the chat): always write. Otherwise (the automatic start when the IDE
     * opens) write only when the settings are blank or still hold the address
     * this runtime wrote last time - a user who has since pointed the plugin
     * at their own Ollama keeps it. Returns whether anything was written.
     */
    fun applyRunning(settings: VegadutaSettingsState, baseUrl: String, modelId: String, userAsked: Boolean): Boolean {
        val current = settings.localServerBaseUrlOrNull()
        val ours = current == null || current == settings.bundledRuntimeBaseUrl.trim().trimEnd('/').ifBlank { null }
        if (!userAsked && !ours) return false
        settings.localServerBaseUrl = baseUrl
        settings.localServerModel = modelId
        settings.bundledRuntimeBaseUrl = baseUrl
        settings.bundledRuntimeModel = modelId
        return true
    }

    /**
     * After the person stopped the runtime: blank the local-server settings
     * if they still point at it (so the chat and completions stop calling a
     * dead port), and forget the model so the next IDE start does not bring
     * it back. An address the user typed is left alone. Returns whether the
     * local-server settings changed.
     */
    fun clearAfterStop(settings: VegadutaSettingsState): Boolean {
        settings.bundledRuntimeModel = ""
        val ourUrl = settings.bundledRuntimeBaseUrl.trim().trimEnd('/').ifBlank { null } ?: return false
        settings.bundledRuntimeBaseUrl = ""
        if (settings.localServerBaseUrlOrNull() != ourUrl) return false
        settings.localServerBaseUrl = ""
        settings.localServerModel = ""
        return true
    }
}
