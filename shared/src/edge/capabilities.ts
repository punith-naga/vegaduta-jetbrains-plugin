// Ported from web/app/lib/edge/capabilities.ts (the battle-tested original) -
// capability detection, the canonical manifest wire types with tolerant
// normalization, the data-driven modelFits check, and speed-tier-aware
// best-fit model selection. Adapted for the plugin hosts: preferences read an
// injected EdgeHost.kv instead of raw localStorage, the detection cache is
// module-scoped in memory (a webview page IS the session), and the web-only
// pieces (tier0/Prompt API, activity observable, fallback-label copy, the
// NEXT_PUBLIC_EDGE_AGENTS build gate) are deliberately not ported.

import type { EdgeHost } from "./host";

// ---------------------------------------------------------------------------
// Preference keys (same names as web so nothing new to learn/document)
// ---------------------------------------------------------------------------

/** kv - "1"/"0" once the person explicitly enabled/disabled on-device
 * inference. UNSET reads as ON: local-first is the plugins' product thesis,
 * and nothing downloads or runs without a further explicit gesture anyway. */
export const EDGE_OPT_IN_KEY = "edge.optIn";
/** kv - the model pick: "auto" | manifest model id | "hosted". A stored value
 * ALWAYS wins over auto-scoring (binding rule carried over from web). */
export const MODEL_OVERRIDE_KEY = "edge.modelOverride";

export function getEdgeOptIn(host: EdgeHost): boolean {
  return host.kv.get(EDGE_OPT_IN_KEY) !== "0";
}

export function setEdgeOptIn(host: EdgeHost, on: boolean): void {
  host.kv.set(EDGE_OPT_IN_KEY, on ? "1" : "0");
}

export type ModelOverride = "auto" | "hosted" | string; // string = manifest model id

export function getStoredModelOverride(host: EdgeHost): ModelOverride {
  return host.kv.get(MODEL_OVERRIDE_KEY) || "auto";
}

export function setModelOverride(host: EdgeHost, value: ModelOverride): void {
  host.kv.set(MODEL_OVERRIDE_KEY, value);
}

// ---------------------------------------------------------------------------
// Capability detection - one pass per page, cached in memory
// ---------------------------------------------------------------------------

export interface EdgeCapabilities {
  webgpu: {
    available: boolean;
    /** adapter.limits.maxBufferSize - what the manifest's minMaxBufferSize
     * requirement is compared against. */
    maxBufferSize: number | null;
    maxStorageBufferBindingSize: number | null;
  };
  /** navigator.deviceMemory (Chromium-only; null elsewhere - modelFits treats
   * unknown as passing, the graceful-degradation contract from web). */
  deviceMemoryGB: number | null;
  hardwareConcurrency: number | null;
}

function emptyCapabilities(): EdgeCapabilities {
  return {
    webgpu: { available: false, maxBufferSize: null, maxStorageBufferBindingSize: null },
    deviceMemoryGB: null,
    hardwareConcurrency: null,
  };
}

let capsCache: EdgeCapabilities | null = null;
let capsInFlight: Promise<EdgeCapabilities> | null = null;

/**
 * The one detection pass (WebGPU adapter probe + deviceMemory). Never
 * rejects: an environment with nothing available (JCEF without WebGPU, a
 * worker without navigator.gpu) resolves to an all-false result, which the
 * WebLLM backend maps to a typed "unsupported" probe answer.
 */
export function detectCapabilities(force = false): Promise<EdgeCapabilities> {
  if (!force) {
    if (capsCache) return Promise.resolve(capsCache);
    if (capsInFlight) return capsInFlight;
  }
  capsInFlight = runDetection()
    .then((caps) => {
      capsCache = caps;
      return caps;
    })
    .finally(() => {
      capsInFlight = null;
    });
  return capsInFlight;
}

async function runDetection(): Promise<EdgeCapabilities> {
  const caps = emptyCapabilities();
  if (typeof navigator === "undefined") return caps;
  const nav = navigator as unknown as {
    gpu?: { requestAdapter?: () => Promise<unknown> };
    deviceMemory?: unknown;
    hardwareConcurrency?: unknown;
  };
  try {
    if (nav.gpu?.requestAdapter) {
      const adapter = (await nav.gpu.requestAdapter()) as {
        limits?: { maxBufferSize?: unknown; maxStorageBufferBindingSize?: unknown };
      } | null;
      if (adapter) {
        const limits = adapter.limits || {};
        caps.webgpu = {
          available: true,
          maxBufferSize: Number(limits.maxBufferSize) || null,
          maxStorageBufferBindingSize: Number(limits.maxStorageBufferBindingSize) || null,
        };
      }
    }
  } catch {
    // No WebGPU - the WebLLM backend simply never probes true.
  }
  caps.deviceMemoryGB = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
  caps.hardwareConcurrency =
    typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null;
  return caps;
}

// ---------------------------------------------------------------------------
// Manifest wire contract + tolerant normalization (verbatim port)
// ---------------------------------------------------------------------------

/** One acquirable on-device asset as published by GET /api/edge/manifest.
 * Field-for-field match with the server's EdgeModelEntry and web's canonical
 * type - `version` is a STRING, `tier` a NUMBER, the memory floor spelled
 * `minDeviceMemoryGB`, `url`/`sha256` nullable. Never consume a raw manifest
 * body directly - go through normalizeManifest below. */
export interface ManifestModel {
  id: string;
  /** Brand-first consumer-facing name - never a raw model name. */
  displayName: string;
  /** Details-panel-only raw model identity + provenance. */
  detailName?: string | null;
  sizeBytes: number;
  /** Minimum navigator.deviceMemory (GB) to auto-select. 0 = no floor. */
  minDeviceMemoryGB: number;
  /** Minimum WebGPU adapter maxBufferSize. 0 = no floor. */
  minMaxBufferSize: number;
  /** 0 = browser built-in (unused here), 1 = WebLLM/WebGPU, 2 = WASM. */
  tier: 0 | 1 | 2;
  url?: string | null;
  sha256?: string | null;
  /** "fast" = small/quick default pick; "capable" = bigger, picked for
   * complex turns. Optional and tolerant - untagged manifests degrade to
   * biggest-fitting-wins (see selectBestModel). */
  speedTier?: "fast" | "capable";
  /** Context window in tokens, admin-overridable server-side. null = unknown;
   * the WebLLM backend then falls back to the installed engine record, else a
   * conservative 4096. */
  contextWindowSize?: number | null;
  /** What this model is TRAINED for, when the catalog knows. "code" marks a
   * code-trained model (Qwen2.5-Coder and friends): in an IDE/browser plugin
   * a 3B coder beats a 7B generalist at completions, fix and refactor, and
   * that is a selection fact, not a label. Optional and tolerant - a manifest
   * that carries none (every server manifest predating this field) degrades
   * to the previous size/speed-only rules, unchanged. */
  useCases?: ModelUseCase[];
}

/** Task classes the selector can match a model to. "chat" is the default
 * everything falls back to; "code" is the completions / fix / refactor path. */
export type ModelUseCase = "chat" | "code";

export interface ModelManifest {
  version: string;
  models: ManifestModel[];
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function coerceSpeedTier(v: unknown): "fast" | "capable" | undefined {
  return v === "fast" || v === "capable" ? v : undefined;
}

function coerceContextWindowSize(v: unknown): number | null {
  const n = coerceNumber(v);
  if (n === null) return null;
  const whole = Math.trunc(n);
  return whole > 0 ? whole : null;
}

function coerceTier(v: unknown): 0 | 1 | 2 | null {
  if (v === 0 || v === 1 || v === 2) return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = Math.trunc(v);
    return n === 0 || n === 1 || n === 2 ? (n as 0 | 1 | 2) : null;
  }
  if (typeof v === "string") {
    const m = /^\s*(?:tier[\s_-]*)?([0-2])\s*$/i.exec(v);
    if (m) return Number(m[1]) as 0 | 1 | 2;
  }
  return null;
}

/** Ids whose model IS code-trained, by name, when the manifest does not say
 * so itself. Server manifests predate `useCases`, so without this every
 * catalog served today would look use-case-less and the code path would lose
 * the coder model it can see in the list. Matching is on the published model
 * family in the id - the same verbatim-ids rule the rest of this layer uses,
 * never a guess about an id the engine does not serve. */
const CODE_MODEL_ID_PATTERN = /(^|[-_])(qwen[\d.]*-coder|coder|codellama|codegemma|starcoder|deepseek-coder)/i;

/** Tolerant use-case read: an explicit array wins, a single string is
 * accepted, anything unusable falls back to the id-derived answer. Every
 * model is usable for chat, so "chat" is always present. */
function coerceUseCases(raw: unknown, id: string): ModelUseCase[] {
  const out = new Set<ModelUseCase>();
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const v of values) {
    if (v === "code" || v === "chat") out.add(v);
  }
  if (out.size === 0 && CODE_MODEL_ID_PATTERN.test(id)) out.add("code");
  out.add("chat");
  return [...out];
}

/**
 * Coerce a raw /api/edge/manifest payload into the canonical ModelManifest,
 * or null when it isn't manifest-shaped at all. Schema drift must DEGRADE,
 * never silently empty the model list (the original bug this guards against
 * was a server sending tier:"tier1" strings, emptying every tier filter).
 * Entries without a usable id or tier are dropped, never guessed.
 */
export function normalizeManifest(raw: unknown): ModelManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const listRaw = Array.isArray(obj.models)
    ? obj.models
    : Array.isArray(obj.assets)
      ? obj.assets
      : Array.isArray(obj.entries)
        ? obj.entries
        : null;
  if (!listRaw) return null;
  const models: ManifestModel[] = [];
  for (const entry of listRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = coerceString(e.id) ?? coerceString(e.modelId) ?? coerceString(e.model_id);
    if (!id) continue;
    const tier = coerceTier(e.tier);
    if (tier === null) continue;
    models.push({
      id,
      displayName: coerceString(e.displayName) ?? coerceString(e.display_name) ?? id,
      detailName: coerceString(e.detailName) ?? coerceString(e.detail_name),
      sizeBytes: coerceNumber(e.sizeBytes ?? e.size_bytes) ?? 0,
      minDeviceMemoryGB:
        coerceNumber(e.minDeviceMemoryGB ?? e.minDeviceMemoryGb ?? e.min_device_memory_gb) ?? 0,
      minMaxBufferSize: coerceNumber(e.minMaxBufferSize ?? e.min_max_buffer_size) ?? 0,
      tier,
      url: coerceString(e.url),
      sha256: coerceString(e.sha256),
      speedTier: coerceSpeedTier(e.speedTier ?? e.speed_tier),
      contextWindowSize: coerceContextWindowSize(e.contextWindowSize ?? e.context_window_size),
      useCases: coerceUseCases(e.useCases ?? e.use_cases, id),
    });
  }
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "string" && versionRaw
      ? versionRaw
      : typeof versionRaw === "number" && Number.isFinite(versionRaw)
        ? String(versionRaw)
        : "unknown";
  return { version, models };
}

// ---------------------------------------------------------------------------
// Fit + selection (verbatim port of the rules; kv override injected)
// ---------------------------------------------------------------------------

/** The context window every MLC prebuilt in the served catalog ships with. A
 * manifest window at/below this changes nothing about device fit; only a
 * RAISED window grows the KV cache past the published memory floors. */
export const WEBLLM_BASELINE_CONTEXT_WINDOW = 4096;

/** Data-driven "does this model fit this device" check. Unknown deviceMemory
 * passes (Firefox/Safari); a raised context window scales the memory floor by
 * the window ratio - deliberately over-requiring, erring toward "refuse to
 * auto-select" rather than a mid-turn GPU OOM. */
export function modelFits(model: ManifestModel, caps: EdgeCapabilities): boolean {
  const windowScale =
    model.tier === 1 &&
    model.contextWindowSize != null &&
    model.contextWindowSize > WEBLLM_BASELINE_CONTEXT_WINDOW
      ? model.contextWindowSize / WEBLLM_BASELINE_CONTEXT_WINDOW
      : 1;
  if (model.tier === 1) {
    if (!caps.webgpu.available) return false;
    if (model.minMaxBufferSize > 0 && (caps.webgpu.maxBufferSize ?? 0) < model.minMaxBufferSize) {
      return false;
    }
  }
  if (
    model.minDeviceMemoryGB > 0 &&
    caps.deviceMemoryGB != null &&
    caps.deviceMemoryGB < model.minDeviceMemoryGB * windowScale
  ) {
    return false;
  }
  return true;
}

export type TurnComplexity = "simple" | "complex";

export interface ModelSelection {
  /** "user" when a stored override decided; "auto" when device scoring did. */
  source: "user" | "auto";
  kind: "model" | "hosted";
  model: ManifestModel | null;
  /** Whether the device meets the chosen model's requirements. A user may
   * force a model that doesn't fit (informational, never a block). */
  fits: boolean;
}

/**
 * Best-fit selection, same binding rules as web:
 * - a stored user override ALWAYS wins ("hosted" pins hosted, an id pins that
 *   model even if it doesn't fit - fits:false is informational);
 * - auto mode is speed-tier aware: "simple" (default - completions and quick
 *   actions are short turns) picks the SMALLEST "fast" model, "complex"
 *   escalates to the BIGGEST "capable" one;
 * - no speedTier tags anywhere → the legacy biggest-fitting-wins rule;
 * - nothing fits → hosted.
 */
export function selectBestModel(
  manifest: ModelManifest | null,
  caps: EdgeCapabilities,
  userOverride?: ModelOverride | null,
  turnComplexity: TurnComplexity = "simple",
  /** What the turn is: "code" restricts auto-selection to code-trained models
   * when the catalog has one that fits (a 3B coder beats a 7B generalist at
   * completions/fix/refactor), and falls through to the normal rules when it
   * does not. A user pin still always wins. */
  useCase: ModelUseCase = "chat"
): ModelSelection {
  const override = userOverride ?? "auto";
  if (override === "hosted") {
    return { source: "user", kind: "hosted", model: null, fits: true };
  }
  if (override && override !== "auto") {
    const pinned = manifest?.models.find((m) => m.id === override) || null;
    if (pinned) {
      return { source: "user", kind: "model", model: pinned, fits: modelFits(pinned, caps) };
    }
    // Pinned model vanished from the manifest - fall back to auto scoring.
  }
  const allFitting = (manifest?.models || []).filter((m) => modelFits(m, caps));
  // Code turns prefer code-trained models, but never at the cost of having
  // NO model: an empty coder set falls straight through to the full list.
  const specialised =
    useCase === "code" ? allFitting.filter((m) => m.useCases?.includes("code")) : [];
  const fitting = specialised.length > 0 ? specialised : allFitting;
  if (fitting.length === 0) {
    return { source: "auto", kind: "hosted", model: null, fits: true };
  }
  const tagged = fitting.filter((m) => m.speedTier === "fast" || m.speedTier === "capable");
  if (tagged.length === 0) {
    const biggest = [...fitting].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    return { source: "auto", kind: "model", model: biggest, fits: true };
  }
  if (turnComplexity === "complex") {
    const capable = tagged
      .filter((m) => m.speedTier === "capable")
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    const pick = capable[0] ?? [...tagged].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    return { source: "auto", kind: "model", model: pick, fits: true };
  }
  const fast = tagged
    .filter((m) => m.speedTier === "fast")
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
  const pick = fast[0] ?? [...tagged].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
  return { source: "auto", kind: "model", model: pick, fits: true };
}
