package ai.vegaduta.ide.auth

import kotlin.test.Test
import kotlin.test.assertEquals

class DevicePollBackoffTest {
    @Test
    fun `slow_down adds five seconds`() {
        assertEquals(10_000, DevicePollBackoff.afterSlowDown(5_000))
    }

    @Test
    fun `a 429 without Retry-After at least doubles`() {
        assertEquals(10_000, DevicePollBackoff.afterRateLimited(5_000, null))
        assertEquals(20_000, DevicePollBackoff.afterRateLimited(10_000, null))
    }

    @Test
    fun `a 429 honours a numeric Retry-After`() {
        assertEquals(30_000, DevicePollBackoff.afterRateLimited(5_000, "30"))
        assertEquals(30_000, DevicePollBackoff.afterRateLimited(5_000, " 30 "))
    }

    @Test
    fun `a non-numeric Retry-After (an HTTP date) falls back to doubling`() {
        assertEquals(10_000, DevicePollBackoff.afterRateLimited(5_000, "Fri, 18 Sep 2026 05:00:00 GMT"))
    }

    @Test
    fun `everything is capped at sixty seconds`() {
        assertEquals(60_000, DevicePollBackoff.afterRateLimited(5_000, "900"))
        assertEquals(60_000, DevicePollBackoff.afterRateLimited(50_000, null))
        assertEquals(60_000, DevicePollBackoff.afterSlowDown(58_000))
    }
}
