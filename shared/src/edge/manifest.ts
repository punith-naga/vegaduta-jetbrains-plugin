// Ported from web/app/lib/edge/tier1.ts (fetchTier1Manifest +
// BUILTIN_FALLBACK_MANIFEST). Fetches the edge model manifest from the
// injected host's API base with the same never-rejects contract: 8s timeout,
// tolerant normalization, and the built-in fallback list below when the
// endpoint 404s / times out / drifts.

import type { ModelManifest } from "./capabilities";
import { normalizeManifest } from "./capabilities";
import type { EdgeHost } from "./host";

/**
 * KEEP IN SYNC WITH THE SERVER SEED (EdgeAgentsConfigController's
 * DEFAULT_MANIFEST) and with web/app/lib/edge/tier1.ts's
 * BUILTIN_FALLBACK_MANIFEST - this is a verbatim copy of that constant
 * (2026-08-09): same model ids, sizes, floors and context windows, none of
 * them invented here. Every id is a valid @mlc-ai/web-llm@0.2.84
 * prebuiltAppConfig model_id (verified against the installed package by the
 * original). Used ONLY when GET /api/edge/manifest can't answer.
 */
export const BUILTIN_FALLBACK_MANIFEST: ModelManifest = {
  version: "builtin-fallback-1",
  models: [
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
    },
    {
      id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      displayName: "On-device model — balanced",
      detailName:
        "Qwen2.5 1.5B Instruct (q4f16), about 1.6 GB. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 1_629_750_000,
      minDeviceMemoryGB: 4,
      minMaxBufferSize: 0,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "fast",
      contextWindowSize: 4096,
    },
    {
      id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      displayName: "On-device model — compact",
      detailName:
        "Llama 3.2 1B Instruct (q4f16), about 0.9 GB. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 879_040_000,
      minDeviceMemoryGB: 4,
      minMaxBufferSize: 0,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "fast",
      contextWindowSize: 4096,
    },
    {
      id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
      displayName: "On-device model — most capable",
      detailName:
        "Phi 3.5 Mini Instruct (q4f16), about 3.7 GB. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 3_672_070_000,
      minDeviceMemoryGB: 8,
      minMaxBufferSize: 1_073_741_824,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "capable",
      contextWindowSize: 4096,
    },
    {
      id: "gemma-2-2b-it-q4f16_1-MLC",
      displayName: "On-device model — efficient",
      detailName:
        "Gemma 2 2B Instruct (q4f16), about 1.9 GB. Downloaded from the public MLC/WebLLM model CDN.",
      sizeBytes: 1_895_300_000,
      minDeviceMemoryGB: 4,
      minMaxBufferSize: 0,
      tier: 1,
      url: null,
      sha256: null,
      speedTier: "fast",
      contextWindowSize: 4096,
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
