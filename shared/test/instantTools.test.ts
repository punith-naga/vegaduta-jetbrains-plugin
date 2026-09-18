// Instant Tools run entirely in the webview, so their correctness is all we
// have: these tests pin known outputs, the bad-input path of every tool (ok:false
// with a note, never a throw) and the registry contract the UI is built on.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findInstantTool,
  INSTANT_CATEGORY_LABELS,
  INSTANT_TOOLS,
  type InstantResult,
} from "../src/webview/chat/instantTools";

const ALLOWED_ICONS = [
  "code", "key", "eye", "bolt", "globe", "map", "layers", "target", "flask",
  "commit", "wrench", "spark", "chip", "users", "rocket",
];

async function run(id: string, input: string, options: Record<string, string> = {}): Promise<InstantResult> {
  const tool = findInstantTool(id);
  if (!tool) throw new Error(`no tool ${id}`);
  return await tool.run(input, options);
}

/** Reference base64 via btoa (independent of the module's own codec). */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64urlOf = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("registry contract", () => {
  it("has unique kebab-case ids, allowed icons, known categories and sane options", () => {
    const ids = INSTANT_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(INSTANT_TOOLS.length).toBe(18);
    for (const t of INSTANT_TOOLS) {
      expect(t.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ALLOWED_ICONS).toContain(t.icon);
      expect(Object.keys(INSTANT_CATEGORY_LABELS)).toContain(t.category);
      expect(t.name && t.description && t.placeholder).toBeTruthy();
      for (const o of t.options ?? []) expect(o.choices).toContain(o.default);
    }
  });

  it("findInstantTool finds by id and returns undefined otherwise", () => {
    expect(findInstantTool("json")?.name).toBe("JSON formatter");
    expect(findInstantTool("nope")).toBeUndefined();
  });

  it("every tool's sample runs with ok:true and some output", async () => {
    for (const t of INSTANT_TOOLS) {
      const r = await t.run(t.sample, {});
      expect(r.ok, `${t.id}: ${r.note}`).toBe(true);
      expect(r.output.length, t.id).toBeGreaterThan(0);
    }
  });

  it("empty input never throws, and non-generators report ok:false with a note", async () => {
    const generators = new Set(["uuid", "password", "test-data", "timestamp", "hash"]);
    for (const t of INSTANT_TOOLS) {
      const r = await t.run("", {});
      if (!generators.has(t.id)) {
        expect(r.ok, t.id).toBe(false);
        expect(r.note, t.id).toBeTruthy();
      }
    }
  });

  it("unknown option values fall back to the default", async () => {
    const r = await run("json", '{"b":1}', { mode: "Bogus" });
    expect(r.output).toBe('{\n  "b": 1\n}');
  });
});

describe("json", () => {
  it("formats, minifies and sorts keys", async () => {
    const input = '{"b":1,"a":{"d":2,"c":[1,2]}}';
    expect((await run("json", input)).note).toBe("Valid JSON · object with 2 keys");
    expect((await run("json", '{ "a" : [ 1, 2 ] }', { mode: "Minify" })).output).toBe('{"a":[1,2]}');
    const sorted = await run("json", input, { mode: "Sort keys" });
    expect(sorted.output).toBe(JSON.stringify({ a: { c: [1, 2], d: 2 }, b: 1 }, null, 2));
    expect(sorted.language).toBe("json");
  });

  it("points at the line and column of a syntax error", async () => {
    const r = await run("json", '{\n  "a": 1,\n  "b": 2,\n}');
    expect(r.ok).toBe(false);
    expect(r.note).toContain("line 4, column 1");
    expect(r.note).toMatch(/trailing comma/i);
    const q = await run("json", "{'a': 1}");
    expect(q.note).toContain("line 1, column 2");
    expect(q.note).toMatch(/double quotes/);
  });
});

describe("jwt-decode", () => {
  const b64url = (v: unknown) => b64urlOf(JSON.stringify(v));

  it("decodes header and payload with relative times and says the signature is not verified", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const now = Date.now() / 1000;
    const token = `${b64url({ alg: "RS256" })}.${b64url({ sub: "u1", exp: now - 3 * 3600, iat: now - 5 * 3600 })}.sig`;
    const r = await run("jwt-decode", `Bearer ${token}`);
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.header.alg).toBe("RS256");
    expect(out.payload.sub).toBe("u1");
    expect(out.timestamps.exp).toBe("2026-09-18T09:00:00.000Z · expired 3h ago");
    expect(out.timestamps.iat).toContain("issued 5h ago");
    expect(r.note).toContain("NOT verified");
    expect(r.note).toContain("expired 3h ago");

    const future = `${b64url({ alg: "HS256" })}.${b64url({ exp: now + 2 * 86400 })}.x`;
    expect((await run("jwt-decode", future)).note).toContain("expires in 2d");
  });

  it("rejects things that are not JWTs", async () => {
    expect((await run("jwt-decode", "hello")).note).toMatch(/3 dot-separated parts/);
    expect((await run("jwt-decode", "a.b.c.d.e")).note).toMatch(/JWE/);
    expect((await run("jwt-decode", `${b64url({ a: 1 })}.bm90IGpzb24.x`)).note).toMatch(/payload is not JSON/);
  });
});

describe("base64", () => {
  it("round-trips UTF-8 and supports URL-safe", async () => {
    const enc = await run("base64", "héllo 👋");
    expect(enc.output).toBe(b64("héllo 👋"));
    expect((await run("base64", enc.output, { mode: "Decode" })).output).toBe("héllo 👋");
    const bytes = "\u00fb\u00ff"; // encodes with + and / in standard base64
    const url = await run("base64", bytes, { variant: "URL-safe" });
    expect(url.output).toBe(b64urlOf(bytes));
    expect((await run("base64", url.output, { mode: "Decode" })).output).toBe(bytes);
  });

  it("reports invalid base64 and shows binary as hex", async () => {
    const bad = await run("base64", "abc$def", { mode: "Decode" });
    expect(bad.ok).toBe(false);
    expect(bad.note).toContain("position 4");
    expect((await run("base64", "abcde", { mode: "Decode" })).ok).toBe(false);
    const bin = await run("base64", "/w==", { mode: "Decode" });
    expect(bin.ok).toBe(true);
    expect(bin.output).toBe("ff");
    expect(bin.note).toMatch(/hex/);
  });
});

describe("url-encode", () => {
  it("encodes, decodes and parses query strings", async () => {
    expect((await run("url-encode", "a b&c=d/é", { mode: "Encode" })).output).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect((await run("url-encode", "a%20b%2Fc", { mode: "Decode" })).output).toBe("a b/c");
    const q = await run("url-encode", "a=1&b=x%20y&b=z+w&flag");
    expect(JSON.parse(q.output)).toEqual({ a: "1", b: ["x y", "z w"], flag: "" });
    const full = await run("url-encode", "https://x.dev/p?q=hi#frag");
    expect(JSON.parse(full.output)).toEqual({ q: "hi" });
  });

  it("reports malformed escapes and URLs without a query", async () => {
    const r = await run("url-encode", "100%zz", { mode: "Decode" });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("position 4");
    expect((await run("url-encode", "https://x.dev/path")).ok).toBe(false);
  });
});

describe("uuid", () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("generates N distinct v4 UUIDs", async () => {
    const lines = (await run("uuid", "", { count: "25" })).output.split("\n");
    expect(lines).toHaveLength(25);
    expect(new Set(lines).size).toBe(25);
    for (const l of lines) expect(l).toMatch(V4);
  });

  it("falls back to getRandomValues, and fails cleanly with no crypto", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const r = await run("uuid", "", { count: "5" });
    for (const l of r.output.split("\n")) expect(l).toMatch(V4);
    vi.stubGlobal("crypto", undefined);
    expect((await run("uuid", "")).ok).toBe(false);
  });
});

describe("hash", () => {
  it("matches known digests", async () => {
    expect((await run("hash", "abc")).output).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect((await run("hash", "abc", { algorithm: "SHA-1" })).output).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect((await run("hash", "abc", { algorithm: "SHA-512" })).output).toHaveLength(128);
    expect((await run("hash", "abc", { algorithm: "SHA-384" })).output).toHaveLength(96);
  });

  it("fails cleanly without Web Crypto", async () => {
    vi.stubGlobal("crypto", {});
    const r = await run("hash", "abc");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/Web Crypto/);
  });
});

describe("timestamp", () => {
  it("detects seconds, milliseconds, date strings and empty = now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const s = await run("timestamp", "1789731000");
    expect(s.note).toBe("Detected: Epoch seconds");
    expect(s.output).toContain("2026-09-18T11:30:00.000Z");
    expect(s.output).toContain("30m ago");
    const ms = await run("timestamp", "1789731000000");
    expect(ms.note).toBe("Detected: Epoch milliseconds");
    expect(ms.output).toContain("2026-09-18T11:30:00.000Z");
    const iso = await run("timestamp", "2026-09-20T12:00:00Z");
    expect(iso.output).toMatch(/Epoch s\s+1789905600/);
    expect(iso.output).toMatch(/Epoch ms\s+1789905600000/);
    expect(iso.output).toContain("in 2d");
    const now = await run("timestamp", "");
    expect(now.output).toContain("2026-09-18T12:00:00.000Z");
  });

  it("rejects unreadable dates", async () => {
    const r = await run("timestamp", "not a date");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/Could not read/);
  });
});

describe("regex", () => {
  it("lists matches with index, numbered and named groups", async () => {
    const r = await run("regex", "/foo(?<n>\\d+)/gi\nFOO1 bar foo22");
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/^2 matches/);
    expect(r.output).toContain('#1  index 0  "FOO1"');
    expect(r.output).toContain('#2  index 9  "foo22"');
    expect(r.output).toContain('<n>  "22"');
    expect(r.output).toContain('$1  "1"');
  });

  it("handles bare patterns, no-g, zero-length matches and caps", async () => {
    expect((await run("regex", "\\d\na1b2")).note).toMatch(/^2 matches/);
    expect((await run("regex", "/\\d/\na1b2")).note).toContain("first match only");
    expect((await run("regex", "/x*/g\nab")).note).toMatch(/^3 matches/);
    const many = await run("regex", `/a/g\n${"a".repeat(30_000)}`);
    expect(many.note).toContain("stopped at 500 matches");
    expect(many.note).toContain("cut to the first 20,000 chars");
  });

  it("reports an invalid pattern", async () => {
    const r = await run("regex", "/foo(/g\nfoo");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/^Invalid pattern/);
  });
});

describe("case-convert", () => {
  const input = "user_id\nXMLHttpRequest\nhello world";
  it.each([
    ["camelCase", "userId\nxmlHttpRequest\nhelloWorld"],
    ["PascalCase", "UserId\nXmlHttpRequest\nHelloWorld"],
    ["snake_case", "user_id\nxml_http_request\nhello_world"],
    ["kebab-case", "user-id\nxml-http-request\nhello-world"],
    ["CONSTANT_CASE", "USER_ID\nXML_HTTP_REQUEST\nHELLO_WORLD"],
    ["Title Case", "User Id\nXml Http Request\nHello World"],
    ["lower case", "user_id\nxmlhttprequest\nhello world"],
    ["UPPER CASE", "USER_ID\nXMLHTTPREQUEST\nHELLO WORLD"],
  ])("converts to %s", async (target, expected) => {
    expect((await run("case-convert", input, { target })).output).toBe(expected);
  });

  it("rejects blank input", async () => {
    expect((await run("case-convert", "  \n ")).ok).toBe(false);
  });
});

describe("text-diff", () => {
  it("produces a unified line diff with counts", async () => {
    const r = await run("text-diff", "a\nb\nc\n-----\na\nB\nc\nd");
    expect(r.ok).toBe(true);
    expect(r.language).toBe("diff");
    expect(r.note).toBe("+2 −1 lines");
    expect(r.output).toBe(["--- original", "+++ changed", "@@ -1,3 +1,4 @@", " a", "-b", "+B", " c", "+d"].join("\n"));
  });

  it("reports identical texts and a missing separator", async () => {
    expect((await run("text-diff", "x\ny\n------\nx\ny")).note).toMatch(/^Identical/);
    const r = await run("text-diff", "x\n---\ny");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/-----/);
  });
});

describe("cron-explain", () => {
  it("explains and lists the next runs in UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z")); // a Friday
    const r = await run("cron-explain", "30 9 * * MON-FRI");
    expect(r.ok).toBe(true);
    expect(r.output.split("\n")[0]).toBe("At 09:30, on Monday through Friday.");
    expect(r.output).toContain("2026-09-21T09:30:00.000Z");
    expect(r.output).not.toContain("2026-09-19T09:30");
    const runs = r.output.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/g) ?? [];
    expect(runs).toHaveLength(5);
  });

  it("handles steps, lists, month names and macros", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:07:00Z"));
    const step = await run("cron-explain", "*/15 * * * *");
    expect(step.output).toMatch(/^Every 15 minutes\./);
    expect(step.output).toContain("2026-09-18T10:15:00.000Z");
    const daily = await run("cron-explain", "@daily");
    expect(daily.output).toMatch(/^At 00:00\./);
    expect(daily.output).toContain("2026-09-19T00:00:00.000Z");
    const q = await run("cron-explain", "0 12 1,15 jan-mar *");
    expect(q.output.split("\n")[0]).toBe("At 12:00, on the 1st and 15th of the month, in January through March.");
    expect(q.output).toContain("2027-01-01T12:00:00.000Z");
    const or = await run("cron-explain", "0 0 13 * 5");
    expect(or.output).toContain("or on Friday");
  });

  it("reports bad expressions", async () => {
    expect((await run("cron-explain", "61 * * * *")).note).toMatch(/out of range/);
    expect((await run("cron-explain", "0 0 * * * *")).note).toMatch(/Quartz/);
    expect((await run("cron-explain", "0 0 * *")).note).toMatch(/Expected 5 fields/);
    expect((await run("cron-explain", "0 0 31 2 *")).note).toMatch(/never fires/);
    expect((await run("cron-explain", "@reboot")).ok).toBe(false);
  });
});

describe("test-data", () => {
  it("generates realistic rows in JSON, CSV and SQL, repeatable by seed", async () => {
    const a = await run("test-data", "7", { rows: "25" });
    const people = JSON.parse(a.output);
    expect(people).toHaveLength(25);
    expect(Object.keys(people[0])).toEqual(["id", "first_name", "last_name", "email", "phone", "city", "country", "company", "signup_date"]);
    expect(new Set(people.map((p: { email: string }) => p.email)).size).toBe(25);
    for (const p of people) {
      expect(p.email).toMatch(/^[a-z]+\.[a-z]+\d*@example\.(com|org|net)$/);
      expect(p.signup_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    }
    expect((await run("test-data", "7", { rows: "25" })).output).toBe(a.output);

    const csv = await run("test-data", "7", { rows: "5", format: "CSV" });
    expect(csv.language).toBe("csv");
    expect(csv.output.split("\n")).toHaveLength(6);
    const sql = await run("test-data", "7", { rows: "50", format: "SQL INSERT" });
    expect(sql.output).toMatch(/^INSERT INTO people \(id, first_name/);
    expect(sql.output.trim().endsWith(");")).toBe(true);
    expect(sql.output).not.toMatch(/O'Brien'/); // quotes are doubled, not raw
  });
});

describe("number-base", () => {
  it("shows every base, including big numbers and negatives", async () => {
    const r = await run("number-base", "255");
    expect(r.output).toBe("Decimal  255\nHex      0xff\nBinary   0b11111111\nOctal    0o377");
    expect((await run("number-base", "0b1010")).output).toContain("Decimal  10");
    expect((await run("number-base", "0o17")).output).toContain("Decimal  15");
    const big = await run("number-base", "0xffffffffffffffffffff");
    expect(big.output).toContain("Decimal  1208925819614629174706175");
    expect(big.note).toContain("80 bits");
    expect((await run("number-base", "-10")).output).toContain("Hex      -0xa");
  });

  it("rejects non-integers", async () => {
    expect((await run("number-base", "0xZZ")).note).toMatch(/Hex digits/);
    expect((await run("number-base", "3.5")).note).toMatch(/Integers only/);
    expect((await run("number-base", "hello")).ok).toBe(false);
  });
});

describe("color", () => {
  it("converts between hex, rgb and hsl with contrast verdicts", async () => {
    const r = await run("color", "rgb(255, 0, 0)");
    expect(r.output).toContain("HEX  #ff0000");
    expect(r.output).toContain("HSL  hsl(0, 100%, 50%)");
    const h = await run("color", "hsl(217, 91%, 60%)");
    expect(h.output).toContain("HEX  #3c83f6");
    const white = await run("color", "#fff");
    expect(white.output).toContain("Contrast on black  21.00:1  AAA");
    const grey = await run("color", "#777777");
    expect(grey.output).toMatch(/Contrast on white\s+4\.48:1\s+AA large text only/);
    expect((await run("color", "#11223380")).output).toContain("rgba(17, 34, 51, 0.502)");
  });

  it("rejects unreadable colors", async () => {
    expect((await run("color", "#12345")).ok).toBe(false);
    expect((await run("color", "rgb(300, 0, 0)")).note).toMatch(/0-255/);
    expect((await run("color", "hsl(10, 200%, 50%)")).ok).toBe(false);
  });
});

describe("password", () => {
  it("generates passwords of the chosen length and alphabet, with entropy", async () => {
    const r = await run("password", "", { length: "24", characters: "No look-alikes" });
    const lines = r.output.split("\n");
    expect(lines).toHaveLength(5);
    for (const l of lines) {
      expect(l).toHaveLength(24);
      expect(l).not.toMatch(/[Il1O0o]/);
    }
    expect(r.note).toMatch(/~\d+ bits of entropy/);
    expect((await run("password", "", { length: "12", characters: "Letters & digits" })).output).toMatch(/^[A-Za-z0-9\n]+$/);
  });

  it("fails cleanly with no crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    expect((await run("password", "")).ok).toBe(false);
  });
});

describe("text-stats", () => {
  it("counts characters, words, lines, bytes and tokens", async () => {
    const r = await run("text-stats", "héllo world\nsecond line");
    expect(r.output).toMatch(/Characters\s+23/);
    expect(r.output).toMatch(/Words\s+4/);
    expect(r.output).toMatch(/Lines\s+2/);
    expect(r.output).toMatch(/Bytes \(UTF-8\)\s+24/);
    expect(r.output).toMatch(/LLM tokens\s+~6/);
    expect(r.note).toBe("4 words · ~6 tokens");
  });
});

describe("html-entities", () => {
  it("encodes and decodes", async () => {
    expect((await run("html-entities", `<a href="x">Tom & 'J'</a>`)).output).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;J&#39;&lt;/a&gt;"
    );
    expect((await run("html-entities", "é😀", { mode: "Encode non-ASCII" })).output).toBe("&#xE9;&#x1F600;");
    const d = await run("html-entities", "&lt;b&gt; &amp;amp; &#x1F600; &#233; &copy; &bogus;", { mode: "Decode" });
    expect(d.output).toBe("<b> &amp; 😀 é © &bogus;");
    expect(d.note).toContain("1 unknown entity");
  });
});

describe("sql-format", () => {
  it("uppercases keywords, puts clauses on lines and leaves literals alone", async () => {
    const r = await run(
      "sql-format",
      "select id, name from users where status = 'select from where' and age between 18 and 30 order by name"
    );
    expect(r.output).toBe(
      [
        "SELECT id,",
        "  name",
        "FROM users",
        "WHERE status = 'select from where'",
        "  AND age BETWEEN 18 AND 30",
        "ORDER BY name",
      ].join("\n")
    );
  });

  it("indents subqueries and keeps function calls tight", async () => {
    const r = await run("sql-format", "select count(*) from t where id in (select user_id from orders)");
    expect(r.output).toBe(
      ["SELECT COUNT(*)", "FROM t", "WHERE id IN (", "  SELECT user_id", "  FROM orders", ")"].join("\n")
    );
  });

  it("reports an unterminated string", async () => {
    const r = await run("sql-format", "select 'oops from t");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("line 1, column 8");
  });
});
