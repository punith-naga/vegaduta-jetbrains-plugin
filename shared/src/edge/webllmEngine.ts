// Ported from web/app/lib/edge/tier1.ts (the battle-tested WebLLM runtime
// wrapper) - minimally, keeping its binding contracts:
//   - @mlc-ai/web-llm arrives ONLY via dynamic import(); the static imports
//     below are type-only and fully erased, so bundles never carry the
//     library until a local generation/download actually happens;
//   - in-page CreateMLCEngine ONLY - web's Service-Worker engine path is
//     deliberately not ported (webview SWs are unreliable, and MV3's CSP
//     forbids the CDN-importing SW script web uses);
//   - typed errors: callers NEVER see a raw throw - every failure resolves
//     as an EdgeFailure result (the codegen.ts convention);
//   - readiness is never resolved on the promise of a download: probe() only
//     answers true for weights ALREADY cached and verified on this device;
//     download() runs only from an explicit user gesture;
//   - bounded everything: 60s engine-acquire deadline, 30s generation idle
//     timeout, 120s whole-turn ceiling, 10min engine idle teardown;
//   - D-9 context budget: window - 1024 output reserve - 8% margin at
//     chars/3.5, history trimmed oldest-first in whole turns, and an
//     irreducible (system + current turn) overflow fails typed BEFORE
//     inference.

import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface,
} from "@mlc-ai/web-llm";
import {
  detectCapabilities,
  getEdgeOptIn,
  getStoredModelOverride,
  modelFits,
  selectBestModel,
  type EdgeCapabilities,
  type ManifestModel,
  type ModelUseCase,
} from "./capabilities";
import type {
  EdgeFailure,
  EngineGenerateRequest,
  EngineGenerateResult,
  LocalEngine,
  LocalEngineStatus,
} from "./engine";
import type { EdgeHost } from "./host";
import { fetchManifest } from "./manifest";

// ---------------------------------------------------------------------------
// Context budget (D-9 port - same numbers, same estimator)
// ---------------------------------------------------------------------------

/** Last-resort window when neither the manifest nor the installed engine
 * record answers - MLC prebuilts ship 4096. */
export const WEBLLM_FALLBACK_CONTEXT_WINDOW = 4096;

/** Tokens held back for the reply (the documented default reserve). */
export const OUTPUT_RESERVE_TOKENS = 1024;

/** Fraction of the window held back to absorb estimator error and the chat
 * template's per-message wrapping tokens. */
export const BUDGET_SAFETY_MARGIN = 0.08;

/** HONEST LIMITATION, by design: WebLLM exposes no cheap tokenizer to the
 * main thread, so tokens are ESTIMATED at chars/3.5 - deliberately below the
 * ~4 chars/token English average so the estimate over-counts (safe
 * direction). The engine's own ContextWindowSizeExceededError is the
 * belt-and-braces for genuine estimator misses. */
const CHARS_PER_TOKEN = 3.5;

export function estimateLocalTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** budget = window - output reserve - ceil(window x margin). Can be <= 0 on
 * a pathologically small window - assembly then reports the irreducible
 * prompt as over budget, which is the honest answer. */
export function computeLocalPromptBudget(
  contextWindowSize: number,
  reserveTokens: number = OUTPUT_RESERVE_TOKENS
): number {
  return (
    contextWindowSize - reserveTokens - Math.ceil(contextWindowSize * BUDGET_SAFETY_MARGIN)
  );
}

interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LocalPromptAssembly {
  /** False = the IRREDUCIBLE prompt (system + current turn) alone exceeds
   * the budget - the caller must NOT attempt local inference. */
  fits: boolean;
  messages: PromptMessage[];
  droppedHistoryMessages: number;
  estimatedPromptTokens: number;
  budgetTokens: number;
}

/**
 * Windowed prompt assembly (port of tier1.ts assembleTier1Prompt): system +
 * the current turn are irreducible; prior history trims oldest-first in
 * WHOLE turns (a turn = a user message plus everything up to the next user
 * message, so an assistant reply is never separated from its prompt). Pure -
 * never mutates its inputs.
 */
export function assembleLocalPrompt(
  system: PromptMessage,
  history: PromptMessage[],
  currentTurn: PromptMessage[],
  contextWindowSize: number,
  reserveTokens: number = OUTPUT_RESERVE_TOKENS
): LocalPromptAssembly {
  const budgetTokens = computeLocalPromptBudget(contextWindowSize, reserveTokens);
  const tokensOf = (m: PromptMessage) => estimateLocalTokens(m.content);
  const irreducibleTokens =
    tokensOf(system) + currentTurn.reduce((sum, m) => sum + tokensOf(m), 0);
  if (irreducibleTokens > budgetTokens) {
    return {
      fits: false,
      messages: [system, ...currentTurn],
      droppedHistoryMessages: history.length,
      estimatedPromptTokens: irreducibleTokens,
      budgetTokens,
    };
  }
  const groups: PromptMessage[][] = [];
  for (const message of history) {
    if (message.role === "user" || groups.length === 0) groups.push([message]);
    else groups[groups.length - 1].push(message);
  }
  // Keep the NEWEST whole turns that still fit, walking backward and stopping
  // at the first turn that would overflow - never skipping an older turn past
  // a dropped newer one, which would reorder context.
  let used = irreducibleTokens;
  let firstKeptGroup = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const groupTokens = groups[i].reduce((sum, m) => sum + tokensOf(m), 0);
    if (used + groupTokens > budgetTokens) break;
    used += groupTokens;
    firstKeptGroup = i;
  }
  const kept = groups.slice(firstKeptGroup).flat();
  return {
    fits: true,
    messages: [system, ...kept, ...currentTurn],
    droppedHistoryMessages: history.length - kept.length,
    estimatedPromptTokens: used,
    budgetTokens,
  };
}

// ---------------------------------------------------------------------------
// Timing constants (same values as tier1.ts)
// ---------------------------------------------------------------------------

const ENGINE_ACQUIRE_TIMEOUT_MS = 60_000;
const GENERATION_IDLE_TIMEOUT_MS = 30_000;
const TURN_CEILING_MS = 120_000;
const ENGINE_IDLE_TEARDOWN_MS = 10 * 60_000;
const GENERATION_IDLE_WAIT_CEILING_MS = 90_000;
const GENERATION_POLL_MS = 50;

// ---------------------------------------------------------------------------
// Weight presence (E-0b rule 6 port - marker is a hint, the Cache API is the
// truth; a stale marker must never trigger a silent multi-GB re-download)
// ---------------------------------------------------------------------------

/** kv marker prefix - set only after a model fully loaded once here. Same key
 * shape as web's localStorage marker so a Chrome side panel upgraded from a
 * web-profile install stays consistent. Exported so hosts never re-declare
 * it (the Chrome side panel used to carry a "keep in sync" copy). */
export const CACHED_KEY_PREFIX = "edge.tier1.cached.";

/** Where @mlc-ai/web-llm keeps model weights (Cache API, its default
 * backend); tensor-cache.json lists every shard a complete download must
 * have. Verified against the installed 0.2.84 package by the original. */
export const WEBLLM_MODEL_CACHE_SCOPE = "webllm/model";

/** Best-effort purge of one model's cached shards. Clears the readiness
 * marker FIRST so a half-purged set can never be mistaken for a complete
 * one (the tensor-index verification treats an incomplete set as absent
 * anyway - belt and braces). Never rejects. */
export async function purgeModelWeights(kv: { set(k: string, v: string): void }, modelId: string): Promise<void> {
  try {
    kv.set(CACHED_KEY_PREFIX + modelId, "0");
    if (typeof caches === "undefined") return;
    if (!(await caches.has(WEBLLM_MODEL_CACHE_SCOPE))) return;
    const cache = await caches.open(WEBLLM_MODEL_CACHE_SCOPE);
    const needle = `/${modelId}/`;
    for (const request of await cache.keys()) {
      if (request.url.includes(needle)) {
        await cache.delete(request);
      }
    }
  } catch {
    // Best-effort only.
  }
}

/** Raw Cache API reads only - must never import web-llm (the point is
 * answering readiness without pulling the library into the main path).
 *   true  → complete weight set present;
 *   false → definitively absent/incomplete (evicted);
 *   null  → could not determine (Cache API unavailable/errored). */
async function checkWeightsOnDevice(modelId: string): Promise<boolean | null> {
  try {
    if (typeof caches === "undefined") return null;
    if (!(await caches.has(WEBLLM_MODEL_CACHE_SCOPE))) return false;
    const cache = await caches.open(WEBLLM_MODEL_CACHE_SCOPE);
    const keys = await cache.keys();
    const needle = `/${modelId}/`;
    const urls = new Set<string>();
    for (const req of keys) {
      if (req.url.includes(needle)) urls.add(req.url);
    }
    if (urls.size === 0) return false;
    let indexUrl: string | null = null;
    for (const u of urls) {
      if (/\/(tensor|ndarray)-cache\.json$/.test(u)) {
        indexUrl = u;
        break;
      }
    }
    if (!indexUrl) return false;
    const indexRes = await cache.match(indexUrl);
    if (!indexRes) return false;
    const index = (await indexRes.json()) as { records?: Array<{ dataPath?: string }> };
    const records = Array.isArray(index?.records) ? index.records : null;
    if (!records || records.length === 0) return false;
    for (const record of records) {
      if (!record || typeof record.dataPath !== "string" || !record.dataPath) continue;
      if (!urls.has(new URL(record.dataPath, indexUrl).href)) return false;
    }
    return true;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download result
// ---------------------------------------------------------------------------

export type WebLlmDownloadResult =
  | { ok: true; model: ManifestModel }
  | { ok: false; code: "unsupported" | "no-model" | "no-storage" | "failed"; detail: string };

/** One row of the model picker: the manifest entry plus everything the UI
 * needs to render a Download / Use / Delete decision without touching the
 * engine internals. */
export interface WebLlmModelInfo {
  id: string;
  displayName: string;
  detailName: string | null;
  sizeBytes: number;
  speedTier: "fast" | "capable" | null;
  contextWindowSize: number | null;
  /** Device meets the manifest floors (WebGPU present, buffer/memory ok). */
  fits: boolean;
  /** Weights present AND verified in this origin's Cache Storage. */
  downloaded: boolean;
  /** The auto-selection's pick for a simple turn on this device - the row
   * the UI marks "recommended" and offers first. */
  recommended: boolean;
}

export interface WebLlmModelList {
  /** navigator.gpu adapter obtained - false means no row can ever download. */
  webgpu: boolean;
  models: WebLlmModelInfo[];
  /** The stored override: "auto" | "hosted" | a model id. */
  override: string;
}

/** The LocalEngine plus the explicit-gesture download surface engineHost
 * wires to the protocol's download messages. */
export interface WebLlmLocalEngine extends LocalEngine {
  /** Download + verify a model (the auto-selected best fit when modelId is
   * omitted). MUST only be called from an explicit user gesture - never
   * prompts, never auto-runs, never rejects. */
  download(modelId?: string): Promise<WebLlmDownloadResult>;
  /** Manifest tier-1 models annotated with fit/downloaded/recommended, so a
   * picker can render before any download. Never rejects. */
  listModels(): Promise<WebLlmModelList>;
  /** Drop a model's cached weights (and unload it if it is the loaded one).
   * Explicit gesture only. Never rejects. */
  deleteModel(modelId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebLlmEngine(
  host: EdgeHost,
  onStatus?: (status: LocalEngineStatus) => void
): WebLlmLocalEngine {
  // One loaded model at a time, engine handle reused across turns.
  let engineInstance: MLCEngineInterface | null = null;
  let engineModelId: string | null = null;
  let engineInFlight: Promise<MLCEngineInterface> | null = null;
  /** Nonzero for the exact span a generate() call is reading the engine -
   * reload/teardown defer to it (tier1's engineReaderCount, simplified). */
  let generationCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** context_window_size per installed-engine model record, captured verbatim
   * at the dynamic-import sites - never guessed. */
  const installedRecordWindows = new Map<string, number>();
  /** Per-model memo of the async presence check. */
  const weightPresence = new Map<string, Promise<boolean>>();

  let status: LocalEngineStatus = { state: "unavailable", detail: "not probed yet" };

  function pushStatus(next: LocalEngineStatus): void {
    status = next;
    try {
      onStatus?.(next);
    } catch {
      // A broken listener never breaks the engine path.
    }
  }

  function captureInstalledContextWindows(webllm: unknown): void {
    try {
      const list = (webllm as { prebuiltAppConfig?: { model_list?: unknown } })
        ?.prebuiltAppConfig?.model_list;
      if (!Array.isArray(list)) return;
      for (const record of list) {
        const id = (record as { model_id?: unknown })?.model_id;
        const cw = (record as { overrides?: { context_window_size?: unknown } })?.overrides
          ?.context_window_size;
        if (typeof id === "string" && typeof cw === "number" && Number.isFinite(cw) && cw > 0) {
          installedRecordWindows.set(id, Math.trunc(cw));
        }
      }
    } catch {
      // Best-effort - resolveContextWindow falls back to 4096.
    }
  }

  /** Discovery precedence per the design: admin/manifest value → installed
   * engine record → conservative 4096. */
  function resolveContextWindow(model: ManifestModel): number {
    if (model.contextWindowSize != null && model.contextWindowSize > 0) {
      return Math.trunc(model.contextWindowSize);
    }
    return installedRecordWindows.get(model.id) ?? WEBLLM_FALLBACK_CONTEXT_WINDOW;
  }

  function isMarkerSet(modelId: string): boolean {
    return host.kv.get(CACHED_KEY_PREFIX + modelId) === "1";
  }

  /** Definitively-missing weights clear the stale marker; indeterminate
   * results answer not-ready WITHOUT clearing it, so a transient Cache API
   * failure can't force a re-download opt-in. */
  function verifyWeightsPresent(modelId: string): Promise<boolean> {
    const existing = weightPresence.get(modelId);
    if (existing) return existing;
    const check = (async () => {
      const present = await checkWeightsOnDevice(modelId);
      if (present === false) {
        host.kv.set(CACHED_KEY_PREFIX + modelId, "0");
        return false;
      }
      return present === true;
    })().catch(() => false);
    weightPresence.set(modelId, check);
    return check;
  }

  /** Ready = marker present AND weights verified on device. Marker absent →
   * false immediately, no async cache work. */
  async function isModelReady(modelId: string): Promise<boolean> {
    if (!isMarkerSet(modelId)) return false;
    return verifyWeightsPresent(modelId);
  }

  /**
   * The model a local turn would run RIGHT NOW, or null. Selection follows
   * the binding best-fit rule (user override wins, else best-fit auto pick),
   * then requires the weights to be ALREADY cached; when the auto pick isn't
   * cached but another fitting model is, the largest cached one runs
   * (promote to the better model only once its download completes - never
   * block on it). A user-pinned model that isn't downloaded stays pinned -
   * never run a different model than the one the user chose. Never rejects.
   */
  async function pickReadyModel(
    caps: EdgeCapabilities,
    useCase: ModelUseCase = "chat"
  ): Promise<ManifestModel | null> {
    try {
      if (!caps.webgpu.available) return null;
      const manifest = await fetchManifest(host);
      const tier1Models = manifest.models.filter((m) => m.tier === 1);
      if (tier1Models.length === 0) return null;
      const selection = selectBestModel(
        { ...manifest, models: tier1Models },
        caps,
        getStoredModelOverride(host),
        "simple",
        useCase
      );
      if (selection.kind === "hosted") return null;
      if (selection.model && (await isModelReady(selection.model.id))) return selection.model;
      if (selection.source === "user") return null;
      // Fall back over what is actually downloaded. A code turn still prefers
      // a downloaded coder model over a bigger generalist; with none
      // downloaded it takes the biggest fitting model rather than nothing.
      const fitting = tier1Models
        .filter((m) => modelFits(m, caps))
        .sort((a, b) => {
          if (useCase === "code") {
            const aCode = a.useCases?.includes("code") ? 1 : 0;
            const bCode = b.useCases?.includes("code") ? 1 : 0;
            if (aCode !== bCode) return bCode - aCode;
          }
          return b.sizeBytes - a.sizeBytes;
        });
      for (const candidate of fitting) {
        // Sequential on purpose: readiness is memoized per model, and
        // marker-less models answer false without touching the Cache API.
        if (await isModelReady(candidate.id)) return candidate;
      }
      return null;
    } catch {
      return null;
    }
  }

  // --- engine lifecycle ----------------------------------------------------

  function scheduleIdleTeardown(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void teardownIdleEngine();
    }, ENGINE_IDLE_TEARDOWN_MS);
  }

  /** Bounds worst-case GPU memory lifetime without ever tearing down
   * mid-load or mid-generation (a turn outliving the idle window defers). */
  async function teardownIdleEngine(): Promise<void> {
    if (!engineInstance || engineInFlight) return;
    if (generationCount > 0) {
      scheduleIdleTeardown();
      return;
    }
    const instance = engineInstance;
    // Drop the handles BEFORE the async unload so no interleaving acquire can
    // grab an engine that's mid-unload (tier1's TOCTOU fix, simplified by
    // clearing first - a concurrent acquire then just cold-loads).
    engineInstance = null;
    engineModelId = null;
    try {
      await instance.unload();
    } catch {
      // Best-effort.
    }
    pushStatus({ state: "idle", modelId: null });
  }

  function waitForGenerationsIdle(): Promise<void> {
    if (generationCount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = Date.now() + GENERATION_IDLE_WAIT_CEILING_MS;
      const check = () => {
        if (generationCount === 0 || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, GENERATION_POLL_MS);
      };
      check();
    });
  }

  function progressReporter(model: ManifestModel): (report: InitProgressReport) => void {
    return (report) => {
      try {
        const fraction = Math.max(0, Math.min(1, report.progress || 0));
        pushStatus({ state: "loading", progress: fraction, modelId: model.id });
      } catch {
        // Progress is best-effort - never break the load over it.
      }
    };
  }

  async function acquireEngine(model: ManifestModel): Promise<MLCEngineInterface> {
    if (engineInstance && engineModelId === model.id) {
      scheduleIdleTeardown(); // cache hit still counts as "used"
      return engineInstance;
    }
    if (engineInFlight) {
      // Serialize: let the in-flight load settle, then re-check.
      try {
        await engineInFlight;
      } catch {
        // The previous load failed - retry fresh below.
      }
      if (engineInstance && engineModelId === model.id) {
        scheduleIdleTeardown();
        return engineInstance;
      }
    }
    const load = (async (): Promise<MLCEngineInterface> => {
      // THE dynamic import - the only place @mlc-ai/web-llm code enters the
      // bundle's execution path.
      const webllm = await import("@mlc-ai/web-llm");
      captureInstalledContextWindows(webllm);
      const onProgress = progressReporter(model);
      try {
        let engine: MLCEngineInterface;
        if (engineInstance) {
          // Model switch: reload in place rather than leaking a second engine
          // (two loaded models would double GPU memory). Never reload out
          // from under a live generation.
          await waitForGenerationsIdle();
          if (engineInstance) {
            engine = engineInstance;
            engine.setInitProgressCallback(onProgress);
            engineModelId = null; // invalid during reload
            await engine.reload(model.id);
          } else {
            // A concurrent idle-teardown dropped it while we waited.
            engine = await webllm.CreateMLCEngine(model.id, {
              initProgressCallback: onProgress,
            });
            engineInstance = engine;
          }
        } else {
          engine = await webllm.CreateMLCEngine(model.id, { initProgressCallback: onProgress });
          engineInstance = engine;
        }
        engineModelId = model.id;
        pushStatus({ state: "ready", modelId: model.id });
        scheduleIdleTeardown();
        return engine;
      } catch (err) {
        // A failed create/reload (device lost, GPU OOM) leaves nothing usable.
        engineInstance = null;
        engineModelId = null;
        throw err;
      }
    })();
    engineInFlight = load.finally(() => {
      engineInFlight = null;
    });
    return engineInFlight;
  }

  function withDeadline<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  // --- failure mapping -----------------------------------------------------

  function failure(reason: EdgeFailure["reason"], detail?: unknown): EdgeFailure {
    return {
      ok: false,
      reason,
      detail:
        detail instanceof Error ? detail.message : detail != null ? String(detail) : undefined,
    };
  }

  /** Name-checked (never instanceof) so this stays synchronous and outside
   * the dynamic-import boundary - @mlc-ai/web-llm's DeviceLostError and
   * ContextWindowSizeExceededError both set their `name` in the constructor
   * (verified against the installed 0.2.84 package by the original). */
  function mapThrown(err: unknown, fallbackReason: EdgeFailure["reason"]): EdgeFailure {
    if (err instanceof Error && err.name === "AbortError") return failure("aborted", err);
    if (err instanceof Error && err.name === "DeviceLostError") {
      return failure("engine-failed", `GPU device lost (often OOM): ${err.message}`);
    }
    if (err instanceof Error && err.name === "ContextWindowSizeExceededError") {
      return failure("context-window-exceeded", err);
    }
    return failure(fallbackReason, err);
  }

  // --- generation ----------------------------------------------------------

  async function generate(
    req: EngineGenerateRequest,
    onDelta?: (delta: string) => void
  ): Promise<EngineGenerateResult> {
    // Started AFTER engine acquire (matching tier1.ts's runTurn) so a cold
    // load never eats into the generation ceiling.
    let turnStartedAt = Date.now();
    try {
      if (req.signal?.aborted) return failure("aborted");
      const caps = await detectCapabilities();
      if (!caps.webgpu.available) return failure("unsupported", "no WebGPU in this host");
      const model = await pickReadyModel(caps, req.useCase ?? "chat");
      if (!model) return failure("unavailable", "no downloaded on-device model");

      let engine: MLCEngineInterface;
      try {
        engine = await withDeadline(
          acquireEngine(model),
          ENGINE_ACQUIRE_TIMEOUT_MS,
          "engine-load-timeout"
        );
      } catch (err) {
        return mapThrown(err, "engine-failed");
      }
      turnStartedAt = Date.now();

      // D-9 budget check - typed failure BEFORE inference when the
      // irreducible prompt (system + current turn) can't fit even with all
      // history trimmed.
      const contextWindowSize = resolveContextWindow(model);
      const userContent = req.suffix?.trim()
        ? `${req.prompt}\n\n[TEXT AFTER THE INSERTION POINT - your output must join up with it]\n${req.suffix}`
        : req.prompt;
      const assembly = assembleLocalPrompt(
        { role: "system", content: req.system },
        (req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
        [{ role: "user", content: userContent }],
        contextWindowSize
      );
      if (!assembly.fits) {
        return failure(
          "context-window-exceeded",
          `irreducible prompt ~${assembly.estimatedPromptTokens} tokens over budget ` +
            `${assembly.budgetTokens} (window ${contextWindowSize})`
        );
      }

      generationCount += 1;
      try {
        const messages = assembly.messages as ChatCompletionMessageParam[];
        const request: Record<string, unknown> = { stream: true, messages };
        if (req.maxTokens != null && req.maxTokens > 0) request.max_tokens = req.maxTokens;
        if (req.includeUsage) request.stream_options = { include_usage: true };
        const remaining = () => TURN_CEILING_MS - (Date.now() - turnStartedAt);
        const startBudget = Math.max(1, Math.min(GENERATION_IDLE_TIMEOUT_MS, remaining()));
        const chunks = (await withDeadline(
          engine.chat.completions.create(
            request as unknown as Parameters<typeof engine.chat.completions.create>[0]
          ) as Promise<AsyncIterable<ChatCompletionChunk>>,
          startBudget,
          "generation-start-timeout"
        )) as AsyncIterable<ChatCompletionChunk>;

        const interrupt = () => {
          try {
            engine.interruptGenerate();
          } catch {
            // Best-effort.
          }
        };

        let full = "";
        let completionTokens: number | null = null;
        const iterator = chunks[Symbol.asyncIterator]();
        for (;;) {
          if (req.signal?.aborted) {
            interrupt();
            return failure("aborted");
          }
          const budget = remaining();
          if (budget <= 0) {
            interrupt();
            return failure("turn-ceiling-exceeded");
          }
          // Idle window per chunk, additionally capped by what's left of the
          // whole-turn ceiling - a stream that keeps trickling chunks can't
          // outlive the 120s wall clock.
          const idleMs = Math.min(GENERATION_IDLE_TIMEOUT_MS, budget);
          let result: IteratorResult<ChatCompletionChunk>;
          try {
            result = await withDeadline(iterator.next(), idleMs, "generation-idle-timeout");
          } catch (err) {
            interrupt();
            if (err instanceof Error && err.message === "generation-idle-timeout") {
              return remaining() <= 0
                ? failure("turn-ceiling-exceeded")
                : failure("generation-timeout", "no new tokens within the idle window");
            }
            return mapThrown(err, "generation-failed");
          }
          if (result.done) break;
          // With include_usage the final chunk carries usage and no choices.
          const reported = result.value.usage?.completion_tokens;
          if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
            completionTokens = reported;
          }
          const delta = result.value.choices?.[0]?.delta?.content;
          if (!delta) continue;
          full += delta;
          if (onDelta) {
            try {
              onDelta(delta);
            } catch {
              // A broken listener never breaks the stream.
            }
          }
        }
        if (req.signal?.aborted) {
          interrupt();
          return failure("aborted");
        }
        if (!full.trim()) return failure("empty-reply");
        return {
          ok: true,
          text: full,
          modelId: model.id,
          backend: "webllm",
          ...(completionTokens != null ? { usage: { completionTokens } } : {}),
        };
      } catch (err) {
        return mapThrown(err, "generation-failed");
      } finally {
        generationCount = Math.max(0, generationCount - 1);
        scheduleIdleTeardown();
      }
    } catch (err) {
      // Belt-and-braces - the absolute never-throw contract.
      return mapThrown(err, "generation-failed");
    }
  }

  // --- download (explicit gesture only) -------------------------------------

  async function hasStorageHeadroomFor(bytes: number): Promise<boolean> {
    try {
      if (typeof navigator === "undefined" || !navigator.storage?.estimate) return true;
      const { quota, usage } = await navigator.storage.estimate();
      if (typeof quota !== "number" || typeof usage !== "number") return true;
      return quota - usage > bytes * 1.2;
    } catch {
      return true;
    }
  }

  async function download(modelId?: string): Promise<WebLlmDownloadResult> {
    try {
      const caps = await detectCapabilities();
      if (!caps.webgpu.available) {
        return { ok: false, code: "unsupported", detail: "WebGPU unavailable" };
      }
      const manifest = await fetchManifest(host);
      const tier1Models = manifest.models.filter((m) => m.tier === 1);
      let model: ManifestModel | null = null;
      if (modelId) {
        model = tier1Models.find((m) => m.id === modelId) || null;
      } else {
        // Suggest the lightest useful model; the person can upgrade later.
        const selection = selectBestModel({ ...manifest, models: tier1Models }, caps, "auto");
        model = selection.kind === "model" ? selection.model : null;
      }
      if (!model) {
        return { ok: false, code: "no-model", detail: "no matching model in the manifest" };
      }
      if (!(await hasStorageHeadroomFor(model.sizeBytes))) {
        pushStatus({ state: "idle", modelId: null, detail: "not enough free storage" });
        return { ok: false, code: "no-storage", detail: "insufficient storage quota" };
      }
      pushStatus({ state: "loading", progress: 0, modelId: model.id });
      try {
        // Deliberately UNBOUNDED - a legitimate multi-GB first download must
        // not be failed over by the 60s turn-facing acquire deadline.
        await acquireEngine(model);
        host.kv.set(CACHED_KEY_PREFIX + model.id, "1");
        weightPresence.set(model.id, Promise.resolve(true));
        // Ask the browser to protect the weights from cache eviction.
        try {
          void navigator.storage?.persist?.();
        } catch {
          // Best-effort.
        }
        return { ok: true, model };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        pushStatus({ state: "idle", modelId: null, detail: "download failed" });
        return { ok: false, code: "failed", detail };
      }
    } catch (err) {
      return { ok: false, code: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- model list / delete (picker surface) ---------------------------------

  async function listModels(): Promise<WebLlmModelList> {
    const override = getStoredModelOverride(host);
    try {
      const caps = await detectCapabilities();
      const manifest = await fetchManifest(host);
      const tier1Models = manifest.models.filter((m) => m.tier === 1);
      const auto = caps.webgpu.available
        ? selectBestModel({ ...manifest, models: tier1Models }, caps, "auto")
        : null;
      const recommendedId = auto?.kind === "model" ? auto.model?.id ?? null : null;
      const models: WebLlmModelInfo[] = [];
      for (const model of tier1Models) {
        // Sequential on purpose - readiness is memoized per model and
        // marker-less models answer without touching the Cache API.
        const downloaded = await isModelReady(model.id);
        models.push({
          id: model.id,
          displayName: model.displayName,
          detailName: model.detailName ?? null,
          sizeBytes: model.sizeBytes,
          speedTier: model.speedTier ?? null,
          contextWindowSize: model.contextWindowSize ?? null,
          fits: modelFits(model, caps),
          downloaded,
          recommended: model.id === recommendedId,
        });
      }
      // Downloaded first, then recommended, then smallest-first: the row a
      // person can act on right now is always at the top.
      models.sort((a, b) => {
        if (a.downloaded !== b.downloaded) return a.downloaded ? -1 : 1;
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return a.sizeBytes - b.sizeBytes;
      });
      return { webgpu: caps.webgpu.available, models, override };
    } catch {
      return { webgpu: false, models: [], override };
    }
  }

  async function deleteModel(modelId: string): Promise<void> {
    try {
      if (engineModelId === modelId && engineInstance && !engineInFlight) {
        await waitForGenerationsIdle();
        const instance = engineInstance;
        engineInstance = null;
        engineModelId = null;
        try {
          await instance.unload();
        } catch {
          // Best-effort.
        }
      }
      await purgeModelWeights(host.kv, modelId);
      weightPresence.delete(modelId);
      // The next probe re-derives readiness from what is actually left.
      pushStatus({ state: "idle", modelId: null, detail: "model deleted" });
    } catch {
      // Never rejects.
    }
  }

  // --- probe / status --------------------------------------------------------

  async function probe(): Promise<boolean> {
    try {
      if (typeof navigator === "undefined") return false;
      if (!getEdgeOptIn(host)) {
        pushStatus({ state: "unavailable", detail: "on-device turned off" });
        return false;
      }
      if (getStoredModelOverride(host) === "hosted") {
        pushStatus({ state: "unavailable", detail: "pinned to hosted" });
        return false;
      }
      const caps = await detectCapabilities();
      if (!caps.webgpu.available) {
        pushStatus({ state: "unavailable", detail: "no WebGPU in this host" });
        return false;
      }
      const model = await pickReadyModel(caps);
      if (!model) {
        // WebGPU works but nothing is downloaded - "idle" so the UI can offer
        // the explicit download gesture.
        pushStatus({ state: "idle", modelId: null, detail: "no model downloaded yet" });
        return false;
      }
      if (status.state !== "ready" || status.modelId !== model.id) {
        pushStatus({ state: "ready", modelId: model.id });
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    id: "webllm",
    probe,
    status: () => status,
    generate,
    download,
    listModels,
    deleteModel,
  };
}
