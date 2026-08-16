import { describe, expect, it } from "vitest";
import { base64UrlEncode, createPkcePair, randomUrlSafe } from "../src/auth/pkce";

// RFC 7636 unreserved characters (section 4.1).
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;

describe("randomUrlSafe", () => {
  it("produces the requested length from the verifier charset", () => {
    const value = randomUrlSafe(64);
    expect(value).toHaveLength(64);
    expect(value).toMatch(VERIFIER_PATTERN);
  });

  it("does not repeat across calls", () => {
    expect(randomUrlSafe(64)).not.toBe(randomUrlSafe(64));
  });
});

describe("base64UrlEncode", () => {
  it("uses - and _ instead of + and /", () => {
    // 0xFB 0xEF encodes to "++8=" in standard base64.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef]))).toBe("--8");
    // 0xFF encodes to "/w==".
    expect(base64UrlEncode(new Uint8Array([0xff]))).toBe("_w");
  });

  it("emits no padding for any input length mod 3", () => {
    for (const bytes of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
      expect(base64UrlEncode(new Uint8Array(bytes))).not.toContain("=");
    }
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    const view = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(base64UrlEncode(view.buffer)).toBe(base64UrlEncode(view));
  });

  it("round-trips through atob after reversing the url-safe mapping", () => {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    const encoded = base64UrlEncode(bytes);
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    expect(Array.from(binary, (c) => c.charCodeAt(0))).toEqual(Array.from(bytes));
  });
});

describe("createPkcePair", () => {
  it("reproduces the RFC 7636 appendix B vector via the same S256 path", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(base64UrlEncode(digest)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("returns a 64-char verifier and a matching S256 challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe("S256");
    expect(pair.verifier).toHaveLength(64);
    expect(pair.verifier).toMatch(VERIFIER_PATTERN);

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(pair.verifier)
    );
    expect(pair.challenge).toBe(base64UrlEncode(digest));
    // A SHA-256 digest is 32 bytes -> 43 unpadded base64url chars.
    expect(pair.challenge).toHaveLength(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
