// Machine Check - time one short, fixed generation on a LocalEngine and turn
// the numbers into a plain-language verdict plus a model recommendation.
//
// Pure edge-layer logic over the LocalEngine seam: no DOM, no protocol, no
// network of its own. The only I/O is engine.generate() on the engine the
// caller hands in (WebLLM on-device, or the user's own local server) - it
// never downloads weights and never talks to the hosted platform, so it is
// allowed in Private Mode. Never throws: every failure is a typed result.

import {
  modelFits,
  selectBestModel,
  type EdgeCapabilities,
  type ManifestModel,
  type ModelManifest,
  type ModelUseCase,
} from "./capabilities";
import type { LocalEngine } from "./engine";
import { estimateLocalTokens } from "./webllmEngine";

/** Whole-run ceiling. A model that cannot write 60 words in 30 s is measured
 * on what it produced so far (if anything) rather than waited on. */
export const BENCHMARK_CEILING_MS = 30_000;

/** Enough output for a stable tokens/second reading (~80 tokens for 60
 * words) with headroom, but short enough to finish in seconds. */
export const BENCHMARK_MAX_TOKENS = 160;

/** Fixed prompt so runs are comparable across models and machines. Carries
 * none of the user's content. */
export const BENCHMARK_SYSTEM_PROMPT = "You are a concise technical writer.";
export const BENCHMARK_PROMPT =
  "Write one paragraph of about 60 words explaining what a unit test is and why developers write them. Plain prose, no lists, no code.";

/** Throughput bands (generated tokens per second). */
export const TPS_FAST = 30;
export const TPS_GOOD = 12;
export const TPS_SLOW = 8;

export type MeasureFailureReason = "generation-failed" | "aborted";

export interface EngineMeasurement {
  ok: true;
  backend: string;
  modelId: string | null;
  firstTokenMs: number;
  tokensPerSecond: number;
  /** True when tokens were estimated from characters (chars/3.5) because
   * the engine reported no usage. */
  estimated: boolean;
  /** True when the 30 s ceiling cut the run short and the numbers come from
   * the partial output. */
  partial: boolean;
}

export type MeasureResult = EngineMeasurement | { ok: false; reason: MeasureFailureReason };

export interface MeasureOptions {
  /** Caller cancellation (engineHost.abort of the benchmark request id). */
  signal?: AbortSignal;
  ceilingMs?: number;
  /** Clock seam for tests; defaults to performance.now / Date.now. */
  now?: () => number;
}

function defaultNow(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    // Fall through.
  }
  return Date.now();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Run the fixed prompt once and measure first-token latency and throughput
 * from the onDelta timings. Never throws.
 *
 * Throughput is the decode rate: (tokens - 1) / (last delta - first delta),
 * which excludes prompt processing and model warm-up (those show up in
 * firstTokenMs instead). When the engine delivered its output as a single
 * chunk there is no decode window, so it falls back to tokens / whole run.
 */
export async function measureEngine(engine: LocalEngine, opts: MeasureOptions = {}): Promise<MeasureResult> {
  const now = opts.now ?? defaultNow;
  const ceilingMs = opts.ceilingMs ?? BENCHMARK_CEILING_MS;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  let ceilingHit = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    opts.signal?.addEventListener("abort", onCallerAbort);
    timer = setTimeout(() => {
      ceilingHit = true;
      controller.abort();
    }, ceilingMs);

    const startedAt = now();
    let firstAt: number | null = null;
    let lastAt: number | null = null;
    let deltaCount = 0;
    let streamed = "";
    const result = await engine.generate(
      {
        system: BENCHMARK_SYSTEM_PROMPT,
        prompt: BENCHMARK_PROMPT,
        useCase: "chat",
        maxTokens: BENCHMARK_MAX_TOKENS,
        includeUsage: true,
        signal: controller.signal,
      },
      (delta) => {
        const t = now();
        if (firstAt === null) firstAt = t;
        lastAt = t;
        deltaCount += 1;
        streamed += delta;
      }
    );
    const endedAt = now();

    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };

    let text: string;
    let partial = false;
    let reportedTokens: number | null = null;
    let modelId: string | null = null;
    if (result.ok) {
      text = result.text;
      modelId = result.modelId ?? null;
      if (result.usage && result.usage.completionTokens > 0) {
        reportedTokens = result.usage.completionTokens;
      }
    } else if (
      streamed.trim() &&
      (ceilingHit ||
        result.reason === "turn-ceiling-exceeded" ||
        result.reason === "generation-timeout")
    ) {
      // Too slow to finish inside the ceiling, but it did produce tokens -
      // that IS the measurement ("slow"), not a failure.
      text = streamed;
      partial = true;
    } else {
      return { ok: false, reason: "generation-failed" };
    }
    if (!text.trim()) return { ok: false, reason: "generation-failed" };

    const estimated = reportedTokens === null;
    const tokens = reportedTokens ?? estimateLocalTokens(text);
    // A non-streaming engine gives no first-delta time: the whole reply
    // arrived at the end.
    const first = firstAt ?? endedAt;
    const last = lastAt ?? endedAt;
    const decodeMs = last - first;
    let tokensPerSecond: number;
    if (deltaCount > 1 && tokens > 1 && decodeMs >= 50) {
      tokensPerSecond = (tokens - 1) / (decodeMs / 1000);
    } else {
      tokensPerSecond = tokens / (Math.max(1, endedAt - startedAt) / 1000);
    }
    return {
      ok: true,
      backend: engine.id,
      modelId,
      firstTokenMs: Math.max(0, Math.round(first - startedAt)),
      tokensPerSecond: round1(tokensPerSecond),
      estimated,
      partial,
    };
  } catch {
    return { ok: false, reason: opts.signal?.aborted ? "aborted" : "generation-failed" };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Plain-language verdict for a throughput reading. */
export function verdictFor(tokensPerSecond: number): string {
  if (tokensPerSecond >= TPS_FAST) return "Fast enough for inline completions and chat.";
  if (tokensPerSecond >= TPS_GOOD) return "Good for chat; inline completions may feel a little behind your typing.";
  if (tokensPerSecond >= TPS_SLOW) return "Usable for chat, but longer answers will take a while.";
  return "Slow on this machine - a smaller model will feel better.";
}

/**
 * A manifest model worth trying instead of the one just measured, or null
 * when the current one is the right size for this device.
 *
 * - slow (< TPS_SLOW): a SMALLER model that fits this device - the auto pick
 *   for a simple turn when that is smaller, else the smallest fitting model
 *   below the current one;
 * - fast (>= TPS_FAST): a MORE CAPABLE model that fits - the auto pick for a
 *   complex turn, when that is bigger than the current one;
 * - otherwise, or when the current model is not a manifest model (the user's
 *   own local server - its size is unknown to us), null.
 *
 * Stays in the current model's family: a code-trained model gets a
 * code-trained recommendation when the catalog has one that fits.
 */
export function recommendModel(
  manifest: ModelManifest | null,
  caps: EdgeCapabilities,
  currentModelId: string | null | undefined,
  tokensPerSecond: number
): string | null {
  try {
    if (!manifest || !currentModelId) return null;
    const tier1 = manifest.models.filter((m) => m.tier === 1);
    const current = tier1.find((m) => m.id === currentModelId);
    if (!current) return null;
    const useCase: ModelUseCase = current.useCases?.includes("code") ? "code" : "chat";
    const fitting = tier1.filter((m) => modelFits(m, caps));
    const catalog: ModelManifest = { ...manifest, models: tier1 };

    if (tokensPerSecond < TPS_SLOW) {
      const pick = selectBestModel(catalog, caps, "auto", "simple", useCase);
      if (pick.kind === "model" && pick.model && pick.model.sizeBytes < current.sizeBytes) {
        return pick.model.id;
      }
      const smaller = fitting.filter((m) => m.sizeBytes < current.sizeBytes);
      const sameFamily = smaller.filter((m) => useCase !== "code" || m.useCases?.includes("code"));
      const pool = sameFamily.length > 0 ? sameFamily : smaller;
      const smallest = [...pool].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
      return smallest ? smallest.id : null;
    }

    if (tokensPerSecond >= TPS_FAST) {
      const pick = selectBestModel(catalog, caps, "auto", "complex", useCase);
      const model: ManifestModel | null = pick.kind === "model" ? pick.model : null;
      if (model && model.sizeBytes > current.sizeBytes) return model.id;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}
