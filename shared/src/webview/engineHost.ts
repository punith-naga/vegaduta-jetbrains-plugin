// The in-webview engine host: wires the LocalEngine registry (edge/engine.ts)
// to the protocol shapes the chat app speaks (webview/chat/main.ts
// dynamic-imports this module and calls exactly createEngineHost()'s API).
// Loaded lazily behind that dynamic import so hosts that never enable local
// inference don't pay for the engine layer.

import {
  completeCode,
} from "../edge/completions";
import {
  createBackends,
  tryBackends,
  type EngineBackends,
  type LocalEngine,
  type LocalEngineStatus,
} from "../edge/engine";
import { createDefaultKv, type EdgeHost, type EdgeKv } from "../edge/host";
import { runQuickAction, type QuickActionKind } from "../edge/quickActions";
import type { WebLlmLocalEngine } from "../edge/webllmEngine";
import { VegadutaClient } from "../api/client";
import { toValidateLanguage, validateCode } from "../api/sdlc";
import type { EnginePlatform, EngineStatus, ValidationOutcome } from "./protocol";

/** kv - API base override seeded by the host page (e.g. VS Code writes it
 * before loading the webview, or plugin settings store it). */
export const EDGE_API_BASE_KEY = "edge.apiBase";

/** Production API origin - the default when neither config nor kv supplies
 * one. RULE 0: never a localhost default; staging (.xyz) is chosen
 * explicitly via plugin settings / the host's init config. */
const DEFAULT_API_BASE = "https://api.vegaduta.ai";

export interface EngineHostConfig {
  apiBase?: string;
  platform?: EnginePlatform;
  getToken?: () => Promise<string | null>;
  kv?: EdgeKv;
}

export interface EngineRunResult {
  ok: boolean;
  text?: string;
  reason?: string;
  validation?: ValidationOutcome;
}

/** Best-effort, timeout-bounded validate check for fix/refactor output.
 * codegen.ts's rule: never trust a local model's code as correct without
 * this - but never block or fail the quick action over it either. Resolves
 * undefined (not an error) on any failure: no token, wrong language, 403
 * (role not granted), network trouble, or the 3s budget running out. */
async function tryValidate(
  host: EdgeHost,
  languageId: string | undefined,
  code: string
): Promise<ValidationOutcome | undefined> {
  const language = toValidateLanguage(languageId);
  if (!language || !code.trim()) return undefined;
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000));
  const attempt = (async (): Promise<ValidationOutcome | undefined> => {
    const client = new VegadutaClient(host.apiBase, { getToken: host.getToken, refresh: async () => null });
    const result = await validateCode(client, language, code);
    if (!result.ok) return undefined;
    return { valid: result.valid ?? true, errors: result.errors };
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } catch {
    return undefined;
  }
}

export interface EngineHost {
  /** Probe backends and start pushing EngineStatus updates (load/download
   * progress included). Resolves after the initial probe pass. */
  start(onStatus: (status: EngineStatus) => void): Promise<void>;
  /** Run one local task. Never rejects - typed { ok:false, reason } results
   * only (the codegen.ts convention, carried through the whole edge layer). */
  run(
    reqId: string,
    kind: string,
    payload: { text: string; languageId?: string; suffix?: string; systemPrompt?: string }
  ): Promise<EngineRunResult>;
  /** Abort an in-flight run by its request id. */
  abort(reqId: string): void;
  /** Explicit-gesture model download (WebLLM backend). Never rejects -
   * failures surface through the status stream. */
  download(modelId: string): Promise<void>;
}

function detectPlatform(): EnginePlatform {
  if (typeof window !== "undefined") {
    const w = window as unknown as { acquireVsCodeApi?: unknown; cefQuery?: unknown };
    if (typeof w.acquireVsCodeApi === "function") return "vscode";
    if (typeof w.cefQuery === "function") return "jetbrains";
  }
  return "chrome";
}

const QUICK_ACTION_KINDS: ReadonlySet<string> = new Set(["explain", "fix", "refactor", "chat"]);

export function createEngineHost(config: EngineHostConfig = {}): EngineHost {
  const kv = config.kv ?? createDefaultKv();
  const host: EdgeHost = {
    apiBase: config.apiBase ?? kv.get(EDGE_API_BASE_KEY) ?? DEFAULT_API_BASE,
    getToken: config.getToken ?? (async () => null),
    kv,
    platform: config.platform ?? detectPlatform(),
  };

  let backends: EngineBackends | null = null;
  let activeEngine: LocalEngine | null = null;
  let statusCallback: ((status: EngineStatus) => void) | null = null;
  /** Last push per backend, for the combined-status computation below. */
  const backendStatus = new Map<string, LocalEngineStatus>();
  const controllers = new Map<string, AbortController>();

  /** One EngineStatus for the UI out of possibly-several backend statuses:
   * the active engine's status wins; else WebLLM's "idle" (usable after a
   * download - the UI's cue to offer one); else unavailable with the most
   * useful detail we have. */
  function combinedStatus(): EngineStatus {
    if (activeEngine) {
      const s = backendStatus.get(activeEngine.id) ?? activeEngine.status();
      return { ...s, backend: activeEngine.id };
    }
    const webllm = backendStatus.get("webllm");
    if (webllm && (webllm.state === "idle" || webllm.state === "loading")) {
      return { ...webllm, backend: "webllm" };
    }
    const detail =
      webllm?.detail ?? backendStatus.get("ollama")?.detail ?? "no local engine available";
    return { state: "unavailable", detail };
  }

  function emitStatus(): void {
    try {
      statusCallback?.(combinedStatus());
    } catch {
      // Status is best-effort - never break the engine path over it.
    }
  }

  function ensureBackends(): EngineBackends {
    if (!backends) {
      backends = createBackends(host, (backendId, status) => {
        backendStatus.set(backendId, status);
        emitStatus();
      });
    }
    return backends;
  }

  /** Resolve (and cache) the engine to run on. Re-probes when nothing is
   * active yet - a server started or a model downloaded after start() should
   * be picked up without reloading the webview (backend probes have their
   * own caching, so this stays cheap on the completion hot path). */
  async function ensureEngine(): Promise<LocalEngine | null> {
    if (activeEngine) return activeEngine;
    activeEngine = await tryBackends(host, ensureBackends());
    return activeEngine;
  }

  return {
    async start(onStatus: (status: EngineStatus) => void): Promise<void> {
      statusCallback = onStatus;
      try {
        await ensureEngine();
      } catch {
        // tryBackends never rejects by contract - belt-and-braces.
      }
      emitStatus();
    },

    async run(reqId, kind, payload): Promise<EngineRunResult> {
      const controller = new AbortController();
      controllers.set(reqId, controller);
      try {
        const engine = await ensureEngine();
        if (!engine) {
          return { ok: false, reason: "unavailable" };
        }
        if (kind === "completion") {
          const result = await completeCode(engine, {
            prefix: payload.text,
            suffix: payload.suffix,
            languageId: payload.languageId,
            signal: controller.signal,
          });
          return result.ok
            ? { ok: true, text: result.text }
            : { ok: false, reason: result.reason };
        }
        if (QUICK_ACTION_KINDS.has(kind)) {
          const result = await runQuickAction(engine, kind as QuickActionKind, {
            text: payload.text,
            languageId: payload.languageId,
            systemPrompt: payload.systemPrompt,
            signal: controller.signal,
          });
          if (!result.ok) return { ok: false, reason: result.reason };
          const validation =
            kind === "fix" || kind === "refactor"
              ? await tryValidate(host, payload.languageId, result.text)
              : undefined;
          return { ok: true, text: result.text, validation };
        }
        return { ok: false, reason: "unsupported" };
      } catch {
        // The edge layer never throws by contract - belt-and-braces so a bug
        // there still resolves a typed result for the protocol.
        return { ok: false, reason: "generation-failed" };
      } finally {
        controllers.delete(reqId);
        emitStatus();
      }
    },

    abort(reqId: string): void {
      controllers.get(reqId)?.abort();
    },

    async download(modelId: string): Promise<void> {
      try {
        const webllm = ensureBackends().webllm as WebLlmLocalEngine;
        const result = await webllm.download(modelId);
        if (result.ok) {
          // The downloaded model may outrank whatever was active (or nothing
          // was) - re-resolve so the next run uses it.
          activeEngine = null;
          await ensureEngine();
        }
      } catch {
        // download() never rejects by contract - belt-and-braces.
      }
      emitStatus();
    },
  };
}
