package ai.vegaduta.ide.privacy

import ai.vegaduta.ide.api.ApiException
import ai.vegaduta.ide.settings.VegadutaSettingsState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PrivateModeTest {

    @Test
    fun `with Private Mode off every hosted operation may run`() {
        for (op in HostedOperation.entries) {
            assertNull(PrivateModePolicy.blockReason(false, op), "$op should be allowed")
            PrivateModePolicy.check(false, op) // does not throw
        }
    }

    @Test
    fun `with Private Mode on every hosted operation is refused with a reason naming it`() {
        for (op in HostedOperation.entries) {
            val reason = assertNotNull(PrivateModePolicy.blockReason(true, op))
            assertTrue(reason.startsWith("Private Mode is on"), reason)
            assertTrue(reason.contains(op.label), reason)
            // The agreed wording: never "nothing touches the network".
            assertFalse(reason.contains("network", ignoreCase = true), reason)
        }
    }

    @Test
    fun `the gate throws a status-0 ApiException so existing catch blocks handle it`() {
        val e = assertFailsWith<PrivateModeBlockedException> {
            PrivateModePolicy.check(true, HostedOperation.CHAT)
        }
        assertEquals(0, e.status)
        assertEquals(HostedOperation.CHAT, e.operation)
        assertTrue((e as ApiException).message!!.contains("hosted chat"))
    }

    @Test
    fun `the gate covers every path the brief lists`() {
        val labels = HostedOperation.entries.map { it.name }.toSet()
        for (required in listOf("CHAT", "WORKFLOW_RUN", "SANDBOX_RUN", "KNOWLEDGE_SEARCH", "CODE_VALIDATION")) {
            assertTrue(required in labels, "missing $required")
        }
    }

    @Test
    fun `loopback detection accepts only literal local addresses`() {
        assertTrue(isLoopbackUrl("http://127.0.0.1:11434"))
        assertTrue(isLoopbackUrl("http://127.1.2.3:8080/v1"))
        assertTrue(isLoopbackUrl("http://localhost:1234"))
        assertTrue(isLoopbackUrl("HTTP://LOCALHOST"))
        assertTrue(isLoopbackUrl("http://[::1]:11434"))
        assertTrue(isLoopbackUrl(" https://127.0.0.1/ "))

        assertFalse(isLoopbackUrl("https://api.openai.com"))
        assertFalse(isLoopbackUrl("http://192.168.1.20:11434"))
        assertFalse(isLoopbackUrl("http://localhost.evil.example"))
        assertFalse(isLoopbackUrl("http://127.0.0.1.nip.io"))
        assertFalse(isLoopbackUrl("ftp://127.0.0.1"))
        assertFalse(isLoopbackUrl("127.0.0.1:11434"))
        assertFalse(isLoopbackUrl("not a url"))
        assertFalse(isLoopbackUrl(""))
    }

    @Test
    fun `the coding agent keeps local endpoints and discovery in Private Mode, refuses hosted ones`() {
        assertTrue(PrivateModePolicy.agentEndpointAllowed(true, null))
        assertTrue(PrivateModePolicy.agentEndpointAllowed(true, "http://127.0.0.1:11434"))
        assertFalse(PrivateModePolicy.agentEndpointAllowed(true, "https://api.openai.com"))
        assertTrue(PrivateModePolicy.agentEndpointAllowed(false, "https://api.openai.com"))
    }

    @Test
    fun `the flag is persisted in settings state and notifies listeners`() {
        val settings = VegadutaSettingsState()
        assertFalse(settings.privateMode, "off by default")
        var calls = 0
        val listener = Runnable { calls += 1 }
        settings.addPrivacyListener(listener)
        settings.privateMode = true
        assertTrue(settings.state.privateMode, "stored in the persisted State")
        assertEquals(1, calls)
        settings.removePrivacyListener(listener)
        settings.privateMode = false
        assertEquals(1, calls, "removed listener is not called")

        // A restored state (IDE restart) comes back on.
        val restored = VegadutaSettingsState()
        restored.loadState(VegadutaSettingsState.State().apply { privateMode = true })
        assertTrue(restored.privateMode)
    }

    @Test
    fun `a throwing listener does not stop the flag from being set`() {
        val settings = VegadutaSettingsState()
        settings.addPrivacyListener { error("boom") }
        settings.privateMode = true
        assertTrue(settings.privateMode)
    }
}
