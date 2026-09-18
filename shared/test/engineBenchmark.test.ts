// Machine Check (EngineHost.benchmark) against fake engines on a fake clock:
// fast / slow / failing / no engine, the estimated-tokens flag, the verdict
// bands, the recommendation direction, the 30 s ceiling, abort, and the
// "never downloads" promise. No WebGPU and no real model here - the fake
// engine stands in for WebLLM / a local server behind the LocalEngine seam.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BENCHMARK_REQ_ID,
  createEngineHost,
  type EngineHostConfig,
} from "../src/webview/engineHost";
import type { EdgeCapabilities } from "../src/edge/capabilities";
import type {
  EngineBackends,
  EngineGenerateRequest,
  EngineGenerateResult,
  LocalEngine,
} from "../src/edge/engine";
import { ENGINE_BACKEND_KEY } from "../src/edge/engine";
import type { EdgeKv } from "../src/edge/host";
import { resetManifestCache } from "../src/edge/manifest";
import {
  BENCHMARK_MAX_TOKENS,
  measureEngine,
  recommendModel,
  verdictFor,
} from "../src/edge/benchmark";
import { BUILTIN_FALLBACK_MANIFEST } from "../src/edge/manifest";

const CODER_1_5B = "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC";
const CODER_3B = "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC";
const CODER_7B = "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC";
const LLAMA_1B = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

function memoryKv(seed: Record<string, string> = {}): EdgeKv {
  const map = new Map(Object.entries(seed));
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

/** A workstation: WebGPU with a big buffer, 16 GB - every builtin model fits. */
const BIG_DEVICE: EdgeCapabilities = {
  webgpu: { available: true, maxBufferSize: 4 * 1024 ** 3, maxStorageBufferBindingSize: 2 * 1024 ** 3 },
  deviceMemoryGB: 16,
  hardwareConcurrency: 8,
};

interface FakeSpec {
  id?: string;
  modelId?: string;
  firstTokenMs?: number;
  chunk?: string;
  chunks?: number;
  perChunkMs?: number;
  usage?: number;
  fail?: boolean;
  throws?: boolean;
  /** After streaming, wait for the abort signal instead of finishing. */
  hang?: boolean;
  probe?: boolean;
}

function fakeClock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function fakeEngine(
  clock: ReturnType<typeof fakeClock>,
  spec: FakeSpec
): LocalEngine & { calls: EngineGenerateRequest[]; download: ReturnType<typeof vi.fn>; started: Promise<void> } {
  const calls: EngineGenerateRequest[] = [];
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((r) => (markStarted = r));
  return {
    id: spec.id ?? "webllm",
    calls,
    started,
    download: vi.fn(),
    probe: async () => spec.probe ?? true,
    status: () => ({ state: "ready", modelId: spec.modelId ?? null }),
    async generate(req, onDelta): Promise<EngineGenerateResult> {
      calls.push(req);
      markStarted();
      if (spec.throws) throw new Error("boom");
      if (spec.fail) return { ok: false, reason: "engine-failed" };
      clock.advance(spec.firstTokenMs ?? 200);
      let text = "";
      const n = spec.chunks ?? 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) clock.advance(spec.perChunkMs ?? 10);
        const c = spec.chunk ?? "word ";
        text += c;
        onDelta?.(c);
      }
      if (spec.hang) {
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve());
        });
        return { ok: false, reason: "aborted" };
      }
      return {
        ok: true,
        text,
        modelId: spec.modelId ?? "fake-model",
        backend: spec.id ?? "webllm",
        ...(spec.usage != null ? { usage: { completionTokens: spec.usage } } : {}),
      };
    },
  };
}

const deadEngine = (id: string): LocalEngine => ({
  id,
  probe: async () => false,
  status: () => ({ state: "unavailable" }),
  generate: async () => ({ ok: false, reason: "unavailable" }),
});

function backendsWith(engine: LocalEngine): EngineBackends {
  const other = deadEngine(engine.id === "webllm" ? "ollama" : "webllm");
  const webllm = engine.id === "webllm" ? engine : other;
  const ollama = engine.id === "webllm" ? other : engine;
  return { webllm, ollama, all: [webllm, ollama] };
}

function hostFor(engine: LocalEngine, clock: ReturnType<typeof fakeClock>, extra: Partial<EngineHostConfig> = {}) {
  return createEngineHost({
    kv: memoryKv(),
    platform: "chrome",
    backends: backendsWith(engine),
    detectCapabilities: async () => BIG_DEVICE,
    now: clock.now,
    ...extra,
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetManifestCache();
  // Any network call would land here - the manifest read then fails and the
  // built-in catalog is used, keeping the recommendation deterministic.
  fetchSpy = vi.fn(async () => {
    throw new Error("network disabled in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("benchmark - measurement", () => {
  it("fast engine with reported usage: exact tokens, first-token latency, fast verdict", async () => {
    const clock = fakeClock();
    // 101 tokens, 100 gaps of 10 ms -> 100 tok/s decode.
    const engine = fakeEngine(clock, { modelId: "fake-model", firstTokenMs: 350, chunks: 101, perChunkMs: 10, usage: 101 });
    const result = await hostFor(engine, clock).benchmark();
    expect(result).toMatchObject({
      ok: true,
      backend: "webllm",
      modelId: "fake-model",
      firstTokenMs: 350,
      tokensPerSecond: 100,
      estimated: false,
    });
    expect(result.verdict).toMatch(/inline completions/i);
    // The request is the fixed, bounded, usage-asking prompt.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ useCase: "chat", maxTokens: BENCHMARK_MAX_TOKENS, includeUsage: true });
    expect(engine.calls[0].prompt).toMatch(/60 words/);
  });

  it("estimates tokens at chars/3.5 when the engine reports no usage, and says so", async () => {
    const clock = fakeClock();
    // 20 chunks x 7 chars = 140 chars -> 40 estimated tokens; 19 gaps x 100 ms.
    const engine = fakeEngine(clock, { chunk: "abcdefg", chunks: 20, perChunkMs: 100 });
    const result = await hostFor(engine, clock).benchmark();
    expect(result.ok).toBe(true);
    expect(result.estimated).toBe(true);
    expect(result.tokensPerSecond).toBeCloseTo(39 / 1.9, 1);
    expect(result.verdict).toMatch(/good for chat/i);
  });

  it("slow engine gets the slow verdict", async () => {
    const clock = fakeClock();
    // 41 tokens, 40 gaps x 250 ms -> 4 tok/s.
    const engine = fakeEngine(clock, { chunks: 41, perChunkMs: 250, usage: 41 });
    const result = await hostFor(engine, clock).benchmark();
    expect(result.tokensPerSecond).toBe(4);
    expect(result.verdict).toMatch(/slow.*smaller model/i);
  });

  it("a failing engine resolves a typed generation-failed, never rejects", async () => {
    const clock = fakeClock();
    const result = await hostFor(fakeEngine(clock, { fail: true }), clock).benchmark();
    expect(result).toEqual({ ok: false, reason: "generation-failed", backend: "webllm" });
  });

  it("an engine that throws still resolves typed", async () => {
    const clock = fakeClock();
    const result = await hostFor(fakeEngine(clock, { throws: true }), clock).benchmark();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("generation-failed");
  });

  it("no engine: no-engine, and nothing generated", async () => {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { probe: false, chunks: 5 });
    const result = await hostFor(engine, clock).benchmark();
    expect(result).toEqual({ ok: false, reason: "no-engine" });
    expect(engine.calls).toHaveLength(0);
  });

  it("local inference turned off reads as no-engine", async () => {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { chunks: 5 });
    const host = hostFor(engine, clock, { kv: memoryKv({ [ENGINE_BACKEND_KEY]: "off" }) });
    expect(await host.benchmark()).toEqual({ ok: false, reason: "no-engine" });
    expect(engine.calls).toHaveLength(0);
  });

  it("the ceiling cuts a slow run short and measures what it produced", async () => {
    const clock = fakeClock();
    // 11 chunks 500 ms apart, then never finishes.
    const engine = fakeEngine(clock, { chunks: 11, perChunkMs: 500, hang: true, chunk: "abcdefg" });
    const result = await hostFor(engine, clock, { benchmarkCeilingMs: 30 }).benchmark();
    expect(result.ok).toBe(true);
    expect(result.estimated).toBe(true);
    expect(result.tokensPerSecond).toBe(4.2); // 77 chars = 22 est. tokens -> 21 / 5 s
    expect(result.verdict).toMatch(/slow/i);
  });

  it("the ceiling with no output at all is a failure, not a zero reading", async () => {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { chunks: 0, hang: true });
    const result = await hostFor(engine, clock, { benchmarkCeilingMs: 30 }).benchmark();
    expect(result).toMatchObject({ ok: false, reason: "generation-failed" });
  });

  it("abort(BENCHMARK_REQ_ID) cancels a running check", async () => {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { chunks: 3, hang: true });
    const host = hostFor(engine, clock);
    const pending = host.benchmark();
    await engine.started;
    host.abort(BENCHMARK_REQ_ID);
    expect(await pending).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("a second click joins the running check instead of starting another", async () => {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { chunks: 20, usage: 20 });
    const host = hostFor(engine, clock);
    const [a, b] = await Promise.all([host.benchmark(), host.benchmark()]);
    expect(a).toEqual(b);
    expect(engine.calls).toHaveLength(1);
    // ...and a later click runs again.
    await host.benchmark();
    expect(engine.calls).toHaveLength(2);
  });

  it("never downloads: no download() call and no network for a local-server engine", async () => {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { id: "ollama", modelId: "qwen2.5-coder:7b", chunks: 41, perChunkMs: 250, usage: 41 });
    const result = await hostFor(engine, clock).benchmark();
    expect(result.ok).toBe(true);
    expect(engine.download).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // A server model's size is unknown to us - no recommendation.
    expect(result.recommendModelId).toBeNull();
  });
});

describe("benchmark - recommendation direction", () => {
  async function run(modelId: string, perChunkMs: number) {
    const clock = fakeClock();
    const engine = fakeEngine(clock, { modelId, chunks: 41, perChunkMs, usage: 41 });
    return hostFor(engine, clock).benchmark();
  }

  it("slow on a mid-size coder recommends a SMALLER coder", async () => {
    const r = await run(CODER_3B, 250); // 4 tok/s
    expect(r.recommendModelId).toBe(CODER_1_5B);
  });

  it("fast on a small coder recommends a MORE CAPABLE coder that fits", async () => {
    const r = await run(CODER_1_5B, 10); // 100 tok/s
    expect(r.recommendModelId).toBe(CODER_7B);
  });

  it("fast on the biggest fitting coder: null, the current one is right", async () => {
    expect((await run(CODER_7B, 10)).recommendModelId).toBeNull();
  });

  it("middle band: null", async () => {
    expect((await run(CODER_3B, 50)).recommendModelId).toBeNull(); // 20 tok/s
  });

  it("slow on the smallest model: null (nothing smaller to offer)", async () => {
    expect((await run(LLAMA_1B, 250)).recommendModelId).toBeNull();
  });

  it("never recommends a model that does not fit the device", () => {
    const small: EdgeCapabilities = { ...BIG_DEVICE, deviceMemoryGB: 8 };
    // 7B coder needs 16 GB -> on an 8 GB device fast 1.5B goes to the 3B.
    expect(recommendModel(BUILTIN_FALLBACK_MANIFEST, small, CODER_1_5B, 100)).toBe(CODER_3B);
  });
});

describe("benchmark - pure helpers", () => {
  it("verdict bands", () => {
    expect(verdictFor(30)).toMatch(/inline completions/i);
    expect(verdictFor(12)).toMatch(/good for chat/i);
    expect(verdictFor(8)).toMatch(/usable/i);
    expect(verdictFor(7.9)).toMatch(/slow/i);
  });

  it("a non-streaming engine is measured over the whole run", async () => {
    const clock = fakeClock();
    const engine: LocalEngine = {
      id: "ollama",
      probe: async () => true,
      status: () => ({ state: "ready" }),
      async generate() {
        clock.advance(2_000);
        return { ok: true, text: "x".repeat(70), modelId: "m", backend: "ollama" };
      },
    };
    const m = await measureEngine(engine, { now: clock.now });
    expect(m).toMatchObject({ ok: true, firstTokenMs: 2000, tokensPerSecond: 10, estimated: true });
  });

  it("an already-aborted signal short-circuits", async () => {
    const clock = fakeClock();
    const c = new AbortController();
    c.abort();
    const engine = fakeEngine(clock, { chunks: 3 });
    expect(await measureEngine(engine, { signal: c.signal, now: clock.now })).toEqual({ ok: false, reason: "aborted" });
    expect(engine.calls).toHaveLength(0);
  });
});
