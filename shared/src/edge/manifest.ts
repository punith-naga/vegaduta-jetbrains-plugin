// Ported from web/app/lib/edge/tier1.ts (fetchTier1Manifest +
// BUILTIN_FALLBACK_MANIFEST). Fetches the edge model manifest from the
// injected host's API base with the same never-rejects contract: 8s timeout,
// tolerant normalization, and the built-in fallback list below when the
// endpoint 404s / times out / drifts.

import type { ModelManifest } from "./capabilities";
import { normalizeManifest } from "./capabilities";
import type { EdgeHost } from "./host";

/**
 * The catalog the plugins offer when `GET /api/edge/manifest` cannot answer
 * (404 / timeout / unusable body). A served manifest always wins.
 *
 * Every id, `sizeBytes` and `contextWindowSize` here is VERBATIM from the
 * installed `@mlc-ai/web-llm@0.2.84` package's own `prebuiltAppConfig`
 * (`sizeBytes` = `vram_required_MB * 1e6`, re-extract on an engine upgrade) -
 * the same never-guess rule the server manifest follows. An id the installed
 * engine does not serve cannot be downloaded by any code path, so nothing
 * aspirational belongs in this list.
 *
 * `minDeviceMemoryGB` follows the server's vram tiers (4 GB under ~2 GB of
 * weights, 8 GB under ~4 GB, 16 GB above) and `minMaxBufferSize` is set to
 * 1 GiB for anything that needs a large single allocation. Both are floors
 * for AUTO-selection only - a person can still pin a model that does not
 * fit, and is told it may not.
 *
 * What the list is FOR, and why it is not the server's three-model seed: these
 * are IDE and browser plugins, so the catalog leads with code-trained models
 * (`useCases: ["code"]`) that the selector prefers for completions, fix and
 * refactor, and carries a real spread of sizes so a laptop and a workstation
 * each get something that actually runs. Keep it broadly in step with
 * `EdgeAgentsConfigController.DEFAULT_MANIFEST` + `REGISTRY_CATALOG`.
 */
export const BUILTIN_FALLBACK_MANIFEST: ModelManifest = {
  version: "builtin-fallback-2",
  models: [
    // --- code-trained: what an IDE plugin should reach for first ----------
    {
      id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
      displayName: "On-device coder — light",
      detailName:
        "Qwen2.5 Coder 1.5B Instruct (q4f16), about 1.6 GB. Code-trained: completions, fix and refactor. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 1_629_750_000,
      minDeviceMemoryGB: 4,
      minMaxBufferSize: 0,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "fast",
      contextWindowSize: 4096,
      useCases: ["code", "chat"],
    },
    {
      id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
      displayName: "On-device coder — balanced",
      detailName:
        "Qwen2.5 Coder 3B Instruct (q4f16), about 2.5 GB. The best code quality per gigabyte in this catalog. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 2_504_760_000,
      minDeviceMemoryGB: 8,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["code", "chat"],
    },
    {
      id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC",
      displayName: "On-device coder — high quality",
      detailName:
        "Qwen2.5 Coder 7B Instruct (q4f16), about 5.1 GB. Needs a large GPU. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 5_106_670_000,
      minDeviceMemoryGB: 16,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["code", "chat"],
    },

    // --- general chat, smallest first -------------------------------------
    {
      id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      displayName: "On-device model — lightest",
      detailName:
        "Llama 3.2 1B Instruct (q4f16), about 0.9 GB. The quickest thing here that still answers usefully. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 879_040_000,
      minDeviceMemoryGB: 4,
      minMaxBufferSize: 0,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "fast",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
    {
      id: "Qwen3-1.7B-q4f16_1-MLC",
      displayName: "On-device model — balanced",
      detailName:
        "Qwen3 1.7B (q4f16), about 2.0 GB. Newer generation than the 1B; better at instructions and multi-step answers. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 2_036_660_000,
      minDeviceMemoryGB: 4,
      minMaxBufferSize: 0,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "fast",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
    {
      id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
      displayName: "On-device model — larger",
      detailName:
        "Llama 3.2 3B Instruct (q4f16), about 2.3 GB. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 2_263_690_000,
      minDeviceMemoryGB: 8,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
    {
      id: "Qwen3-4B-q4f16_1-MLC",
      displayName: "On-device model — capable",
      detailName:
        "Qwen3 4B (q4f16), about 3.4 GB. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 3_431_590_000,
      minDeviceMemoryGB: 8,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
    {
      id: "Phi-4-mini-instruct-q4f16_1-MLC",
      displayName: "On-device model — latest generation",
      detailName:
        "Phi 4 Mini Instruct (q4f16), about 3.4 GB. Strong reasoning for its size. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 3_437_580_000,
      minDeviceMemoryGB: 8,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
    {
      id: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
      displayName: "On-device model — high quality",
      detailName:
        "Llama 3.1 8B Instruct (q4f16), about 5.0 GB. Needs a large GPU. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 5_001_000_000,
      minDeviceMemoryGB: 16,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
    {
      id: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
      displayName: "On-device model — reasoning",
      detailName:
        "DeepSeek R1 Distill Qwen 7B (q4f16), about 5.1 GB. Thinks step by step; slower per answer. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 5_106_670_000,
      minDeviceMemoryGB: 16,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
      useCases: ["chat"],
    },
  ],
};

const MANIFEST_FETCH_TIMEOUT_MS = 8_000;

/** One resolved manifest per API base per page - the plugins never talk to
 * two platforms at once, but keying by origin keeps a settings-time
 * environment switch honest. */
const manifestCache = new Map<string, ModelManifest>();
const manifestInFlight = new Map<string, Promise<ModelManifest>>();

/**
 * The edge model manifest: one GET {apiBase}/api/edge/manifest per page,
 * falling back to BUILTIN_FALLBACK_MANIFEST on 404/timeout/network failure/
 * unusable payload. Unauthenticated on purpose - the endpoint is permitAll
 * server-side, and the manifest must be readable before sign-in so the model
 * picker can render. Never rejects.
 */
export function fetchManifest(host: EdgeHost): Promise<ModelManifest> {
  const key = host.apiBase;
  const cached = manifestCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = manifestInFlight.get(key);
  if (inFlight) return inFlight;
  const load = (async (): Promise<ModelManifest> => {
    let manifest: ModelManifest = BUILTIN_FALLBACK_MANIFEST;
    try {
      if (typeof fetch !== "undefined") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(new URL("/api/edge/manifest", host.apiBase).toString(), {
            signal: controller.signal,
          });
          if (res.ok) {
            const normalized = normalizeManifest(await res.json());
            if (normalized && normalized.models.length > 0) manifest = normalized;
          }
          // 404 / any other status → keep the built-in fallback.
        } finally {
          clearTimeout(timer);
        }
      }
    } catch {
      // Network failure / timeout → built-in fallback.
    }
    manifestCache.set(key, manifest);
    return manifest;
  })().finally(() => {
    manifestInFlight.delete(key);
  });
  manifestInFlight.set(key, load);
  return load;
}

/** Test/session hook - drop the cached manifest (e.g. after an environment
 * switch in plugin settings) so the next fetch re-asks the server. */
export function resetManifestCache(): void {
  manifestCache.clear();
  manifestInFlight.clear();
}
