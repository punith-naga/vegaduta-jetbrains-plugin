// The agent seam, ported natively from clients/shared/src/agent/types.ts: one
// provider-agnostic contract for a multi-step, tool-calling coding agent.
//
// WHY A PORT AND NOT A REUSE. Every other client shares the TypeScript agent
// layer, but this plugin only ever consumes shared/'s *built webview bundle* -
// and the coding tools have to touch the IDE's VFS and spawn processes, neither
// of which a JCEF page can do. So the seam is re-stated here in Kotlin and the
// two copies must be kept in step by hand.
//
// Typed-failure contract, same convention as ApiClient's callers expect of the
// agent layer: nothing in this package throws to a caller. Every failure is an
// AgentFailure value carrying one of the reasons below.
//
// WHO EXECUTES WHAT. The model and the loop are host-agnostic. The *tools* are
// not - reading a file and running a command mean different things in an editor
// than in a browser tab - so the host supplies a ToolExecutor and nothing in
// this package touches a filesystem, a process or a platform API of its own.

package ai.vegaduta.ide.agent

import kotlinx.serialization.json.JsonObject
import java.util.concurrent.atomic.AtomicBoolean

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The `wire` values are the exact strings used by the TypeScript layer, so
 * logs and any future cross-client telemetry line up between the two ports. */
enum class AgentFailureReason(val wire: String) {
    /** Nothing configured/reachable to talk to. */
    NO_MODEL("no-model"),

    /** The provider call itself failed (network, 5xx, bad key). */
    MODEL_FAILED("model-failed"),

    /** Provider returned a content-policy refusal. */
    MODEL_REFUSED("model-refused"),

    /** The model/endpoint cannot do tool-calling at all. */
    NO_TOOL_SUPPORT("no-tool-support"),

    /** Hit maxSteps without finishing. */
    STEP_BUDGET_EXCEEDED("step-budget-exceeded"),

    /** Model returned neither text nor a tool call. */
    EMPTY_REPLY("empty-reply"),

    /** The caller's cancellation flag fired. */
    ABORTED("aborted"),
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One round trip's outcome. */
sealed interface ModelResult

/** A whole run's outcome. */
sealed interface AgentResult

/**
 * Deliberately implements BOTH result hierarchies. A model failure has to reach
 * the caller of a run unchanged - re-wrapping it is how a reason quietly turns
 * into "model-failed" and the UI stops being able to say anything useful.
 */
data class AgentFailure(
    val reason: AgentFailureReason,
    /** Original error text, for logs - never rendered raw in the UI. */
    val detail: String? = null,
) : ModelResult, AgentResult

data class ModelReply(
    /** Assistant prose. May be empty when the model only called tools. */
    val content: String,
    val toolCalls: List<ToolCall>,
    val modelId: String,
) : ModelResult

data class AgentRunSuccess(
    /** The assistant's final prose. */
    val answer: String,
    /** Full transcript including tool traffic - hosts persist this, not the caller. */
    val messages: List<AgentMessage>,
    val stepsUsed: Int,
) : AgentResult

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

data class ToolCall(
    /** Provider-assigned id; echoed back on the matching tool result. */
    val id: String,
    val name: String,
    /** Parsed arguments. Providers hand these over as a JSON *string* and small
     * models routinely emit invalid JSON - the model adapter is responsible for
     * repairing or rejecting, so the loop only ever sees an object. */
    val args: JsonObject,
)

sealed class AgentMessage {
    data class System(val content: String) : AgentMessage()

    data class User(val content: String) : AgentMessage()

    data class Assistant(
        val content: String,
        val toolCalls: List<ToolCall> = emptyList(),
    ) : AgentMessage()

    data class Tool(
        val toolCallId: String,
        val name: String,
        val content: String,
    ) : AgentMessage()
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

data class ToolSpec(
    val name: String,
    val description: String,
    /** JSON Schema object describing the tool's parameters. Passed through to
     * the provider, never interpreted here - every provider wants slightly
     * different dialect quirks. */
    val parameters: JsonObject,
    /** True when running this tool changes the user's machine (writes a file,
     * runs a command). Hosts gate these behind approval; read-only tools run
     * unattended. The loop does not enforce it - the executor does - but it
     * travels with the spec so a host cannot forget which is which. */
    val mutating: Boolean,
)

data class ToolOutcome(
    /** What the model is told. Errors are content, not exceptions: a failed
     * tool call the model can read and correct is worth far more than a dead
     * turn. */
    val content: String,
    /** True when the tool failed. Surfaced to the host for UI; the model still
     * receives `content` either way. */
    val failed: Boolean = false,
)

interface ToolExecutor {
    /** The tools this host actually implements, in the order they should be
     * offered to the model. */
    fun specs(): List<ToolSpec>

    /** Never throws: a thrown error inside a tool must come back as a failed
     * ToolOutcome so the loop can feed it to the model. */
    fun execute(call: ToolCall, cancelled: AtomicBoolean): ToolOutcome
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

interface AgentModel {
    /** Stable id for logs and the status bar, e.g. "http://127.0.0.1:11434 (qwen2.5-coder:7b)". */
    val id: String

    /** True when this model can be talked to right now. Never throws. */
    fun probe(): Boolean

    /** One round trip. Never throws - typed results only. Blocking, like
     * ApiClient: call it from a pooled thread / Task.Backgroundable, never EDT. */
    fun chat(
        messages: List<AgentMessage>,
        tools: List<ToolSpec>,
        cancelled: AtomicBoolean = AtomicBoolean(false),
    ): ModelResult
}

// ---------------------------------------------------------------------------
// Loop events
// ---------------------------------------------------------------------------

/** Emitted as the loop runs so a host can render progress. Every event is
 * advisory: dropping all of them changes nothing about the outcome. */
sealed class AgentEvent {
    data class Step(val index: Int, val of: Int) : AgentEvent()

    data class Assistant(val content: String) : AgentEvent()

    data class ToolStart(val call: ToolCall, val mutating: Boolean) : AgentEvent()

    data class ToolEnd(val call: ToolCall, val outcome: ToolOutcome) : AgentEvent()

    data class Done(val reason: DoneReason) : AgentEvent()
}

enum class DoneReason { FINISHED, NO_MORE_TOOL_CALLS }
