// Discovery's one real rule: the answer is by LIST POSITION, not by who replies
// first. A user with both Ollama and LM Studio running must get the same
// endpoint on every launch - a race would hand them a different model depending
// on load, and the agent would silently change behaviour between runs.
//
// Plain JUnit/kotlin.test through the HttpTransport seam: no sockets, no IDE.

package ai.vegaduta.ide.agent

import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Answers per base URL; anything not listed behaves like a closed port. */
private class FakeServers(private val bodies: Map<String, String>) : HttpTransport {
    val urls = mutableListOf<String>()

    override fun send(call: HttpCall): HttpReply {
        urls += call.url
        val body = bodies.entries.firstOrNull { call.url.startsWith(it.key) }?.value
            ?: throw IOException("connection refused")
        return HttpReply(200, body)
    }
}

private fun modelList(vararg ids: String): String =
    """{"data":[${ids.joinToString(",") { """{"id":"$it"}""" }}]}"""

class LocalEndpointsTest {

    @Test
    fun `mirrors the three endpoints discovery ts probes`() {
        assertEquals(
            listOf("http://127.0.0.1:11434", "http://127.0.0.1:1234", "http://127.0.0.1:8080"),
            LOCAL_ENDPOINTS.map { it.baseUrl },
        )
        assertEquals(listOf("Ollama", "LM Studio", "llama.cpp"), LOCAL_ENDPOINTS.map { it.label })
        assertTrue(LOCAL_ENDPOINTS.all { it.hint.isNotBlank() })
    }

    @Test
    fun `returns the first endpoint in list order, not the first to answer`() {
        val transport = FakeServers(
            mapOf(
                "http://127.0.0.1:1234" to modelList("lmstudio-model"),
                "http://127.0.0.1:11434" to modelList("qwen2.5-coder:7b", "llama3.1:8b"),
            )
        )

        val found = discoverLocalEndpoint(transport)

        assertEquals("http://127.0.0.1:11434", found?.baseUrl)
        assertEquals("Ollama", found?.label)
        assertEquals(listOf("qwen2.5-coder:7b", "llama3.1:8b"), found?.models)
    }

    @Test
    fun `skips a server that answers with no models`() {
        val transport = FakeServers(
            mapOf(
                "http://127.0.0.1:11434" to """{"data":[]}""",
                "http://127.0.0.1:8080" to modelList("some.gguf"),
            )
        )

        assertEquals("http://127.0.0.1:8080", discoverLocalEndpoint(transport)?.baseUrl)
    }

    @Test
    fun `nothing listening is null, not an exception`() {
        assertNull(discoverLocalEndpoint(FakeServers(emptyMap())))
    }

    @Test
    fun `an already-cancelled run probes nothing`() {
        val transport = FakeServers(mapOf("http://127.0.0.1:11434" to modelList("qwen2.5-coder:7b")))

        assertNull(discoverLocalEndpoint(transport, AtomicBoolean(true)))
        assertTrue(transport.urls.isEmpty())
    }

    @Test
    fun `hints name every product a user might need to start`() {
        val hints = localEndpointHints()
        assertTrue(LOCAL_ENDPOINTS.all { hints.contains(it.label) })
    }
}
