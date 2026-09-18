// Private Mode in the edge layer: hosted code validation (tryValidate) must
// send NOTHING while edge.privateMode is "1" - even signed in - while the
// local generation itself still runs. The control cases prove the spy would
// have seen the request with Private Mode off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineHost, EDGE_PRIVATE_MODE_KEY, tryValidate } from "../src/webview/engineHost";
import type { EngineBackends, LocalEngine } from "../src/edge/engine";
import type { EdgeHost, EdgeKv } from "../src/edge/host";

function memoryKv(seed: Record<string, string> = {}): EdgeKv {
  const map = new Map(Object.entries(seed));
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function edgeHost(kv: EdgeKv, getToken: () => Promise<string | null>): EdgeHost {
  return { apiBase: "https://api.vegaduta.ai", kv, platform: "vscode", getToken };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("tryValidate under Private Mode", () => {
  it("sends nothing when Private Mode is on, even signed in - and never asks for the token", async () => {
    const getToken = vi.fn(async () => "jwt-123");
    const out = await tryValidate(edgeHost(memoryKv({ [EDGE_PRIVATE_MODE_KEY]: "1" }), getToken), "java", "class A {}");
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("control: Private Mode off + signed in does validate", async () => {
    const out = await tryValidate(edgeHost(memoryKv({ [EDGE_PRIVATE_MODE_KEY]: "0" }), async () => "jwt-123"), "java", "class A {}");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ valid: true, errors: [] });
  });

  it("fails closed when the preference store cannot be read", async () => {
    const broken: EdgeKv = {
      get: () => {
        throw new Error("storage blocked");
      },
      set: () => undefined,
    };
    const out = await tryValidate(edgeHost(broken, async () => "jwt"), "python", "print(1)");
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("EngineHost Private Mode", () => {
  const fixer: LocalEngine = {
    id: "webllm",
    probe: async () => true,
    status: () => ({ state: "ready", modelId: "m" }),
    generate: async () => ({ ok: true, text: "class A { int x = 1; }", modelId: "m", backend: "webllm" }),
  };
  const dead: LocalEngine = {
    id: "ollama",
    probe: async () => false,
    status: () => ({ state: "unavailable" }),
    generate: async () => ({ ok: false, reason: "unavailable" }),
  };
  const backends: EngineBackends = { webllm: fixer, ollama: dead, all: [fixer, dead] };

  it("setPrivateMode persists under EDGE_PRIVATE_MODE_KEY and isPrivateMode reads it back", () => {
    const kv = memoryKv();
    const host = createEngineHost({ kv, platform: "vscode", backends });
    expect(host.isPrivateMode()).toBe(false);
    host.setPrivateMode(true);
    expect(kv.get(EDGE_PRIVATE_MODE_KEY)).toBe("1");
    expect(host.isPrivateMode()).toBe(true);
    host.setPrivateMode(false);
    expect(kv.get(EDGE_PRIVATE_MODE_KEY)).toBe("0");
    expect(host.isPrivateMode()).toBe(false);
  });

  it("a local Fix still runs on-device in Private Mode, but its validation sends nothing", async () => {
    const host = createEngineHost({ kv: memoryKv(), platform: "vscode", backends, getToken: async () => "jwt-123" });
    host.setPrivateMode(true);
    const result = await host.run("r1", "fix", { text: "class A { int x = 1 }", languageId: "java" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("class A");
    expect(result.validation).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("control: the same Fix with Private Mode off is validated (signed in)", async () => {
    const host = createEngineHost({ kv: memoryKv(), platform: "vscode", backends, getToken: async () => "jwt-123" });
    const result = await host.run("r2", "fix", { text: "class A { int x = 1 }", languageId: "java" });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.validation).toEqual({ valid: true, errors: [] });
  });

  it("Machine Check still works in Private Mode and sends nothing for a local-server engine", async () => {
    const local: LocalEngine = { ...fixer, id: "ollama" };
    const host = createEngineHost({
      kv: memoryKv(),
      platform: "vscode",
      backends: { webllm: dead, ollama: local, all: [dead, local] },
    });
    host.setPrivateMode(true);
    const r = await host.benchmark();
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
