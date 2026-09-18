import { describe, expect, it } from "vitest";
import {
  modelFits,
  normalizeManifest,
  selectBestModel,
  type EdgeCapabilities,
  type ManifestModel,
} from "../src/edge/capabilities";
import { BUILTIN_FALLBACK_MANIFEST } from "../src/edge/manifest";

const gpu = (deviceMemoryGB: number | null, maxBufferSize = 2 ** 31): EdgeCapabilities => ({
  webgpu: { available: true, maxBufferSize, maxStorageBufferBindingSize: maxBufferSize },
  deviceMemoryGB,
  hardwareConcurrency: 8,
});

const noGpu: EdgeCapabilities = {
  webgpu: { available: false, maxBufferSize: null, maxStorageBufferBindingSize: null },
  deviceMemoryGB: 16,
  hardwareConcurrency: 8,
};

const byId = (id: string): ManifestModel => {
  const m = BUILTIN_FALLBACK_MANIFEST.models.find((x) => x.id === id);
  if (!m) throw new Error(id);
  return m;
};

describe("modelFits", () => {
  it("refuses every tier-1 model without WebGPU", () => {
    for (const m of BUILTIN_FALLBACK_MANIFEST.models) expect(modelFits(m, noGpu)).toBe(false);
  });

  it("passes unknown deviceMemory (Firefox/Safari) but enforces a known one", () => {
    const big = byId("Llama-3.2-3B-Instruct-q4f16_1-MLC"); // 8 GB floor
    expect(modelFits(big, gpu(null))).toBe(true);
    expect(modelFits(big, gpu(4))).toBe(false);
    expect(modelFits(big, gpu(8))).toBe(true);
  });

  it("enforces the WebGPU maxBufferSize floor", () => {
    const big = byId("Llama-3.2-3B-Instruct-q4f16_1-MLC"); // 1 GiB buffer floor
    expect(modelFits(big, gpu(16, 2 ** 29))).toBe(false);
    expect(modelFits(big, gpu(16, 2 ** 30))).toBe(true);
  });
});

describe("selectBestModel", () => {
  it("picks the smallest 'fast' model for a simple turn on a capable device", () => {
    const sel = selectBestModel(BUILTIN_FALLBACK_MANIFEST, gpu(16), "auto");
    expect(sel.kind).toBe("model");
    expect(sel.model?.id).toBe("Llama-3.2-1B-Instruct-q4f16_1-MLC");
    expect(sel.source).toBe("auto");
  });

  it("escalates to the biggest 'capable' model for a complex turn", () => {
    const sel = selectBestModel(BUILTIN_FALLBACK_MANIFEST, gpu(16), "auto", "complex");
    const biggest = [...BUILTIN_FALLBACK_MANIFEST.models].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    expect(sel.model?.id).toBe(biggest.id);
    expect(sel.model?.speedTier).toBe("capable");
  });

  it("a user pin always wins, even when it does not fit (fits=false is informational)", () => {
    const sel = selectBestModel(BUILTIN_FALLBACK_MANIFEST, gpu(4), "Llama-3.2-3B-Instruct-q4f16_1-MLC");
    expect(sel.source).toBe("user");
    expect(sel.model?.id).toBe("Llama-3.2-3B-Instruct-q4f16_1-MLC");
    expect(sel.fits).toBe(false);
  });

  it("'hosted' pins hosted; a vanished pin falls back to auto; no fit → hosted", () => {
    expect(selectBestModel(BUILTIN_FALLBACK_MANIFEST, gpu(16), "hosted").kind).toBe("hosted");
    const gone = selectBestModel(BUILTIN_FALLBACK_MANIFEST, gpu(16), "no-such-model");
    expect(gone.source).toBe("auto");
    expect(gone.kind).toBe("model");
    expect(selectBestModel(BUILTIN_FALLBACK_MANIFEST, noGpu, "auto").kind).toBe("hosted");
  });
});

describe("normalizeManifest", () => {
  it("accepts the wire shape with string numbers and drops unusable rows", () => {
    const raw = {
      version: 7,
      models: [
        { id: "a", displayName: "A", sizeBytes: "1000", minDeviceMemoryGB: "4", minMaxBufferSize: 0, tier: "1" },
        { id: "", displayName: "broken", sizeBytes: 1, minDeviceMemoryGB: 0, minMaxBufferSize: 0, tier: 1 },
        "garbage",
      ],
    };
    const m = normalizeManifest(raw);
    expect(m).not.toBeNull();
    expect(m?.version).toBe("7");
    expect(m?.models.map((x) => x.id)).toEqual(["a"]);
    expect(m?.models[0].sizeBytes).toBe(1000);
    expect(m?.models[0].tier).toBe(1);
  });

  it("returns null for a body that is not a manifest at all", () => {
    expect(normalizeManifest(null)).toBeNull();
    expect(normalizeManifest("x")).toBeNull();
    expect(normalizeManifest({ models: "nope" })).toBeNull();
  });
});

describe("use-case aware selection", () => {
  const caps16 = gpu(16);

  it("prefers a code-trained model for a code turn", () => {
    const sel = selectBestModel(BUILTIN_FALLBACK_MANIFEST, caps16, "auto", "simple", "code");
    expect(sel.model?.useCases).toContain("code");
    expect(sel.model?.id).toBe("Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC");
  });

  it("picks a general model for a chat turn on the same device", () => {
    const sel = selectBestModel(BUILTIN_FALLBACK_MANIFEST, caps16, "auto", "simple", "chat");
    expect(sel.model?.id).toBe("Llama-3.2-1B-Instruct-q4f16_1-MLC");
  });

  it("escalates to the biggest coder for a complex code turn", () => {
    const sel = selectBestModel(BUILTIN_FALLBACK_MANIFEST, caps16, "auto", "complex", "code");
    expect(sel.model?.id).toBe("Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC");
  });

  it("falls through to the general list when no coder fits the device", () => {
    // 4 GB: only the 1.5B coder and the small generalists fit.
    const small = selectBestModel(BUILTIN_FALLBACK_MANIFEST, gpu(4), "auto", "simple", "code");
    expect(small.model?.id).toBe("Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC");
    // A catalog with no coder at all must still answer with a model.
    const noCoder = {
      version: "t",
      models: BUILTIN_FALLBACK_MANIFEST.models.filter((m) => !m.useCases?.includes("code")),
    };
    const sel = selectBestModel(noCoder, caps16, "auto", "simple", "code");
    expect(sel.kind).toBe("model");
    expect(sel.model?.useCases).not.toContain("code");
  });

  it("a user pin still wins over the code preference", () => {
    const sel = selectBestModel(
      BUILTIN_FALLBACK_MANIFEST,
      caps16,
      "Llama-3.1-8B-Instruct-q4f16_1-MLC",
      "simple",
      "code"
    );
    expect(sel.source).toBe("user");
    expect(sel.model?.id).toBe("Llama-3.1-8B-Instruct-q4f16_1-MLC");
  });
});

describe("normalizeManifest use cases", () => {
  it("derives 'code' from a coder model id when the server does not say", () => {
    const m = normalizeManifest({
      version: "1",
      models: [
        { id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC", tier: 1 },
        { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", tier: 1 },
      ],
    });
    expect(m?.models[0].useCases).toEqual(["code", "chat"]);
    expect(m?.models[1].useCases).toEqual(["chat"]);
  });

  it("an explicit list wins over the id, and junk degrades to chat", () => {
    const m = normalizeManifest({
      version: "1",
      models: [
        { id: "some-model", tier: 1, useCases: ["code"] },
        { id: "other-model", tier: 1, use_cases: "code" },
        { id: "third-model", tier: 1, useCases: ["nonsense", 7] },
      ],
    });
    expect(m?.models[0].useCases).toEqual(["code", "chat"]);
    expect(m?.models[1].useCases).toEqual(["code", "chat"]);
    expect(m?.models[2].useCases).toEqual(["chat"]);
  });
});

describe("the built-in fallback catalog", () => {
  it("only lists tier-1 ids the installed engine can serve, with real sizes", () => {
    for (const m of BUILTIN_FALLBACK_MANIFEST.models) {
      expect(m.tier).toBe(1);
      expect(m.id).toMatch(/-MLC$/);
      expect(m.sizeBytes).toBeGreaterThan(300_000_000);
      expect(m.contextWindowSize).toBe(4096);
      expect(m.url).toBeNull();
    }
  });

  it("offers a code model at every device tier and something for a 4 GB machine", () => {
    const coders = BUILTIN_FALLBACK_MANIFEST.models.filter((m) => m.useCases?.includes("code"));
    expect(coders.length).toBeGreaterThanOrEqual(3);
    const tiny = BUILTIN_FALLBACK_MANIFEST.models.filter((m) => modelFits(m, gpu(4)));
    expect(tiny.length).toBeGreaterThanOrEqual(3);
  });
});
