// OpenAI-compatible localhost backend: Ollama, LM Studio, llama.cpp server -
// anything serving /v1/models + /v1/chat/completions. Plain fetch, zero
// dependencies. This is the free local path for hosts with no WebGPU
// (JetBrains JCEF), and the "I already run Ollama" path everywhere else.
//
// RULE 0 NOTE (deliberate, allowed): the 127.0.0.1 default below is the
// USER'S OWN local inference server on their machine - it is not a
// browser-facing platform URL or token issuer, so the no-localhost rule does
// not apply to it. Platform URLs (host.apiBase etc.) still never default to
// localhost.
//
// Typed-failure contract ported from web/app/lib/edge/codegen.ts: never
// throws to callers - every failure resolves as an EdgeFailure result.

import type {
  EdgeFailure,
  EngineGenerateRequest,
  EngineGenerateResult,
  LocalEngine,
  LocalEngineStatus,
} from "./engine";
import type { EdgeHost } from "./host";

/** kv - user-configured server origin (plugin settings). Unset = the Ollama
 * default below. Trailing slashes tolerated. */
export const OLLAMA_BASE_URL_KEY = "edge.ollamaBaseUrl";
/** kv - user-chosen model id on that server. Unset = first listed model. */
export const OLLAMA_MODEL_KEY = "edge.ollamaModel";

/** Ollama's default OpenAI-compatible endpoint (LM Studio uses :1234 -
 * configurable via OLLAMA_BASE_URL_KEY). */
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

const PROBE_TIMEOUT_MS = 800;
const GENERATION_IDLE_TIMEOUT_MS = 30_000;
const TURN_CEILING_MS = 120_000;
/** Probe results are short-lived: a server the user just started should be
 * picked up without reloading the webview, but per-keystroke completions
 * must not re-probe every call. */
const PROBE_CACHE_MS = 30_000;

export function createOllamaEngine(
  host: EdgeHost,
  onStatus?: (status: LocalEngineStatus) => void
): LocalEngine {
  let status: LocalEngineStatus = { state: "unavailable", detail: "not probed yet" };
  let cachedModels: string[] = [];
  let lastProbeAt = 0;
  let lastProbeOk = false;

  function pushStatus(next: LocalEngineStatus): void {
    status = next;
    try {
      onStatus?.(next);
    } catch {
      // Never break the engine path over a listener.
    }
  }

  function baseUrl(): string {
    const configured = host.kv.get(OLLAMA_BASE_URL_KEY);
    const base = configured && configured.trim() ? configured.trim() : DEFAULT_BASE_URL;
    return base.replace(/\/+$/, "");
  }

  function pickModel(): string | null {
    const chosen = host.kv.get(OLLAMA_MODEL_KEY);
    if (chosen && chosen.trim()) return chosen.trim();
    return cachedModels[0] ?? null;
  }

  function failure(reason: EdgeFailure["reason"], detail?: unknown): EdgeFailure {
    return {
      ok: false,
      reason,
      detail:
        detail instanceof Error ? detail.message : detail != null ? String(detail) : undefined,
    };
  }

  async function probe(): Promise<boolean> {
    try {
      if (typeof fetch === "undefined") return false;
      const now = Date.now();
      if (now - lastProbeAt < PROBE_CACHE_MS) return lastProbeOk;
      lastProbeAt = now;
      lastProbeOk = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${baseUrl()}/v1/models`, { signal: controller.signal });
        if (!res.ok) {
          pushStatus({ state: "unavailable", detail: `local server answered ${res.status}` });
          return false;
        }
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
        cachedModels = Array.isArray(body?.data)
          ? body.data
              .map((m) => (typeof m?.id === "string" ? m.id : null))
              .filter((id): id is string => id !== null)
          : [];
        const model = pickModel();
        if (!model) {
          pushStatus({ state: "unavailable", detail: "local server has no models" });
          return false;
        }
        lastProbeOk = true;
        pushStatus({ state: "ready", modelId: model });
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Connection refused / timeout - no local server, probe answers false.
      pushStatus({ state: "unavailable", detail: "no local inference server" });
      return false;
    }
  }

  async function generate(
    req: EngineGenerateRequest,
    onDelta?: (delta: string) => void
  ): Promise<EngineGenerateResult> {
    const turnStartedAt = Date.now();
    try {
      if (req.signal?.aborted) return failure("aborted");
      const model = pickModel();
      if (!model) return failure("unavailable", "no local server model");

      const userContent = req.suffix?.trim()
        ? `${req.prompt}\n\n[TEXT AFTER THE INSERTION POINT - your output must join up with it]\n${req.suffix}`
        : req.prompt;
      const messages = [
        { role: "system", content: req.system },
        ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userContent },
      ];

      // One controller drives everything: the caller's signal, the per-chunk
      // idle window and the whole-turn ceiling all abort the same fetch.
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      req.signal?.addEventListener("abort", onCallerAbort);
      let timedOut: "idle" | "ceiling" | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        const remaining = TURN_CEILING_MS - (Date.now() - turnStartedAt);
        if (remaining <= 0) {
          timedOut = "ceiling";
          controller.abort();
          return;
        }
        const idleMs = Math.min(GENERATION_IDLE_TIMEOUT_MS, remaining);
        idleTimer = setTimeout(() => {
          timedOut = remaining <= GENERATION_IDLE_TIMEOUT_MS ? "ceiling" : "idle";
          controller.abort();
        }, idleMs);
      };

      try {
        armIdle();
        const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            ...(req.maxTokens != null && req.maxTokens > 0 ? { max_tokens: req.maxTokens } : {}),
            ...(req.includeUsage ? { stream_options: { include_usage: true } } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          return failure("engine-failed", `local server answered ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        let completionTokens: number | null = null;
        for (;;) {
          armIdle();
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // OpenAI SSE framing: "data: {...}\n\n" per event, "data: [DONE]"
          // terminator. Strip "data:" then trim - tolerant of both "data:"
          // and "data: " (the classic space-chunk bug class).
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: unknown } }>;
                usage?: { completion_tokens?: unknown } | null;
              };
              const reported = parsed.usage?.completion_tokens;
              if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
                completionTokens = reported;
              }
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) {
                full += delta;
                if (onDelta) {
                  try {
                    onDelta(delta);
                  } catch {
                    // Never break the stream over a listener.
                  }
                }
              }
            } catch {
              // Malformed event - skip it, keep streaming.
            }
          }
        }
        if (req.signal?.aborted) return failure("aborted");
        if (!full.trim()) return failure("empty-reply");
        return {
          ok: true,
          text: full,
          modelId: model,
          backend: "ollama",
          ...(completionTokens != null ? { usage: { completionTokens } } : {}),
        };
      } catch (err) {
        if (timedOut === "ceiling") return failure("turn-ceiling-exceeded");
        if (timedOut === "idle") {
          return failure("generation-timeout", "no new tokens within the idle window");
        }
        if (req.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
          return failure("aborted");
        }
        return failure("generation-failed", err);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        req.signal?.removeEventListener("abort", onCallerAbort);
      }
    } catch (err) {
      // Belt-and-braces - the absolute never-throw contract.
      return failure("generation-failed", err);
    }
  }

  return {
    id: "ollama",
    probe,
    status: () => status,
    generate,
  };
}
