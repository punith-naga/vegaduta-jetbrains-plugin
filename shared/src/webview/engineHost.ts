// The in-webview engine host: wires the LocalEngine registry (edge/engine.ts)
// to the protocol shapes the chat app speaks (webview/chat/main.ts
// dynamic-imports this module and calls exactly createEngineHost()'s API).
// Loaded lazily behind that dynamic import so hosts that never enable local
// inference don't pay for the engine layer.
//
// NETWORK AUDIT (Private Mode semantics - see EDGE_PRIVATE_MODE_KEY). Every
// network call reachable from this module and clients/shared/src/edge/**:
//   1. edge/manifest.ts fetchManifest - unauthenticated GET
//      {apiBase}/api/edge/manifest. ALLOWED in Private Mode: it is the public
//      model catalog, has no request body, and carries none of the user's
//      prompts, code, attachments, page text or search queries.
//   2. edge/ollamaEngine.ts probe + generate - GET /v1/models and POST
//      /v1/chat/completions to the user's OWN local model server (default
//      http://127.0.0.1:11434, or the origin they configured). ALLOWED: the
//      user's own local model server is where local prompts are meant to go.
//   3. edge/webllmEngine.ts acquireEngine (inside @mlc-ai/web-llm) - model
//      weights from the public MLC/WebLLM model CDN. ALLOWED: a fresh
//      download starts only from download() on an explicit click; loading a
//      model that probe() reported ready reads weights already in Cache
//      Storage. Carries no user content. WebLLM inference runs on-device.
//   4. tryValidate below - POST to the hosted sdlc validate endpoint with
//      the generated code. BLOCKED while Private Mode is on, and also while
//      signed out (the no-token gate).
// Machine Check (benchmark) adds no call of its own: one generation on the
// engine that would serve a run now (on-device or 2), and for a WebLLM model
// a manifest read (1, normally already cached). It never downloads.

import {
  completeCode,
} from "../edge/completions";
import {
  measureEngine,
  recommendModel,
  verdictFor,
  BENCHMARK_CEILING_MS,
} from "../edge/benchmark";
import {
  createBackends,
  tryBackends,
  type EngineBackends,
  type LocalEngine,
  type LocalEngineStatus,
} from "../edge/engine";
import {
  detectCapabilities,
  getStoredModelOverride,
  setModelOverride as storeModelOverride,
  type EdgeCapabilities,
  type ModelOverride,
} from "../edge/capabilities";
import { fetchManifest } from "../edge/manifest";
import { createDefaultKv, type EdgeHost, type EdgeKv } from "../edge/host";
import { runQuickAction, type QuickActionKind } from "../edge/quickActions";
import type { WebLlmLocalEngine, WebLlmModelList } from "../edge/webllmEngine";
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
  /** Test seam: a prebuilt backend set instead of the real WebLLM +
   * local-server pair. Hosts never pass it. */
  backends?: EngineBackends;
  /** Test seam: capability detection for Machine Check's recommendation.
   * Defaults to the real detectCapabilities. */
  detectCapabilities?: () => Promise<EdgeCapabilities>;
  /** Test seams: Machine Check's ceiling (default 30 s) and clock. */
  benchmarkCeilingMs?: number;
  now?: () => number;
}

/** The request id Machine Check registers its AbortController under, so
 * abort(BENCHMARK_REQ_ID) cancels a running check. */
export const BENCHMARK_REQ_ID = "engine.benchmark";

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
export async function tryValidate(
  host: EdgeHost,
  languageId: string | undefined,
  code: string
): Promise<ValidationOutcome | undefined> {
  const language = toValidateLanguage(languageId);
  if (!language || !code.trim()) return undefined;
  // PRIVATE MODE GATE - checked before anything else, including getToken()
  // (a host's token getter may itself refresh over the network). Hosted code
  // validation is one of the blocked paths: while Private Mode is on the
  // generated code never leaves the machine, signed in or not.
  if (privateModeBlocks(host)) return undefined;
  // PRIVACY GATE - no token, no network. This runs on the ON-DEVICE path, whose
  // whole promise is that code stays on the machine; validation is the one
  // documented exception, and only "when you are signed in". Before
  // 2026-09-18 this checked nothing: the request was built anyway and simply
  // went out without an Authorization header. In VS Code the webview never
  // holds a token (getToken resolves null by design), so every local
  // Fix/Refactor on Java or Python POSTed the generated snippet to the server,
  // which rejected it with a 401 - after the code had already left the
  // machine. Check first, and send nothing at all when signed out.
  let token: string | null = null;
  try {
    token = await host.getToken();
  } catch {
    token = null;
  }
  if (!token) return undefined;
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

/** True when a hosted call must be skipped for Private Mode. An unreadable
 * preference store fails CLOSED - skipping validation only costs a badge. */
function privateModeBlocks(host: EdgeHost): boolean {
  try {
    return host.kv.get(EDGE_PRIVATE_MODE_KEY) === "1";
  } catch {
    return true;
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
    payload: {
      text: string;
      languageId?: string;
      suffix?: string;
      systemPrompt?: string;
      /** chat only: prior turns, windowed by the engine. */
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    },
    /** Prose kinds (explain/chat) stream deltas here; code kinds buffer. */
    onDelta?: (delta: string) => void
  ): Promise<EngineRunResult>;
  /** Abort an in-flight run by its request id. */
  abort(reqId: string): void;
  /** Explicit-gesture model download (WebLLM backend). Never rejects -
   * failures surface through the status stream. */
  download(modelId: string): Promise<void>;
  /** The picker's data: manifest models annotated with fit / downloaded /
   * recommended, plus whether WebGPU exists here at all. Never rejects. */
  listModels(): Promise<WebLlmModelList>;
  /** Explicit-gesture delete of a downloaded model's weights. Never rejects. */
  delete(modelId: string): Promise<void>;
  /** Pin the model choice: "auto" (best fit), "hosted" (never local), or a
   * manifest model id. Re-resolves the active engine so the pin applies to
   * the next run without a reload. */
  setModelOverride(value: ModelOverride): Promise<void>;
  /** The stored pin, "auto" when unset. */
  getModelOverride(): ModelOverride;
  /** Machine Check: time a short, fixed generation on the engine that would
   * serve a run right now and recommend a model for this device. Never
   * rejects, never downloads, 30 s ceiling; abort(BENCHMARK_REQ_ID)
   * cancels it. See BenchmarkResult. */
  benchmark(): Promise<BenchmarkResult>;
  /** Private Mode for the engine layer: while on, no prompt, code or other
   * user content leaves the machine from the edge layer - tryValidate (hosted
   * code validation) sends nothing. Still allowed: the user's own local
   * model server, WebLLM on-device inference, the public model manifest,
   * and weight downloads on an explicit click (see the NETWORK AUDIT at the
   * top of this file). Persisted in the kv under EDGE_PRIVATE_MODE_KEY so it
   * survives a reload. */
  setPrivateMode(on: boolean): void;
  isPrivateMode(): boolean;
}

/** kv - "1" while Private Mode is on. */
export const EDGE_PRIVATE_MODE_KEY = "edge.privateMode";

export interface BenchmarkResult {
  ok: boolean;
  /** Typed reason when !ok: "no-engine", "generation-failed", "aborted"
   * ("not-implemented" was the pre-implementation scaffold's answer). */
  reason?: string;
  backend?: string;
  modelId?: string | null;
  /** Milliseconds from request to the first token. */
  firstTokenMs?: number;
  /** Generated tokens per second (estimated from characters when the engine
   * reports no usage - `estimated` says which). */
  tokensPerSecond?: number;
  estimated?: boolean;
  /** Plain-language verdict, e.g. "Fast enough for inline completions". */
  verdict?: string;
  /** A manifest model id worth downloading for this device, when it differs
   * from what is running now. */
  recommendModelId?: string | null;
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

  let backends: EngineBackends | null = config.backends ?? null;
  const capabilities = config.detectCapabilities ?? (() => detectCapabilities());
  let benchmarkInFlight: Promise<BenchmarkResult> | null = null;
  let activeEngine: LocalEngine | null = null;
  let statusCallback: ((status: EngineStatus) => void) | null = null;
  /** Last push per backend, for the combined-status computation below. */
  const backendStatus = new Map<string, LocalEngineStatus>();
  const controllers = new Map<string, AbortController>();

  /** WebLLM details that describe THIS BACKEND being ruled out rather than
   * the machine's on-device state as a whole. When WebLLM is out for one of
   * these reasons the other backend's detail is the one worth showing - a
   * host with no WebGPU (JetBrains' JCEF) and a configured-but-down local
   * server was otherwise told "pinned to hosted", which names a setting the
   * person never touched instead of the server that is actually down. */
  const WEBLLM_SELF_EXCLUDING_DETAILS: ReadonlySet<string> = new Set([
    "pinned to hosted",
    "no WebGPU in this host",
    "on-device turned off",
  ]);

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
    const ollama = backendStatus.get("ollama");
    const webllmDetail = webllm?.detail;
    const preferOllamaDetail =
      webllmDetail != null && WEBLLM_SELF_EXCLUDING_DETAILS.has(webllmDetail) && ollama?.detail;
    const detail = preferOllamaDetail
      ? ollama?.detail
      : webllmDetail ?? ollama?.detail ?? "no local engine available";
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

  /** Machine Check body. Never rejects; never downloads (ensureEngine only
   * probes, and a probe answers true only for weights already on this device
   * or a local server already answering). */
  async function runBenchmark(): Promise<BenchmarkResult> {
    const controller = new AbortController();
    controllers.set(BENCHMARK_REQ_ID, controller);
    try {
      const engine = await ensureEngine();
      if (controller.signal.aborted) return { ok: false, reason: "aborted" };
      if (!engine) return { ok: false, reason: "no-engine" };
      const measured = await measureEngine(engine, {
        signal: controller.signal,
        ceilingMs: config.benchmarkCeilingMs ?? BENCHMARK_CEILING_MS,
        now: config.now,
      });
      if (!measured.ok) {
        return { ok: false, reason: measured.reason, backend: engine.id };
      }
      let recommendModelId: string | null = null;
      // Only a manifest (WebLLM) model has a known size to compare against;
      // a model on the user's own server is theirs to size.
      if (engine.id === "webllm" && measured.modelId) {
        try {
          const [manifest, caps] = await Promise.all([fetchManifest(host), capabilities()]);
          recommendModelId = recommendModel(manifest, caps, measured.modelId, measured.tokensPerSecond);
        } catch {
          recommendModelId = null;
        }
      }
      return {
        ok: true,
        backend: measured.backend,
        modelId: measured.modelId,
        firstTokenMs: measured.firstTokenMs,
        tokensPerSecond: measured.tokensPerSecond,
        estimated: measured.estimated,
        verdict: verdictFor(measured.tokensPerSecond),
        recommendModelId,
      };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "aborted" : "generation-failed" };
    } finally {
      if (controllers.get(BENCHMARK_REQ_ID) === controller) controllers.delete(BENCHMARK_REQ_ID);
      emitStatus();
    }
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

    async run(reqId, kind, payload, onDelta): Promise<EngineRunResult> {
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
          const result = await runQuickAction(
            engine,
            kind as QuickActionKind,
            {
              text: payload.text,
              languageId: payload.languageId,
              systemPrompt: payload.systemPrompt,
              history: payload.history,
              signal: controller.signal,
            },
            onDelta
          );
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

    async listModels(): Promise<WebLlmModelList> {
      try {
        const webllm = ensureBackends().webllm as WebLlmLocalEngine;
        return await webllm.listModels();
      } catch {
        return { webgpu: false, models: [], override: getStoredModelOverride(host) };
      }
    },

    async delete(modelId: string): Promise<void> {
      try {
        const webllm = ensureBackends().webllm as WebLlmLocalEngine;
        await webllm.deleteModel(modelId);
      } catch {
        // deleteModel() never rejects by contract - belt-and-braces.
      }
      // Whatever was active may just have been deleted - re-resolve.
      activeEngine = null;
      try {
        await ensureEngine();
      } catch {
        // tryBackends never rejects by contract.
      }
      emitStatus();
    },

    async setModelOverride(value: ModelOverride): Promise<void> {
      storeModelOverride(host, value || "auto");
      activeEngine = null;
      try {
        await ensureEngine();
      } catch {
        // tryBackends never rejects by contract.
      }
      emitStatus();
    },

    getModelOverride(): ModelOverride {
      return getStoredModelOverride(host);
    },

    benchmark(): Promise<BenchmarkResult> {
      // One check at a time - a second click joins the running one.
      if (benchmarkInFlight) return benchmarkInFlight;
      const running = runBenchmark().finally(() => {
        if (benchmarkInFlight === running) benchmarkInFlight = null;
      });
      benchmarkInFlight = running;
      return running;
    },

    setPrivateMode(on: boolean): void {
      try {
        host.kv.set(EDGE_PRIVATE_MODE_KEY, on ? "1" : "0");
      } catch {
        // Best-effort persistence; tryValidate fails closed on a bad kv.
      }
    },

    isPrivateMode(): boolean {
      try {
        return host.kv.get(EDGE_PRIVATE_MODE_KEY) === "1";
      } catch {
        return false;
      }
    },
  };
}
