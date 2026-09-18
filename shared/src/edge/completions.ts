// One-shot inline code completion over a LocalEngine, modeled on
// web/app/lib/edge/codegen.ts (short system prompts, stripFence
// post-processing, typed failures, never throws). The completion prompt is
// fill-in-the-middle style: code before the cursor as the prompt, code after
// the cursor as the suffix (the engine renders the suffix block).

import type { EdgeFailure, EdgeFailureReason, LocalEngine } from "./engine";

export type { EdgeFailureReason };

export interface CompletionRequest {
  /** Code before the cursor (the tail of the file/window). */
  prefix: string;
  /** Code after the cursor. */
  suffix?: string;
  languageId?: string;
  /** Cap on generated tokens - completions must stay short. */
  maxTokens?: number;
  /** Soft deadline: past this the attempt is abandoned (typed
   * generation-timeout) so the caller can fall through to hosted/none.
   * The IDE provider passes ~1200ms; omitted = no soft deadline. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export type CompletionResult = { ok: true; text: string; backend: string } | EdgeFailure;

const DEFAULT_MAX_TOKENS = 128;

/** SHORT on purpose - every system-prompt token comes out of a 1-3B model's
 * context budget and completion latency. */
function completionSystemPrompt(languageId: string | undefined): string {
  const language = languageId ? `${languageId} ` : "";
  return (
    `You are an inline ${language}code completion engine. ` +
    `Given the code before the cursor (and possibly the code after it), output ONLY the code ` +
    `that belongs at the cursor - it must join both sides seamlessly. ` +
    `Output only code, no fences, no commentary. ` +
    `Prefer short completions: finish the current statement or block, then stop.`
  );
}

/** Strip a leading/trailing ``` or ```lang fence - local models reliably add
 * one despite being told not to. Ported verbatim from codegen.ts (mirrors
 * the server's own fence-strip). */
export function stripFence(text: string): string {
  let out = text.trim();
  if (out.startsWith("```")) {
    out = out
      .replace(/^```[a-zA-Z0-9]*\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return out;
}

/**
 * Run `work` against a combined abort signal: the caller's signal plus an
 * optional soft deadline. Resolves the deadline flag alongside the result so
 * the caller can distinguish "user aborted" from "too slow". Shared with
 * quickActions.ts.
 */
export async function withSoftDeadline<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  deadlineMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<{ result: T; deadlineHit: boolean }> {
  if (deadlineMs == null || deadlineMs <= 0) {
    return { result: await work(signal), deadlineHit: false };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) controller.abort();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    controller.abort();
  }, deadlineMs);
  try {
    const result = await work(controller.signal);
    return { result, deadlineHit };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * One inline completion. Never throws; a slow engine past the soft deadline
 * resolves { ok:false, reason:"generation-timeout" } so the IDE provider's
 * fall-through (hosted → none) stays a simple result check.
 */
export async function completeCode(
  engine: LocalEngine,
  req: CompletionRequest
): Promise<CompletionResult> {
  try {
    if (!req.prefix.trim()) {
      return { ok: false, reason: "empty-reply", detail: "empty prefix" };
    }
    const { result, deadlineHit } = await withSoftDeadline(
      (signal) =>
        engine.generate({
          useCase: "code",
          system: completionSystemPrompt(req.languageId),
          prompt: req.prefix,
          suffix: req.suffix,
          maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          signal,
        }),
      req.deadlineMs,
      req.signal
    );
    if (!result.ok) {
      if (result.reason === "aborted" && deadlineHit) {
        return { ok: false, reason: "generation-timeout", detail: "soft deadline exceeded" };
      }
      return result;
    }
    const text = stripFence(result.text);
    if (!text) return { ok: false, reason: "empty-reply" };
    return { ok: true, text, backend: result.backend };
  } catch (err) {
    // Belt-and-braces - never throw to the completion provider.
    return {
      ok: false,
      reason: "generation-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
