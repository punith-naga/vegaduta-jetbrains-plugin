// The on-device path promises that code stays on the machine. The one
// documented exception is server-side validation of a local Fix/Refactor, and
// only when signed in. These tests pin the gate that enforces "only when
// signed in": before 2026-09-18 a signed-out request still went out, just
// without an Authorization header.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryValidate } from "../src/webview/engineHost";
import type { EdgeHost } from "../src/edge/host";

const kv = { get: () => null, set: () => undefined };

function hostWith(token: string | null, throws = false): EdgeHost {
  return {
    apiBase: "https://api.vegaduta.ai",
    kv,
    platform: "vscode",
    getToken: async () => {
      if (throws) throw new Error("token store unavailable");
      return token;
    },
  };
}

describe("tryValidate privacy gate", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends NOTHING when signed out", async () => {
    const out = await tryValidate(hostWith(null), "java", "class A {}");
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when the token lookup itself fails", async () => {
    const out = await tryValidate(hostWith(null, true), "python", "print(1)");
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing for a language the validator does not cover, even signed in", async () => {
    await tryValidate(hostWith("jwt"), "rust", "fn main() {}");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates, with the bearer token, when signed in", async () => {
    const out = await tryValidate(hostWith("jwt-123"), "java", "class A {}");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.vegaduta.ai/api/tools/code/validate");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-123");
    expect(out).toEqual({ valid: true, errors: [] });
  });
});
