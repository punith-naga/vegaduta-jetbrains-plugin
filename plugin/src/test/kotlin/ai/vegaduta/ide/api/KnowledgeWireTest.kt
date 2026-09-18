package ai.vegaduta.ide.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KnowledgeWireTest {

    private val uuid1 = "3f1c2b8e-9d4a-4c1e-8b7a-0a1b2c3d4e5f"
    private val uuid2 = "00000000-0000-0000-0000-000000000002"

    @Test
    fun `request body carries the trimmed query and default topK`() {
        val body = assertNotNull(knowledgeSearchBody("  how do we deploy?  ", null, null))
        assertEquals("how do we deploy?", body["query"]!!.jsonPrimitive.content)
        assertEquals(KNOWLEDGE_DEFAULT_TOP_K, body["topK"]!!.jsonPrimitive.content.toInt())
        assertFalse(body.containsKey("collectionIds"), "absent = every collection")
    }

    @Test
    fun `blank query gives no body`() {
        assertNull(knowledgeSearchBody("   ", 5, null))
        assertNull(knowledgeSearchBody("", null, listOf(uuid1)))
    }

    @Test
    fun `topK is clamped and a huge query is cut`() {
        assertEquals("1", knowledgeSearchBody("q", 0, null)!!["topK"]!!.jsonPrimitive.content)
        assertEquals("1", knowledgeSearchBody("q", -7, null)!!["topK"]!!.jsonPrimitive.content)
        assertEquals(KNOWLEDGE_MAX_TOP_K.toString(), knowledgeSearchBody("q", 500, null)!!["topK"]!!.jsonPrimitive.content)
        val long = knowledgeSearchBody("x".repeat(10_000), null, null)!!
        assertEquals(KNOWLEDGE_MAX_QUERY_CHARS, long["query"]!!.jsonPrimitive.content.length)
    }

    @Test
    fun `collection ids that are not UUIDs are dropped, duplicates removed`() {
        val body = knowledgeSearchBody("q", 3, listOf(uuid1, "not-a-uuid", " $uuid2 ", uuid1, "'; drop"))!!
        val ids = (body["collectionIds"] as JsonArray).map { it.jsonPrimitive.content }
        assertEquals(listOf(uuid1, uuid2), ids)
        assertFalse(knowledgeSearchBody("q", 3, listOf("nope"))!!.containsKey("collectionIds"))
    }

    @Test
    fun `maps core SearchResultResponse rows to KnowledgeHits`() {
        val body = """
            [
              {"id":"$uuid1","source":"runbook.md","chunkIndex":3,"content":"Deploy with the pipeline.",
               "collectionId":"$uuid2","distance":0.1234,"documentId":"$uuid2"},
              {"id":"$uuid2","source":null,"chunkIndex":0,"content":"x","collectionId":null,"distance":0.5,"documentId":null},
              {"source":"no id - skipped","content":"y"},
              "not an object"
            ]
        """.trimIndent()
        val hits = parseKnowledgeHits(body)
        assertEquals(2, hits.size)
        assertEquals(KnowledgeHit(uuid1, "runbook.md", "Deploy with the pipeline.", uuid2, uuid2, 0.1234), hits[0])
        assertEquals(KnowledgeHit(uuid2, null, "x", null, null, 0.5), hits[1])
    }

    @Test
    fun `an empty result is an empty list, a non-list body is an error`() {
        assertEquals(emptyList(), parseKnowledgeHits("[]"))
        assertFailsWith<IllegalArgumentException> { parseKnowledgeHits("""{"error":"boom"}""") }
    }

    @Test
    fun `protocol JSON has every KnowledgeHit key, null where unknown`() {
        val json = KnowledgeHit(uuid1, null, "c", null, null, null).toProtocolJson()
        assertEquals(setOf("id", "source", "content", "collectionId", "documentId", "distance"), json.keys)
        assertEquals(JsonNull, json["source"])
        assertEquals(JsonNull, json["distance"])
        assertEquals("c", json["content"]!!.jsonPrimitive.content)
        val withDistance = KnowledgeHit(uuid1, "s", "c", uuid2, uuid2, 0.25).toProtocolJson()
        assertEquals(0.25, withDistance["distance"]!!.jsonPrimitive.content.toDouble())
    }

    @Test
    fun `failure statuses map to the protocol reasons`() {
        assertEquals("signed-out", knowledgeFailureReason(401))
        assertEquals("forbidden", knowledgeFailureReason(403))
        assertEquals("unavailable", knowledgeFailureReason(500))
        assertEquals("unavailable", knowledgeFailureReason(0))
        assertTrue(knowledgeFailureReason(404) == "unavailable")
    }
}
