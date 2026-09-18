package ai.vegaduta.ide.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Case-for-case with clients/shared/test/sse.test.ts. These are the two bugs
 * that have actually shipped from this contract, so they are tested first.
 */
class SseEventReaderTest {

    private fun read(vararg lines: String): List<String> {
        val out = mutableListOf<String>()
        val reader = SseEventReader { out.add(it) }
        lines.forEach { reader.consumeLine(it) }
        reader.flush()
        return out
    }

    @Test
    fun `a multi-line event is rejoined into one chunk, newlines intact`() {
        // Exactly what Spring writes for "line one\nline two\n\nline four".
        val chunks = read(
            "data:line one",
            "data:line two",
            "data:",
            "data:line four",
            ""
        )
        assertEquals(listOf("line one\nline two\n\nline four"), chunks)
    }

    @Test
    fun `the whole answer as a single event survives - the buffered-depth case`() {
        val chunks = read("data:# Heading", "data:", "data:- point", "")
        assertEquals(1, chunks.size)
        assertEquals("# Heading\n\n- point", chunks[0])
    }

    @Test
    fun `a lone space chunk is preserved - exactly 5 chars are stripped`() {
        // "data: " is a single-space payload, not empty. Stripping 6 chars
        // deletes every word boundary and replies render with no spaces.
        assertEquals(listOf("Hello", " ", "world"), read("data:Hello", "", "data: ", "", "data:world", ""))
    }

    @Test
    fun `separate events stay separate chunks`() {
        assertEquals(listOf("one", "two"), read("data:one", "", "data:two", ""))
    }

    @Test
    fun `CRLF line endings still dispatch`() {
        assertEquals(listOf("hi"), read("data:hi\r", "\r"))
    }

    @Test
    fun `comments, other fields and keep-alives are ignored`() {
        assertEquals(
            listOf("payload"),
            read(": keep-alive", "event:message", "id:7", "retry:3000", "data:payload", "")
        )
    }

    @Test
    fun `a stream ending without a trailing blank line still emits`() {
        assertEquals(listOf("tail"), read("data:tail"))
    }

    @Test
    fun `an empty event emits nothing`() {
        assertTrue(read("", "", ":comment", "").isEmpty())
    }

    @Test
    fun `the error sentinel throws instead of being forwarded as text`() {
        val e = assertFailsWith<ApiException> {
            read("data:$STREAM_ERROR_MARKER provider exploded", "")
        }
        assertTrue(e.message!!.contains("provider exploded"))
    }

    @Test
    fun `an error sentinel split across data lines is still detected`() {
        // The marker leads the payload, so assembly must happen BEFORE the
        // check - a per-line check would forward the tail as visible text.
        val e = assertFailsWith<ApiException> {
            read("data:$STREAM_ERROR_MARKER first", "data:second", "")
        }
        assertTrue(e.message!!.contains("first\nsecond"))
    }

    @Test
    fun `a blank error detail falls back to the generic message`() {
        val e = assertFailsWith<ApiException> { read("data:$STREAM_ERROR_MARKER", "") }
        assertTrue(e.message!!.contains("interrupted"))
    }

    @Test
    fun `chunks before an error are delivered, not lost`() {
        val out = mutableListOf<String>()
        val reader = SseEventReader { out.add(it) }
        reader.consumeLine("data:partial answer")
        reader.consumeLine("")
        assertFailsWith<ApiException> {
            reader.consumeLine("data:$STREAM_ERROR_MARKER died")
            reader.consumeLine("")
        }
        assertEquals(listOf("partial answer"), out)
    }
}
