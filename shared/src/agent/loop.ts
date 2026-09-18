// The agent loop: model -> tool calls -> tool results -> model, until the model
// stops asking for tools or the step budget runs out.
//
// Why a budget at all. The platform's server-side loop caps tool calls per turn
// at 15 (`app.guardrails.max-tool-calls-per-turn`), which is right for a chat
// agent and far too low for a coding one - reading five files and running the
// tests spends it. This loop's default is deliberately higher AND bounded: an
// unbounded local loop with write and shell tools is how an agent quietly
// rewrites a repo at 3am. The ceiling is a safety property, not a tuning knob.

import type {
  AgentEvent,
  AgentMessage,
  AgentModel,
  AgentRunResult,
  ToolCall,
  ToolExecutor,
} from "./types";

/** High enough to read, edit, run tests and iterate a few times; low enough
 * that a looping model stops before it costs real money or real damage. */
export const DEFAULT_MAX_STEPS = 60;

/** Repeating the same call with the same arguments this many times in a row
 * means the model is stuck, not working. Cheaper to stop and say so than to
 * spend the whole budget proving it. */
const REPEAT_LIMIT = 3;

export interface AgentRunOptions {
  model: AgentModel;
  executor: ToolExecutor;
  /** Seed transcript: a system message and the user's task. */
  messages: AgentMessage[];
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

function fingerprint(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.args)}`;
}

export async function runAgentLoop(options: AgentRunOptions): Promise<AgentRunResult> {
  const { model, executor, signal, onEvent } = options;
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const messages: AgentMessage[] = [...options.messages];
  const specs = executor.specs();
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  let lastFingerprint = "";
  let repeats = 0;

  function emit(event: AgentEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // A listener must never be able to kill a run.
    }
  }

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    emit({ type: "step", index: step + 1, of: maxSteps });

    const reply = await model.chat(messages, specs, signal);
    if (!reply.ok) return reply;

    messages.push({
      role: "assistant",
      content: reply.content,
      ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}),
    });
    if (reply.content.trim()) emit({ type: "assistant", content: reply.content });

    // No tool calls means the model considers itself done. That is the normal
    // exit: there is no separate "finish" tool to forget to call.
    if (reply.toolCalls.length === 0) {
      emit({ type: "done", reason: "no-more-tool-calls" });
      return { ok: true, answer: reply.content, messages, stepsUsed: step + 1 };
    }

    for (const call of reply.toolCalls) {
      if (signal?.aborted) return { ok: false, reason: "aborted" };

      const spec = byName.get(call.name);
      if (!spec) {
        // Hallucinated tool name. Tell the model what it may actually call
        // instead of ending the run - recovery from this is routine.
        const known = specs.map((entry) => entry.name).join(", ");
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `Error: no tool named "${call.name}". Available tools: ${known}`,
        });
        continue;
      }

      const print = fingerprint(call);
      repeats = print === lastFingerprint ? repeats + 1 : 0;
      lastFingerprint = print;
      if (repeats >= REPEAT_LIMIT) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content:
            `Error: ${call.name} has now been called ${repeats + 1} times with identical ` +
            "arguments and identical results. Change approach or stop and explain what is blocking you.",
        });
        continue;
      }

      emit({ type: "tool-start", call, mutating: spec.mutating });
      const outcome = await executor.execute(call, signal);
      emit({ type: "tool-end", call, outcome });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: outcome.content,
      });
    }
  }

  return { ok: false, reason: "step-budget-exceeded", detail: `stopped after ${maxSteps} steps` };
}
