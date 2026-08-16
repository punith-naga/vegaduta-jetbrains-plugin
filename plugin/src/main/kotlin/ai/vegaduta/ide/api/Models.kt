// Wire shapes for the platform endpoints the plugin calls. Field names match
// the Java DTOs (Jackson serializes UUID/Instant as strings) and mirror
// clients/shared/src/api/types.ts exactly - only fields the plugin consumes
// are declared, the server may send more (hence ignoreUnknownKeys).

package ai.vegaduta.ide.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

const val KEYCLOAK_REALM = "agentic-ai"
const val IDE_CLIENT_ID = "agentic-ai-ide"

/** Subset of core/agents/.../dto/AgentResponse.java. */
@Serializable
data class AgentSummary(
    val id: String,
    val name: String,
    val description: String? = null,
    val model: String? = null,
)

/** Subset of core/workflow WorkflowResponse. */
@Serializable
data class WorkflowSummary(
    val id: String,
    val name: String,
    val description: String? = null,
)

/** Matches core/workflow WorkflowRunResponse (same shape on JWT and dev/v1 surfaces). */
@Serializable
data class WorkflowRun(
    val id: String,
    val workflowId: String,
    val workflowName: String? = null,
    val status: String,
    val requestedBy: String? = null,
    val errorMessage: String? = null,
    val startedAt: String? = null,
    val completedAt: String? = null,
    val outputFileName: String? = null,
)

/** Terminal states checked by pollers; unknown values are treated as non-terminal. */
val TERMINAL_RUN_STATUSES: Set<String> = setOf("COMPLETED", "FAILED", "CANCELLED")

/** Lenient parser shared by API + webview-protocol code. */
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
}

class ApiException(val status: Int, message: String) : RuntimeException(message)
