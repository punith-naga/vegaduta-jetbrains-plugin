// One-shot quick actions (explain / fix / refactor / chat) over a
// LocalEngine, modeled on web/app/lib/edge/codegen.ts: SHORT per-task system
// prompts, stripFence post-processing on code-producing tasks, typed
// failures, never throws. These back the protocol's engine.request kinds -
// the selection-sized fast path that should never need the hosted platform.

import { stripFence, withSoftDeadline } from "./completions";
import type { ChatHistoryMessage, EdgeFailure, LocalEngine } from "./engine";

export type QuickActionKind = "explain" | "fix" | "refactor" | "chat";

export interface QuickActionRequest {
  /** The selected code (explain/fix/refactor) or the chat message. */
  text: string;
  languageId?: string;
  /** chat only: overrides the default assistant prompt. */
  systemPrompt?: string;
  /** chat only: prior turns. The engine windows these oldest-first against
   * the model's context budget; the current message is never trimmed. */
  history?: ChatHistoryMessage[];
  maxTokens?: number;
  /** Soft deadline - same semantics as completions.ts. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export type QuickActionResult =
  | { ok: true; text: string; backend: string }
  | EdgeFailure;

/** Kinds whose output is code (fence-stripped, insertable at the cursor);
 * the rest stream as prose. */
const CODE_OUTPUT_KINDS: ReadonlySet<QuickActionKind> = new Set(["fix", "refactor"]);

/** SHORT on purpose (~4 sentences) - system-prompt tokens come straight out
 * of a small local model's context budget and latency. */
function systemPromptFor(kind: QuickActionKind, languageId: string | undefined): string {
  const language = languageId ? `${languageId} ` : "";
  switch (kind) {
    case "explain":
      return (
        `You explain ${language}code to a developer. ` +
        `Describe what the given code does, then note anything surprising: bugs, edge cases, ` +
        `or hidden assumptions. Be concrete and reference the actual identifiers in the code. ` +
        `Keep it short - a few sentences or a tight bullet list, no restating the code.`
      );
    case "fix":
      return (
        `You fix bugs in ${language}code. ` +
        `Return the corrected version of the given code with the smallest change that fixes it. ` +
        `Output only code, no fences, no commentary. ` +
        `Preserve the original formatting and naming everywhere you didn't need to touch.`
      );
    case "refactor":
      return (
        `You refactor ${language}code. ` +
        `Return an improved version of the given code: clearer names, less duplication, same ` +
        `behavior. Output only code, no fences, no commentary. ` +
        `Never change what the code does - only how it reads.`
      );
    case "chat":
      return (
        `You are a helpful coding assistant running locally on the developer's machine. ` +
        `Answer directly and completely; if the question has multiple parts, work through them ` +
        `in order. Use fenced code blocks for code. ` +
        `Say so plainly when you are not sure instead of guessing.`
      );
  }
}

function userPromptFor(kind: QuickActionKind, req: QuickActionRequest): string {
  if (kind === "chat") return req.text;
  const fence = req.languageId ? "```" + req.languageId : "```";
  const labels: Record<Exclude<QuickActionKind, "chat">, string> = {
    explain: "Explain this code:",
    fix: "Fix this code:",
    refactor: "Refactor this code:",
  };
  return `${labels[kind]}\n${fence}\n${req.text}\n\`\`\``;
}

/**
 * Run one quick action. Streams deltas to onDelta for prose kinds (code kinds
 * buffer so a half-streamed fence never reaches the editor). Never throws.
 */
export async function runQuickAction(
  engine: LocalEngine,
  kind: QuickActionKind,
  req: QuickActionRequest,
  onDelta?: (delta: string) => void
): Promise<QuickActionResult> {
  try {
    if (!req.text.trim()) {
      return { ok: false, reason: "empty-reply", detail: "empty input" };
    }
    const codeOutput = CODE_OUTPUT_KINDS.has(kind);
    const system =
      kind === "chat" && req.systemPrompt?.trim()
        ? req.systemPrompt
        : systemPromptFor(kind, req.languageId);
    const { result, deadlineHit } = await withSoftDeadline(
      (signal) =>
        engine.generate(
          {
            system,
            prompt: userPromptFor(kind, req),
            maxTokens: req.maxTokens,
            history: kind === "chat" ? req.history : undefined,
            // Everything but free chat is a turn ABOUT code, so a
            // code-trained model is the right pick when one is available.
            useCase: kind === "chat" ? "chat" : "code",
            signal,
          },
          codeOutput ? undefined : onDelta
        ),
      req.deadlineMs,
      req.signal
    );
    if (!result.ok) {
      if (result.reason === "aborted" && deadlineHit) {
        return { ok: false, reason: "generation-timeout", detail: "soft deadline exceeded" };
      }
      return result;
    }
    const text = codeOutput ? stripFence(result.text) : result.text.trim();
    if (!text) return { ok: false, reason: "empty-reply" };
    return { ok: true, text, backend: result.backend };
  } catch (err) {
    // Belt-and-braces - never throw to the action caller.
    return {
      ok: false,
      reason: "generation-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
