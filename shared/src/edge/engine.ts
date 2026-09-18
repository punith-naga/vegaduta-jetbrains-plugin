// The LocalEngine seam: one interface over every free local-inference
// backend (WebLLM/WebGPU today, an OpenAI-compatible localhost server like
// Ollama/LM Studio/llama.cpp as the zero-GPU fallback), plus the registry
// that picks the first backend able to serve right now. Typed-failure
// contract ported from web/app/lib/edge/codegen.ts: nothing here ever throws
// to a caller - every failure is a { ok: false, reason } result.

import type { ModelUseCase } from "./capabilities";
import type { EdgeHost } from "./host";
import { createOllamaEngine } from "./ollamaEngine";
import { createWebLlmEngine } from "./webllmEngine";

// ---------------------------------------------------------------------------
// Typed results (the codegen.ts convention)
// ---------------------------------------------------------------------------

export type EdgeFailureReason =
  | "unsupported" // this host can't run the backend at all (no WebGPU, no server)
  | "unavailable" // backend exists but nothing is ready (no downloaded model)
  | "engine-failed" // engine/model load failed (incl. GPU OOM, dead server)
  | "generation-failed" // the turn itself failed mid-generation
  | "generation-timeout" // no output within the idle window / soft deadline
  | "turn-ceiling-exceeded" // whole turn ran past the wall-clock ceiling
  | "context-window-exceeded" // irreducible prompt can't fit the model's window
  | "empty-reply" // model returned nothing usable
  | "aborted"; // caller's AbortSignal fired

export interface EdgeFailure {
  ok: false;
  reason: EdgeFailureReason;
  /** Original error message, for logs - never for the UI. */
  detail?: string;
}

export interface EngineGenerateSuccess {
  ok: true;
  text: string;
  modelId: string;
  backend: string;
  /** Token counts the engine itself reported - present only when the request
   * asked for them (includeUsage) AND the backend answered. Absent means
   * "unknown", never zero; callers estimate from characters instead. */
  usage?: { completionTokens: number };
}

export type EngineGenerateResult = EngineGenerateSuccess | EdgeFailure;

// ---------------------------------------------------------------------------
// The engine interface
// ---------------------------------------------------------------------------

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EngineGenerateRequest {
  system: string;
  prompt: string;
  /** What this turn IS, so a backend that chooses between models can pick a
   * code-trained one for code work. Backends that serve a single model (the
   * local-server backend) ignore it. Default "chat". */
  useCase?: ModelUseCase;
  /** Completion only: text after the cursor (fill-in style). */
  suffix?: string;
  maxTokens?: number;
  /** Optional prior turns; backends window/trim these oldest-first against
   * the model's context budget - the system + current prompt are irreducible. */
  history?: ChatHistoryMessage[];
  signal?: AbortSignal;
  /** Ask the backend to report generated-token usage (OpenAI
   * stream_options.include_usage). Only Machine Check sets it, so every
   * other request stays byte-for-byte what it was. */
  includeUsage?: boolean;
}

/** Mirrors webview/protocol.ts EngineStatus minus `backend` (the registry/
 * engineHost stamps that on) so the edge layer stays webview-agnostic. */
export interface LocalEngineStatus {
  state: "unavailable" | "idle" | "loading" | "ready";
  /** 0..1 while state === "loading". */
  progress?: number;
  modelId?: string | null;
  detail?: string;
}

export interface LocalEngine {
  /** Stable backend id - "webllm" | "ollama" (also the edge.backend kv value). */
  id: string;
  /** True ONLY when this backend can serve a generation RIGHT NOW (weights
   * cached / server answering) - never on the promise of a download. Never
   * rejects. */
  probe(): Promise<boolean>;
  status(): LocalEngineStatus;
  /** Stream deltas to onDelta; the resolved value carries the full text.
   * Never throws - typed EdgeFailure results only. */
  generate(
    req: EngineGenerateRequest,
    onDelta?: (delta: string) => void
  ): Promise<EngineGenerateResult>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** kv - backend pin: "webllm" | "ollama" moves that backend to the front of
 * the probe order (it must still probe true); "off" disables local inference
 * entirely. Unset = default order (webllm first - zero-install flagship). */
export const ENGINE_BACKEND_KEY = "edge.backend";

export interface EngineBackends {
  webllm: LocalEngine;
  ollama: LocalEngine;
  all: LocalEngine[];
}

/** Construct the backend set once per page/engine-host. `onStatus` receives
 * push updates (load/download progress) from backends that emit them. */
export function createBackends(
  host: EdgeHost,
  onStatus?: (backendId: string, status: LocalEngineStatus) => void
): EngineBackends {
  const webllm = createWebLlmEngine(host, (s) => onStatus?.("webllm", s));
  const ollama = createOllamaEngine(host, (s) => onStatus?.("ollama", s));
  return { webllm, ollama, all: [webllm, ollama] };
}

/**
 * The first backend that probes true, in order webllm → ollama (the user's
 * edge.backend pin reorders to front; "off" short-circuits to null). Never
 * rejects - a page with no serviceable backend resolves null and callers
 * fall through to hosted.
 */
export async function tryBackends(
  host: EdgeHost,
  backends: EngineBackends
): Promise<LocalEngine | null> {
  const pin = host.kv.get(ENGINE_BACKEND_KEY);
  if (pin === "off") return null;
  let ordered = backends.all;
  if (pin) {
    const pinned = backends.all.find((b) => b.id === pin);
    if (pinned) {
      ordered = [pinned, ...backends.all.filter((b) => b.id !== pin)];
    }
  }
  for (const backend of ordered) {
    try {
      if (await backend.probe()) return backend;
    } catch {
      // probe() never rejects by contract - belt-and-braces only.
    }
  }
  return null;
}
