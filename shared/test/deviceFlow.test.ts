// Device-flow polling under rate limiting. Written 2026-09-18 after Cloudflare
// in front of auth.vegaduta.ai answered a sign-in's polls with HTTP 429 and
// then an IP ban (error 1015). Before this, a 429 ended the sign-in with
// "Token request failed (429)".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollForTokens } from "../src/auth/deviceFlow";

type Reply = { status: number; body?: string; headers?: Record<string, string> };
const pending: Reply = { status: 400, body: JSON.stringify({ error: "authorization_pending" }) };
const ok: Reply = { status: 200, body: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 300 }) };

function authorization() {
  return {
    deviceCode: "dc",
    userCode: "ABCD-EFGH",
    verificationUri: "https://auth.example/device",
    verificationUriComplete: "https://auth.example/device?user_code=ABCD-EFGH",
    intervalMs: 5000,
    expiresAt: Date.now() + 600_000,
  };
}

describe("pollForTokens under rate limiting", () => {
  let callTimes: number[];

  function serve(replies: Reply[]) {
    const queue = [...replies];
    callTimes = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callTimes.push(Date.now());
        const r = queue.shift() ?? pending;
        return new Response(r.body ?? "", { status: r.status, headers: r.headers });
      })
    );
  }

  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(promise: Promise<unknown>) {
    const settled = promise.then(
      (v) => ({ v }),
      (e) => ({ e })
    );
    for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(1000);
    return settled as Promise<{ v?: { accessToken: string }; e?: Error }>;
  }

  it("keeps waiting through a Cloudflare 429 (HTML body) and signs in", async () => {
    serve([pending, { status: 429, body: "<html>1015</html>" }, pending, ok]);
    const r = await run(pollForTokens("https://auth.example", authorization() as never));
    expect(r.e).toBeUndefined();
    expect(r.v?.accessToken).toBe("at");
    // polls at 5s, 10s; the 429 at 10s raises the interval to 10s -> 20s, 30s
    expect(callTimes).toEqual([5000, 10000, 20000, 30000]);
  });

  it("honours Retry-After on a 429", async () => {
    serve([{ status: 429, headers: { "Retry-After": "30" } }, ok]);
    await run(pollForTokens("https://auth.example", authorization() as never));
    expect(callTimes).toEqual([5000, 35000]);
  });

  it("caps the backoff at 60s", async () => {
    serve([{ status: 429, headers: { "Retry-After": "900" } }, ok]);
    await run(pollForTokens("https://auth.example", authorization() as never));
    expect(callTimes).toEqual([5000, 65000]);
  });

  it("still treats a real OAuth failure as fatal", async () => {
    serve([{ status: 400, body: JSON.stringify({ error: "access_denied", error_description: "denied" }) }]);
    const r = await run(pollForTokens("https://auth.example", authorization() as never));
    expect(r.e?.message).toMatch(/denied/);
  });
});
