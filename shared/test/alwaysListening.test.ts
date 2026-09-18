// "Always listening" (2026-09-18): the chat box never locks. A message sent
// before anything can answer (signed out, no on-device model yet) is held and
// sent by itself once sign-in completes or a model is ready. The rules are
// pure (modes.ts); the source scans pin that main.ts actually uses them.

import mainSrc from "../src/webview/chat/main.ts?raw";
import { describe, expect, it } from "vitest";
import { canReleaseParked, friendlyModelName, pickQuickModel } from "../src/webview/chat/modes";
import { normalizeCapabilities } from "../src/webview/chat/commands";

const model = (id: string, o: Partial<{ downloaded: boolean; fits: boolean; sizeBytes: number }> = {}) => ({
  id,
  downloaded: false,
  fits: true,
  sizeBytes: 1_000_000_000,
  ...o,
});

describe("pickQuickModel", () => {
  it("prefers a model that is already downloaded - no wait at all", () => {
    const list = [model("tiny", { sizeBytes: 500 }), model("have", { downloaded: true, sizeBytes: 9_000 })];
    expect(pickQuickModel(list)?.id).toBe("have");
  });

  it("otherwise the LIGHTEST model that fits - the quickest first download", () => {
    const list = [
      model("llama-3b", { sizeBytes: 2_260_000_000 }),
      model("llama-1b", { sizeBytes: 880_000_000 }),
      model("qwen-1.5b", { sizeBytes: 1_630_000_000 }),
    ];
    expect(pickQuickModel(list)?.id).toBe("llama-1b");
  });

  it("skips a lighter model the device cannot run", () => {
    expect(pickQuickModel([model("tiny", { fits: false, sizeBytes: 1 }), model("small", { sizeBytes: 2 })])?.id).toBe("small");
  });

  it("never picks a model the device cannot run, even if downloaded", () => {
    expect(pickQuickModel([model("x", { fits: false, downloaded: true })])).toBeUndefined();
  });
});

describe("friendlyModelName", () => {
  it("turns WebLLM ids into names a person can read", () => {
    expect(friendlyModelName("Llama-3.2-1B-Instruct-q4f16_1-MLC")).toBe("Llama 3.2 1B");
    expect(friendlyModelName("Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC")).toBe("Qwen2.5 Coder 1.5B");
    expect(friendlyModelName("gemma-2-2b-it-q4f16_1-MLC")).toBe("gemma 2 2b");
  });
});

describe("canReleaseParked", () => {
  it("releases to the on-device engine", () => {
    expect(canReleaseParked("local", false, false)).toBe(true);
  });

  it("releases to a hosted agent only once there is an agent to address", () => {
    expect(canReleaseParked("hosted", false, false)).toBe(false);
    expect(canReleaseParked("hosted", true, false)).toBe(true);
  });

  it("holds while nothing can answer, and while another answer is streaming", () => {
    expect(canReleaseParked("none", true, false)).toBe(false);
    expect(canReleaseParked("private-no-engine", true, false)).toBe(false);
    expect(canReleaseParked("local", true, true)).toBe(false);
  });
});

describe("main.ts wiring", () => {
  it("never disables the message box", () => {
    expect(mainSrc).toMatch(/input\.disabled = false;/);
    expect(mainSrc).not.toMatch(/input\.disabled = !enabled/);
  });

  it("holds a message instead of refusing it when nothing can answer", () => {
    expect(mainSrc).toMatch(/if \(route !== "local" && route !== "hosted"\) \{\s*parkRequest\(req\);/);
  });

  it("re-checks the held message on sign-in, agent list and engine changes", () => {
    const calls = mainSrc.match(/releaseParkedSoon\(\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(mainSrc).toMatch(/canReleaseParked\(routeNow\(\)/);
  });

  it("a held message never goes to a hosted agent in Private Mode (routing decides)", () => {
    // The release path goes through send(), which re-routes with routeFor -
    // and routeFor never returns "hosted" while Private Mode is on.
    expect(mainSrc).toMatch(/state\.parked = null;\s*renderParked\(\);\s*send\(req\);/);
  });
});

describe("IDE theme", () => {
  it("applies the host's light/dark theme from init as a body class the stylesheet keys on", () => {
    expect(mainSrc).toMatch(/message\.theme === "dark" \|\| message\.theme === "light"/);
    expect(mainSrc).toMatch(/classList\.add\(`vd-theme-\$\{message\.theme\}`\)/);
  });
});

describe("layout: panels never cut each other off", () => {
  it("keeps one drawer open at a time and hides the conversation while it is", () => {
    for (const d of ["models", "history", "toolkit", "tools"]) {
      expect(mainSrc).toContain(`closeOtherDrawers("${d}")`);
    }
    expect(mainSrc).toMatch(/document\.body\.classList\.toggle\("vd-drawer-open", open\)/);
  });

  it("tells the person how to get more room when the panel is cramped", () => {
    expect(mainSrc).toMatch(/const ROOM_MIN_WIDTH = \d+;/);
    expect(mainSrc).toMatch(/window\.addEventListener\("resize"/);
    // Every host gets advice specific to it.
    for (const p of ["vscode", "chrome", "jetbrains", "eclipse"]) expect(mainSrc).toContain(`case "${p}":`);
    // Pop-out is offered only when the host says it can do it.
    expect(mainSrc).toMatch(/if \(state\.capabilities\.popOut\) \{/);
  });
});

describe("popOut capability", () => {
  it("is carried only when the host sets it to true", () => {
    expect(normalizeCapabilities({ context: [], popOut: true }).popOut).toBe(true);
    expect("popOut" in normalizeCapabilities({ context: [], popOut: "yes" })).toBe(false);
    expect("popOut" in normalizeCapabilities({ context: [] })).toBe(false);
  });
});

describe("bundled local runtime (IDE hosts without WebGPU)", () => {
  it("carries the localRuntime capability only when the host sets it to true", () => {
    expect(normalizeCapabilities({ context: [], localRuntime: true }).localRuntime).toBe(true);
    expect("localRuntime" in normalizeCapabilities({ context: [], localRuntime: 1 })).toBe(false);
  });

  it("asks the host for the runtime's state on init and renders every runtime.status", () => {
    expect(mainSrc).toMatch(/if \(state\.capabilities\.localRuntime\) transport\.post\(\{ type: "runtime\.query" \}\);/);
    expect(mainSrc).toMatch(/case "runtime\.status": \{/);
  });

  it("routes one-click on-device AI to the runtime where the host has one", () => {
    expect(mainSrc).toMatch(/if \(state\.capabilities\.localRuntime\) \{\s*const id = recommendedRuntimeModel\(\);/);
    expect(mainSrc).toMatch(/transport\.post\(\{ type: "runtime\.install", modelId \}\)/);
  });
});
