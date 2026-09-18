// The agent loop: model -> tool calls -> tool results -> model, until the model
// stops asking for tools or the step budget runs out.
//
// Why a budget at all. The platform's server-side loop caps tool calls per turn
// at 15 (`app.guardrails.max-tool-calls-per-turn`), which is right for a chat
// agent and far too low for a coding one - reading five files and running the
// tests spends it. This loop's default is deliberately higher AND bounded: an
// unbounded local loop with write and shell tools is how an agent quietly
// rewrites a repo at 3am. The ceiling is a safety property, not a tuning knob.
//
// Blocking, like the rest of this plugin's network code: run it on a pooled
// thread or a Task.Backgroundable, never on the EDT.

package ai.vegaduta.ide.agent

import java.util.concurrent.atomic.AtomicBoolean

/** High enough to read, edit, run tests and iterate a few times; low enough
 * that a looping model stops before it costs real money or real damage. */
const val DEFAULT_MAX_STEPS = 60

/** Repeating the same call with the same arguments this many times in a row
 * means the model is stuck, not working. Cheaper to stop and say so than to
 * spend the whole budget proving it. */
private const val REPEAT_LIMIT = 3

private fun fingerprint(call: ToolCall): String = "${call.name}:${call.args}"

fun runAgentLoop(
    model: AgentModel,
    executor: ToolExecutor,
    /** Seed transcript: a system message and the user's task. */
    messages: List<AgentMessage>,
    maxSteps: Int = DEFAULT_MAX_STEPS,
    cancelled: AtomicBoolean = AtomicBoolean(false),
    onEvent: (AgentEvent) -> Unit = {},
): AgentResult {
    val budget = maxOf(1, maxSteps)
    val transcript = messages.toMutableList()
    val specs = executor.specs()
    val byName = specs.associateBy { it.name }

    var lastFingerprint = ""
    var repeats = 0

    fun emit(event: AgentEvent) {
        try {
            onEvent(event)
        } catch (_: Throwable) {
            // A listener must never be able to kill a run.
        }
    }

    for (step in 0 until budget) {
        if (cancelled.get()) return AgentFailure(AgentFailureReason.ABORTED)
        emit(AgentEvent.Step(index = step + 1, of = budget))

        when (val reply = model.chat(transcript, specs, cancelled)) {
            is AgentFailure -> return reply

            is ModelReply -> {
                transcript += AgentMessage.Assistant(reply.content, reply.toolCalls)
                if (reply.content.isNotBlank()) emit(AgentEvent.Assistant(reply.content))

                // No tool calls means the model considers itself done. That is the
                // normal exit: there is no separate "finish" tool to forget to call.
                if (reply.toolCalls.isEmpty()) {
                    emit(AgentEvent.Done(DoneReason.NO_MORE_TOOL_CALLS))
                    return AgentRunSuccess(
                        answer = reply.content,
                        messages = transcript.toList(),
                        stepsUsed = step + 1,
                    )
                }

                for (call in reply.toolCalls) {
                    if (cancelled.get()) return AgentFailure(AgentFailureReason.ABORTED)

                    val spec = byName[call.name]
                    if (spec == null) {
                        // Hallucinated tool name. Tell the model what it may actually
                        // call instead of ending the run - recovery from this is routine.
                        val known = specs.joinToString(", ") { it.name }
                        transcript += AgentMessage.Tool(
                            toolCallId = call.id,
                            name = call.name,
                            content = "Error: no tool named \"${call.name}\". Available tools: $known",
                        )
                        continue
                    }

                    val print = fingerprint(call)
                    repeats = if (print == lastFingerprint) repeats + 1 else 0
                    lastFingerprint = print
                    if (repeats >= REPEAT_LIMIT) {
                        transcript += AgentMessage.Tool(
                            toolCallId = call.id,
                            name = call.name,
                            content = "Error: ${call.name} has now been called ${repeats + 1} times with " +
                                "identical arguments and identical results. Change approach or stop and " +
                                "explain what is blocking you.",
                        )
                        continue
                    }

                    emit(AgentEvent.ToolStart(call, spec.mutating))
                    val outcome = executor.execute(call, cancelled)
                    emit(AgentEvent.ToolEnd(call, outcome))
                    transcript += AgentMessage.Tool(
                        toolCallId = call.id,
                        name = call.name,
                        content = outcome.content,
                    )
                }
            }
        }
    }

    return AgentFailure(AgentFailureReason.STEP_BUDGET_EXCEEDED, "stopped after $budget steps")
}
