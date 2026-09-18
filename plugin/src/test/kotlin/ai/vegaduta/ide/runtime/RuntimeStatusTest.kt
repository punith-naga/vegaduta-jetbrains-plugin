package ai.vegaduta.ide.runtime

import ai.vegaduta.ide.settings.VegadutaSettingsState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RuntimeStatusTest {

    private val models = CATALOG_MODELS.map {
        RuntimeModelInfo(it.id, it.displayName, it.sizeBytes, installed = it.recommended, recommended = it.recommended)
    }

    @Test
    fun `runtime status JSON uses protocol ts field names exactly`() {
        val json = RuntimeStatusSnapshot(
            RuntimeState.DOWNLOADING, "qwen2.5-coder-1.5b", 0.37,
            "Downloading the model - 412 MB of 1.1 GB", null, models,
        ).toMessageJson()
        assertEquals(setOf("type", "state", "modelId", "progress", "detail", "models"), json.keys)
        assertEquals("runtime.status", json["type"]!!.jsonPrimitive.content)
        assertEquals("downloading", json["state"]!!.jsonPrimitive.content)
        assertEquals(0.37, json["progress"]!!.jsonPrimitive.content.toDouble())
        val first = (json["models"] as JsonArray)[0] as JsonObject
        assertEquals(setOf("id", "displayName", "sizeBytes", "installed", "recommended"), first.keys)
        assertEquals("qwen2.5-coder-1.5b", first["id"]!!.jsonPrimitive.content)
        assertEquals("1117320768", first["sizeBytes"]!!.jsonPrimitive.content)
        assertEquals("true", first["installed"]!!.jsonPrimitive.content)
        assertEquals("true", first["recommended"]!!.jsonPrimitive.content)
    }

    @Test
    fun `optional fields are omitted, and every state has its protocol spelling`() {
        val json = RuntimeStatusSnapshot(RuntimeState.ABSENT).toMessageJson()
        assertEquals(setOf("type", "state", "models"), json.keys)
        assertEquals(
            listOf("absent", "downloading", "starting", "running", "stopped", "error"),
            RuntimeState.entries.map { it.wire },
        )
        val running = RuntimeStatusSnapshot(RuntimeState.RUNNING, "qwen2.5-coder-3b", baseUrl = "http://127.0.0.1:5000").toMessageJson()
        assertEquals("http://127.0.0.1:5000", running["baseUrl"]!!.jsonPrimitive.content)
        // progress is clamped to 0..1
        val over = RuntimeStatusSnapshot(RuntimeState.DOWNLOADING, progress = 1.4).toMessageJson()
        assertEquals(1.0, over["progress"]!!.jsonPrimitive.content.toDouble())
    }

    @Test
    fun `starting writes localServerBaseUrl and localServerModel`() {
        val s = VegadutaSettingsState()
        assertTrue(BundledRuntimeSettings.applyRunning(s, "http://127.0.0.1:51234", "qwen2.5-coder-1.5b", userAsked = false))
        assertEquals("http://127.0.0.1:51234", s.localServerBaseUrl)
        assertEquals("qwen2.5-coder-1.5b", s.localServerModel)
        assertEquals("qwen2.5-coder-1.5b", s.bundledRuntimeModel)
        assertEquals("http://127.0.0.1:51234", s.localServerBaseUrlOrNull())

        // Next IDE start: a new port replaces the runtime's own old address.
        assertTrue(BundledRuntimeSettings.applyRunning(s, "http://127.0.0.1:60001", "qwen2.5-coder-1.5b", userAsked = false))
        assertEquals("http://127.0.0.1:60001", s.localServerBaseUrl)
    }

    @Test
    fun `an automatic start never overwrites a server the user set, a click does`() {
        val s = VegadutaSettingsState()
        s.localServerBaseUrl = "http://127.0.0.1:11434"
        s.localServerModel = "llama3.1"
        assertFalse(BundledRuntimeSettings.applyRunning(s, "http://127.0.0.1:51234", "qwen2.5-coder-3b", userAsked = false))
        assertEquals("http://127.0.0.1:11434", s.localServerBaseUrl)
        assertEquals("llama3.1", s.localServerModel)

        assertTrue(BundledRuntimeSettings.applyRunning(s, "http://127.0.0.1:51234", "qwen2.5-coder-3b", userAsked = true))
        assertEquals("http://127.0.0.1:51234", s.localServerBaseUrl)
        assertEquals("qwen2.5-coder-3b", s.localServerModel)
    }

    @Test
    fun `stopping clears only the runtime's own address and forgets the model`() {
        val s = VegadutaSettingsState()
        BundledRuntimeSettings.applyRunning(s, "http://127.0.0.1:51234", "qwen2.5-coder-1.5b", userAsked = true)
        assertTrue(BundledRuntimeSettings.clearAfterStop(s))
        assertEquals("", s.localServerBaseUrl)
        assertEquals("", s.localServerModel)
        assertEquals("", s.bundledRuntimeModel)

        // The user re-pointed the plugin at their own server while it ran.
        BundledRuntimeSettings.applyRunning(s, "http://127.0.0.1:51234", "qwen2.5-coder-1.5b", userAsked = true)
        s.localServerBaseUrl = "http://127.0.0.1:1234"
        assertFalse(BundledRuntimeSettings.clearAfterStop(s))
        assertEquals("http://127.0.0.1:1234", s.localServerBaseUrl)
        assertEquals("", s.bundledRuntimeModel)
    }
}
