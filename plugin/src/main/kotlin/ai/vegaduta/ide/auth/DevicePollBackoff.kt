package ai.vegaduta.ide.auth

/**
 * How long to wait between device-flow token polls once the server wants us
 * slower. Mirrors clients/shared/src/auth/deviceFlow.ts - keep the two in step.
 *
 * Why it exists (2026-09-18): auth.vegaduta.ai sits behind Cloudflare, whose
 * rate limiting answered a sign-in's repeated polls with HTTP 429 and, when
 * they kept coming, banned the IP outright (error 1015) - including the
 * browser page the person was approving the code on. This plugin used to
 * treat a 429 as a failed sign-in. RFC 8628's slow_down already defines the
 * right reaction to "poll slower"; a 429 from the edge gets the same one.
 */
object DevicePollBackoff {
    const val MAX_INTERVAL_MS = 60_000L

    /** RFC 8628 §3.5: add 5 seconds, capped. */
    fun afterSlowDown(currentMs: Long): Long = minOf(MAX_INTERVAL_MS, currentMs + 5_000)

    /** HTTP 429: honour a numeric Retry-After (seconds); otherwise the larger
     * of +5s and doubling. Capped either way. */
    fun afterRateLimited(currentMs: Long, retryAfterHeader: String?): Long {
        val retryAfterSec = retryAfterHeader?.trim()?.toLongOrNull()
        val next = if (retryAfterSec != null && retryAfterSec > 0) {
            retryAfterSec * 1_000
        } else {
            maxOf(currentMs + 5_000, currentMs * 2)
        }
        return minOf(MAX_INTERVAL_MS, next)
    }
}
