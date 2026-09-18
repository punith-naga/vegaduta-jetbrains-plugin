// Kotlin port of clients/shared/src/api/sse.ts createSseEventReader. Keep the
// two in step - this file and that one implement the SAME wire contract, and
// the bugs below have each shipped once already.
//
//  - ONE BACKEND CHUNK IS ONE SSE EVENT, NOT ONE LINE. Spring frames a payload
//    containing newlines as SEVERAL `data:` lines (SseEmitter's
//    SseEventBuilderImpl#data replaces every LF with "LF data:"), terminated by
//    a blank line. Accumulate an event's data lines and rejoin them with LF.
//    Forwarding each line separately DELETES EVERY NEWLINE in the reply, which
//    is catastrophic on the buffered reasoning depths (PLANNED / CAREFUL /
//    RIGOROUS) where the whole answer is a single multi-line event. Fixed in
//    web/ and clients/shared by 81416d12; this Kotlin path was missed and
//    shipped the bug in 0.2.0.
//
//  - Strip EXACTLY the 5-char "data:" prefix - never a 6th char. A lone
//    word-boundary token arrives as "data: ", indistinguishable from "framing
//    space + empty content"; eating the 6th char silently drops every one of
//    those and replies render with no spaces between words.

package ai.vegaduta.ide.api

/**
 * Assembles `data:` lines into whole SSE events. Throws [ApiException] on the
 * error sentinel; forwards a completed event's payload to [onChunk]; ignores
 * every other field (`event:`, `id:`, `retry:`) and comments.
 */
class SseEventReader(private val onChunk: (String) -> Unit) {

    private val dataLines = mutableListOf<String>()

    fun consumeLine(rawLine: String) {
        // CR tolerance: the spec lets an event line end CR, LF or CRLF. Spring
        // writes bare LF, so this is defensive - but without it a CRLF stream
        // would never produce an empty line and no event would ever dispatch.
        val line = rawLine.removeSuffix("\r")
        if (line.isEmpty()) {
            dispatch()
            return
        }
        if (line.startsWith("data:")) {
            dataLines.add(line.substring(5))
        }
    }

    /** Emit whatever is buffered. Called at end of stream. */
    fun flush() = dispatch()

    private fun dispatch() {
        if (dataLines.isEmpty()) {
            return
        }
        val payload = dataLines.joinToString("\n")
        dataLines.clear()
        if (payload.startsWith(STREAM_ERROR_MARKER)) {
            val detail = payload.substring(STREAM_ERROR_MARKER.length)
            throw ApiException(0, detail.ifBlank { "The response was interrupted. Please try again." })
        }
        onChunk(payload)
    }
}
