// Pure request/response shaping for POST /api/knowledge/search (core
// KnowledgeController.search: SearchRequest {query, topK?, collectionIds?} ->
// List<SearchResultResponse>). No platform API here, so it is plain-JUnit
// tested (KnowledgeWireTest).

package ai.vegaduta.ide.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** The server's default when topK is absent. */
const val KNOWLEDGE_DEFAULT_TOP_K = 5

/** Host-side ceiling: the answer is attached to a prompt, so a runaway topK
 * would only bloat it. */
const val KNOWLEDGE_MAX_TOP_K = 20

/** Queries longer than this are cut - a search query, not a document. */
const val KNOWLEDGE_MAX_QUERY_CHARS = 2_000

private val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

/** Builds the SearchRequest body, or null when the query is blank (the server
 * would 400 on @NotBlank). topK is clamped to 1..KNOWLEDGE_MAX_TOP_K;
 * collection ids that are not UUIDs are dropped (they would 400 the whole
 * request), and an empty list is omitted (= every collection). */
fun knowledgeSearchBody(query: String, topK: Int?, collectionIds: List<String>?): JsonObject? {
    val q = query.trim().take(KNOWLEDGE_MAX_QUERY_CHARS)
    if (q.isEmpty()) return null
    val ids = collectionIds.orEmpty().map { it.trim() }.filter { UUID_RE.matches(it) }.distinct()
    return buildJsonObject {
        put("query", q)
        put("topK", (topK ?: KNOWLEDGE_DEFAULT_TOP_K).coerceIn(1, KNOWLEDGE_MAX_TOP_K))
        if (ids.isNotEmpty()) putJsonArray("collectionIds") { ids.forEach { add(JsonPrimitive(it)) } }
    }
}

/** Maps the response array to KnowledgeHits. Rows without an id are skipped;
 * a body that is not an array throws (the caller reports "unavailable"). */
fun parseKnowledgeHits(body: String): List<KnowledgeHit> {
    val array = WireJson.parseToJsonElement(body) as? JsonArray
        ?: throw IllegalArgumentException("Knowledge search did not return a list.")
    return array.mapNotNull { element ->
        val obj = runCatching { element.jsonObject }.getOrNull() ?: return@mapNotNull null
        val id = obj.stringOrNull("id") ?: return@mapNotNull null
        KnowledgeHit(
            id = id,
            source = obj.stringOrNull("source"),
            content = obj.stringOrNull("content") ?: "",
            collectionId = obj.stringOrNull("collectionId"),
            documentId = obj.stringOrNull("documentId"),
            distance = (obj["distance"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.doubleOrNull,
        )
    }
}

/** protocol.ts KnowledgeHit JSON: every key present, null where unknown. */
fun KnowledgeHit.toProtocolJson(): JsonObject = buildJsonObject {
    put("id", id)
    put("source", source)
    put("content", content)
    put("collectionId", collectionId)
    put("documentId", documentId)
    put("distance", distance)
}

/** knowledge.result's `reason` for an HTTP failure status. */
fun knowledgeFailureReason(status: Int): String = when (status) {
    401 -> "signed-out"
    403 -> "forbidden"
    else -> "unavailable"
}

private fun JsonObject.stringOrNull(key: String): String? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    return p.contentOrNull
}
