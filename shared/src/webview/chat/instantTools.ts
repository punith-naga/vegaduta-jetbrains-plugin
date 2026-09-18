// Instant Tools: developer utilities that run 100% inside the webview. No
// sign-in, no model, no network - the panel is useful the moment it opens.
// Pure (DOM-free) so every tool is unit-tested; main.ts only renders them.
// Every run() is wrapped so bad input comes back as ok:false with a note and
// never throws.

export type InstantCategory = "data" | "encode" | "time" | "text" | "generate" | "security";

export interface InstantOption {
  id: string;
  label: string;
  choices: string[];
  default: string;
}

export interface InstantResult {
  ok: boolean;
  output: string;
  /** markdown code-fence language for output, e.g. "json" */
  language?: string;
  /** one short human line, e.g. "Valid JSON · 3 keys" or the error location */
  note?: string;
}

export interface InstantTool {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: InstantCategory;
  placeholder: string;
  sample: string;
  options?: InstantOption[];
  run(input: string, options: Record<string, string>): InstantResult | Promise<InstantResult>;
}

export const INSTANT_CATEGORY_LABELS: Record<InstantCategory, string> = {
  data: "Data & formats",
  encode: "Encode & decode",
  time: "Time & dates",
  text: "Text",
  generate: "Generate",
  security: "Security",
};

// --- shared helpers ---------------------------------------------------------------

function ok(output: string, language?: string, note?: string): InstantResult {
  return { ok: true, output, ...(language ? { language } : {}), ...(note ? { note } : {}) };
}

function fail(note: string, output = ""): InstantResult {
  return { ok: false, output, note };
}

/** Fills missing/unknown option values with the option's default, runs the
 * tool, and turns any exception (sync or async) into ok:false. */
function defineTool(def: InstantTool): InstantTool {
  const inner = def.run;
  return {
    ...def,
    run(input: string, options: Record<string, string>) {
      const opts: Record<string, string> = {};
      for (const o of def.options ?? []) {
        const v = options?.[o.id];
        opts[o.id] = typeof v === "string" && o.choices.includes(v) ? v : o.default;
      }
      const crashed = (e: unknown): InstantResult =>
        fail(`Could not process that input: ${e instanceof Error ? e.message : String(e)}`);
      try {
        const r = inner(typeof input === "string" ? input : String(input ?? ""), opts);
        return r instanceof Promise ? r.catch(crashed) : r;
      } catch (e) {
        return crashed(e);
      }
    },
  };
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8 text. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** "a", "a and b", "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 45s, 12m, 3h, 2d, 1.5y - a compact duration for "3h ago" / "in 2d". */
export function compactDuration(ms: number): string {
  const s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

/** "in 2d" / "3h ago" / "just now". */
function relativeTo(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (Math.abs(diff) < 1000) return "just now";
  return diff > 0 ? `in ${compactDuration(diff)}` : `${compactDuration(diff)} ago`;
}

/** 1-based line and column of a string offset. */
function lineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, pos));
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  return { line, col: pos - (before.lastIndexOf("\n") + 1) + 1 };
}

function getCrypto(): Crypto | undefined {
  return (globalThis as { crypto?: Crypto }).crypto;
}

// --- base64 (own codec: UTF-8 safe, strict, no atob/btoa quirks) -------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array, urlSafe = false): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return urlSafe ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
}

/** Accepts standard and URL-safe alphabets, with or without padding. */
function base64ToBytes(input: string): { bytes: Uint8Array } | { error: string } {
  const compact = input.replace(/\s+/g, "");
  const bad = /[^A-Za-z0-9+/\-_=]/.exec(compact);
  if (bad) return { error: `"${bad[0]}" at position ${bad.index + 1} is not a base64 character` };
  const body = compact.replace(/=+$/, "");
  if (body.includes("=")) return { error: `Padding "=" found in the middle at position ${body.indexOf("=") + 1}` };
  if (compact.length - body.length > 2) return { error: "Too much \"=\" padding at the end" };
  if (body.length % 4 === 1) return { error: "Length is not valid base64 - a character is missing or extra" };
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of body.replace(/-/g, "+").replace(/_/g, "/")) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
      buf &= (1 << bits) - 1;
    }
  }
  return { bytes: Uint8Array.from(out) };
}

// --- 1. JSON -----------------------------------------------------------------------

/** Finds the first syntax error in invalid JSON with a message that says what
 * was expected. Engines word (and position) JSON.parse errors differently, so
 * a tiny scanner gives the same line/column everywhere. */
export function locateJsonError(text: string): { pos: number; message: string } | null {
  let i = 0;
  const n = text.length;
  const stop = (message: string, at = i): never => {
    throw { pos: at, message };
  };
  const ws = () => {
    while (i < n && /[ \t\n\r]/.test(text[i])) i++;
  };
  const unexpected = (): never => {
    if (i >= n) return stop("Unexpected end of input - something is not closed");
    const c = text[i];
    if (c === "'") return stop("Strings must use double quotes, not single quotes");
    if (c === "/") return stop("Comments are not allowed in JSON");
    return stop(`Unexpected character "${c}"`);
  };
  const str = () => {
    i++;
    for (;;) {
      if (i >= n) stop("Unterminated string");
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) stop("Invalid \\u escape - needs 4 hex digits");
          i += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) stop(`Invalid escape "\\${e ?? ""}"`);
        i += 2;
        continue;
      }
      if (c < " ") stop("Raw control character (e.g. a newline or tab) inside a string - escape it");
      i++;
    }
  };
  const value = (depth: number): void => {
    if (depth > 2000) stop("Nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') {
          if (text[i] === "}") stop("Trailing comma before \"}\"");
          if (text[i] === "'") stop("Keys must use double quotes, not single quotes");
          stop(i >= n ? "Unexpected end of input - \"}\" missing" : "Expected a property name in double quotes");
        }
        str();
        ws();
        if (text[i] !== ":") stop("Expected \":\" after the property name");
        i++;
        value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        stop(i >= n ? "Unexpected end of input - \"}\" missing" : "Expected \",\" or \"}\" after a property value");
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] === "]") stop("Trailing comma before \"]\"");
        value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        stop(i >= n ? "Unexpected end of input - \"]\" missing" : "Expected \",\" or \"]\" after an array item");
      }
    }
    if (c === '"') return str();
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
      m.lastIndex = i;
      const hit = m.exec(text);
      if (!hit) stop("Invalid number");
      i += hit![0].length;
      if (i < n && /[0-9.eE]/.test(text[i])) stop("Invalid number (leading zeros and trailing dots are not allowed)");
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    unexpected();
  };
  try {
    value(0);
    ws();
    if (i < n) stop("Unexpected content after the JSON value");
    return null;
  } catch (e) {
    if (e && typeof e === "object" && "pos" in e) return e as { pos: number; message: string };
    return null;
  }
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function describeJson(v: unknown): string {
  if (Array.isArray(v)) return `array of ${plural(v.length, "item")}`;
  if (v === null) return "null";
  if (typeof v === "object") return `object with ${plural(Object.keys(v as object).length, "key")}`;
  return typeof v;
}

function runJson(input: string, opts: Record<string, string>): InstantResult {
  const text = input.replace(/^﻿/, "");
  if (!text.trim()) return fail("Paste some JSON to format, minify or validate");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const loc = locateJsonError(text);
    if (!loc) return fail(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    const { line, col } = lineCol(text, loc.pos);
    const src = text.split("\n")[line - 1] ?? "";
    return fail(`Invalid JSON at line ${line}, column ${col}: ${loc.message}`, `${src}\n${" ".repeat(col - 1)}^`);
  }
  const mode = opts.mode;
  if (mode === "Minify") {
    const out = JSON.stringify(value);
    return ok(out, "json", `Valid JSON · ${describeJson(value)} · ${text.length} → ${out.length} chars`);
  }
  if (mode === "Sort keys") return ok(JSON.stringify(sortKeysDeep(value), null, 2), "json", `Keys sorted · ${describeJson(value)}`);
  return ok(JSON.stringify(value, null, 2), "json", `Valid JSON · ${describeJson(value)}`);
}

// --- 2. JWT decode -----------------------------------------------------------------

function decodeJwtPart(part: string, which: string): { value: unknown } | { error: string } {
  const b = base64ToBytes(part);
  if ("error" in b) return { error: `The ${which} is not base64url: ${b.error}` };
  const text = decodeUtf8(b.bytes);
  if (text === null) return { error: `The ${which} is not UTF-8 text` };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `The ${which} is not JSON` };
  }
}

function runJwt(input: string): InstantResult {
  const token = input.trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
  if (!token) return fail("Paste a JWT (the eyJ... string) to decode it locally");
  const parts = token.split(".");
  if (parts.length === 5) return fail("This is an encrypted JWE (5 parts) - its payload cannot be read without the key");
  if (parts.length !== 3 && parts.length !== 2) {
    return fail(`Not a JWT: expected 3 dot-separated parts, found ${parts.length}`);
  }
  const header = decodeJwtPart(parts[0], "header");
  if ("error" in header) return fail(header.error);
  const payload = decodeJwtPart(parts[1], "payload");
  if ("error" in payload) return fail(payload.error);

  const now = Date.now();
  const times: Record<string, string> = {};
  let status = "";
  const claims = payload.value && typeof payload.value === "object" ? (payload.value as Record<string, unknown>) : {};
  for (const key of ["iat", "nbf", "exp"]) {
    const v = claims[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const ms = v * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) continue;
    const rel = relativeTo(ms, now);
    const future = ms > now;
    let human: string;
    if (key === "exp") {
      human = future ? `expires ${rel}` : `expired ${rel}`;
      status = human;
    } else if (key === "iat") {
      human = `issued ${rel}`;
    } else {
      human = future ? `not valid until ${rel}` : `valid since ${rel}`;
    }
    times[key] = `${d.toISOString()} · ${human}`;
  }
  const out: Record<string, unknown> = { header: header.value, payload: payload.value };
  if (Object.keys(times).length) out.timestamps = times;
  const alg =
    header.value && typeof header.value === "object" ? (header.value as Record<string, unknown>).alg : undefined;
  const bits = ["Signature NOT verified - decoded locally only"];
  if (typeof alg === "string") bits.push(alg);
  if (status) bits.push(status);
  return ok(JSON.stringify(out, null, 2), "json", bits.join(" · "));
}

// --- 3. Base64 ---------------------------------------------------------------------

function runBase64(input: string, opts: Record<string, string>): InstantResult {
  const urlSafe = opts.variant === "URL-safe";
  if (opts.mode === "Encode") {
    if (!input) return fail("Type or paste text to encode");
    const bytes = utf8(input);
    return ok(bytesToBase64(bytes, urlSafe), "text", `${plural(bytes.length, "byte")} → base64${urlSafe ? " (URL-safe)" : ""}`);
  }
  if (!input.trim()) return fail("Paste base64 to decode");
  const r = base64ToBytes(input);
  if ("error" in r) return fail(`Not valid base64: ${r.error}`);
  const text = decodeUtf8(r.bytes);
  if (text === null) {
    return ok(toHex(r.bytes).replace(/(.{2})/g, "$1 ").trim(), "text", `Binary data, not UTF-8 text - shown as hex (${plural(r.bytes.length, "byte")})`);
  }
  return ok(text, "text", `Decoded ${plural(r.bytes.length, "byte")} of UTF-8 text`);
}

// --- 4. URL encode / decode / parse ------------------------------------------------

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Query string (or a full URL) → { key: value | value[] }. */
export function parseQueryString(input: string): Record<string, string | string[]> {
  let q = input.trim();
  const hash = q.indexOf("#");
  if (hash >= 0) q = q.slice(0, hash);
  const qm = q.indexOf("?");
  if (qm >= 0) q = q.slice(qm + 1);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) q = "";
  const out: Record<string, string | string[]> = {};
  for (const pair of q.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = safeDecode((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, " "));
    const val = eq >= 0 ? safeDecode(pair.slice(eq + 1).replace(/\+/g, " ")) : "";
    const prev = out[key];
    if (prev === undefined) out[key] = val;
    else out[key] = Array.isArray(prev) ? [...prev, val] : [prev, val];
  }
  return out;
}

function runUrl(input: string, opts: Record<string, string>): InstantResult {
  if (!input) return fail("Type or paste text or a URL");
  if (opts.mode === "Encode") {
    try {
      return ok(encodeURIComponent(input), "text", "Encoded as a URL component");
    } catch {
      return fail("The text contains a broken Unicode character (lone surrogate) that cannot be encoded");
    }
  }
  if (opts.mode === "Decode") {
    try {
      return ok(decodeURIComponent(input), "text", "Decoded URL component");
    } catch {
      const bad = /%(?![0-9a-fA-F]{2})/.exec(input);
      return fail(
        bad
          ? `Malformed escape "${input.slice(bad.index, bad.index + 3)}" at position ${bad.index + 1}`
          : "Malformed percent-encoding: the bytes are not valid UTF-8"
      );
    }
  }
  const params = parseQueryString(input);
  const count = Object.keys(params).length;
  if (count === 0) return fail("No query parameters found - paste a=1&b=2 or a URL with ?a=1");
  return ok(JSON.stringify(params, null, 2), "json", plural(count, "parameter"));
}

// --- 5. UUID -----------------------------------------------------------------------

export function uuidV4(): string {
  const c = getCrypto();
  if (!c) throw new Error("No secure random source in this environment");
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function runUuid(_input: string, opts: Record<string, string>): InstantResult {
  if (!getCrypto()) return fail("No secure random source available here");
  const n = Number(opts.count);
  const ids = Array.from({ length: n }, () => uuidV4());
  return ok(ids.join("\n"), "text", `${plural(n, "random v4 UUID")}`);
}

// --- 6. Hash -----------------------------------------------------------------------

async function runHash(input: string, opts: Record<string, string>): Promise<InstantResult> {
  const subtle = getCrypto()?.subtle;
  if (!subtle) return fail("Hashing needs Web Crypto, which this context does not provide");
  const bytes = utf8(input);
  const digest = new Uint8Array(await subtle.digest(opts.algorithm, new Uint8Array(bytes)));
  const hex = toHex(digest);
  return ok(hex, "text", `${opts.algorithm} of ${plural(bytes.length, "byte")}${bytes.length === 0 ? " (empty input)" : ""} · ${hex.length} hex chars`);
}

// --- 7. Timestamp ------------------------------------------------------------------

function runTimestamp(input: string): InstantResult {
  const s = input.trim();
  let ms: number;
  let detected: string;
  if (!s) {
    ms = Date.now();
    detected = "Now";
  } else if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const abs = Math.abs(n);
    // Magnitude decides the unit: 1e11 seconds is year 5138, 1e11 ms is 1973.
    if (abs < 1e11) [ms, detected] = [n * 1000, "Epoch seconds"];
    else if (abs < 1e14) [ms, detected] = [n, "Epoch milliseconds"];
    else if (abs < 1e17) [ms, detected] = [n / 1000, "Epoch microseconds"];
    else [ms, detected] = [n / 1e6, "Epoch nanoseconds"];
  } else {
    ms = Date.parse(s);
    if (Number.isNaN(ms)) return fail(`Could not read "${s.slice(0, 40)}" as a date. Try 1789000000, 2026-09-18T10:00:00Z or "Sep 18 2026"`);
    detected = "Date string";
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return fail("That timestamp is outside the range a date can represent");
  const rows: [string, string][] = [
    ["ISO (UTC)", d.toISOString()],
    ["Local", d.toString()],
    ["Relative", relativeTo(ms, Date.now())],
    ["Epoch s", String(Math.floor(ms / 1000))],
    ["Epoch ms", String(Math.floor(ms))],
  ];
  return ok(rows.map(([k, v]) => `${k.padEnd(10)} ${v}`).join("\n"), "text", `Detected: ${detected}`);
}

// --- 8. Regex tester ---------------------------------------------------------------

const REGEX_MAX_INPUT = 20_000;
const REGEX_MAX_MATCHES = 500;

function runRegex(input: string): InstantResult {
  const nl = input.indexOf("\n");
  const first = (nl >= 0 ? input.slice(0, nl) : input).replace(/\r$/, "");
  let text = nl >= 0 ? input.slice(nl + 1) : "";
  if (!first.trim()) return fail("Put the pattern on the first line (e.g. /foo(\\d+)/gi) and the test text below it");
  let pattern = first;
  let flags = "g";
  const lit = /^\/(.+)\/([a-z]*)$/s.exec(first.trim());
  if (lit) [pattern, flags] = [lit[1], lit[2]];
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch (e) {
    return fail(`Invalid pattern: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : String(e)}`);
  }
  const notes: string[] = [];
  if (text.length > REGEX_MAX_INPUT) {
    text = text.slice(0, REGEX_MAX_INPUT);
    notes.push(`test text cut to the first ${REGEX_MAX_INPUT.toLocaleString("en-US")} chars`);
  }
  if (!text) return ok("(no test text yet)", "text", "Pattern is valid - add test text on the lines below it");
  const onlyFirst = !flags.includes("g");
  const lines: string[] = [];
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    count++;
    lines.push(`#${count}  index ${m.index}  ${JSON.stringify(m[0])}`);
    for (let g = 1; g < m.length; g++) lines.push(`    $${g}  ${m[g] === undefined ? "(no match)" : JSON.stringify(m[g])}`);
    for (const [name, v] of Object.entries(m.groups ?? {})) {
      lines.push(`    <${name}>  ${v === undefined ? "(no match)" : JSON.stringify(v)}`);
    }
    if (m[0] === "") re.lastIndex++; // zero-length match: step past it
    if (onlyFirst) {
      notes.push("no g flag - first match only");
      break;
    }
    if (count >= REGEX_MAX_MATCHES) {
      notes.push(`stopped at ${REGEX_MAX_MATCHES} matches`);
      break;
    }
  }
  const head = count === 0 ? "No matches" : plural(count, "match", "matches");
  return ok(count ? lines.join("\n") : "No matches", "text", [head, `/${re.source}/${flags}`, ...notes].join(" · "));
}

// --- 9. Case converter -------------------------------------------------------------

export const CASE_TARGETS = ["camelCase", "PascalCase", "snake_case", "kebab-case", "CONSTANT_CASE", "Title Case", "lower case", "UPPER CASE"];

/** Words of an identifier or phrase: splits on separators and case changes
 * (XMLHttpRequest → XML, Http, Request). */
export function splitWords(s: string): string[] {
  return s
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

export function convertCase(line: string, target: string): string {
  if (target === "lower case") return line.toLowerCase();
  if (target === "UPPER CASE") return line.toUpperCase();
  const w = splitWords(line);
  switch (target) {
    case "camelCase":
      return w.map((x, i) => (i === 0 ? x.toLowerCase() : cap(x))).join("");
    case "PascalCase":
      return w.map(cap).join("");
    case "snake_case":
      return w.map((x) => x.toLowerCase()).join("_");
    case "kebab-case":
      return w.map((x) => x.toLowerCase()).join("-");
    case "CONSTANT_CASE":
      return w.map((x) => x.toUpperCase()).join("_");
    default:
      return w.map(cap).join(" ");
  }
}

function runCase(input: string, opts: Record<string, string>): InstantResult {
  if (!input.trim()) return fail("Type one name or phrase per line");
  const lines = input.split(/\r?\n/);
  const out = lines.map((l) => convertCase(l, opts.target));
  return ok(out.join("\n"), "text", `${plural(lines.filter((l) => l.trim()).length, "line")} → ${opts.target}`);
}

// --- 10. Text diff -----------------------------------------------------------------

type DiffOp = { t: " " | "-" | "+"; s: string };

/** Line diff by LCS (after trimming the common prefix/suffix). Null when the
 * changed middle is too large to diff in the webview. */
export function diffLines(a: string[], b: string[]): DiffOp[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return null;
  // dp[i*(m+1)+j] = LCS length of A[i..] and B[j..], so the walk goes forward.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: DiffOp[] = a.slice(0, pre).map((s) => ({ t: " ", s }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ t: " ", s: A[i] });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
      ops.push({ t: "-", s: A[i++] });
    } else {
      ops.push({ t: "+", s: B[j++] });
    }
  }
  for (const s of a.slice(a.length - suf)) ops.push({ t: " ", s });
  return ops;
}

/** Unified-diff hunks with 3 lines of context. */
function unifiedHunks(ops: DiffOp[], context = 3): string[] {
  const aPos: number[] = [];
  const bPos: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aPos.push(ai);
    bPos.push(bi);
    if (op.t !== "+") ai++;
    if (op.t !== "-") bi++;
  }
  const ranges: [number, number][] = [];
  ops.forEach((op, k) => {
    if (op.t === " ") return;
    const s = Math.max(0, k - context);
    const e = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  });
  const out: string[] = [];
  for (const [s, e] of ranges) {
    const slice = ops.slice(s, e + 1);
    const aCount = slice.filter((o) => o.t !== "+").length;
    const bCount = slice.filter((o) => o.t !== "-").length;
    const aStart = aCount ? aPos[s] + 1 : aPos[s];
    const bStart = bCount ? bPos[s] + 1 : bPos[s];
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
  }
  return out;
}

function runDiff(input: string): InstantResult {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const sep = lines.findIndex((l) => /^-{5,}\s*$/.test(l));
  if (sep < 0) return fail("Put a line of ----- (5 or more dashes) between the original and the changed text");
  const a = lines.slice(0, sep);
  const b = lines.slice(sep + 1);
  const ops = diffLines(a, b);
  if (!ops) return fail("Too large to diff here - the changed part must be under about 2,000 × 2,000 lines");
  const adds = ops.filter((o) => o.t === "+").length;
  const dels = ops.filter((o) => o.t === "-").length;
  if (adds === 0 && dels === 0) return ok("(no differences)", "diff", `Identical · ${plural(a.length, "line")}`);
  const out = ["--- original", "+++ changed", ...unifiedHunks(ops)];
  return ok(out.join("\n"), "diff", `+${adds} −${dels} lines`);
}

// --- 11. Cron explain --------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface CronSpec {
  name: string;
  unit: string;
  min: number;
  max: number;
  names?: string[];
  fmt: (v: number) => string;
}

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
};

const CRON_SPECS: CronSpec[] = [
  { name: "minute", unit: "minute", min: 0, max: 59, fmt: String },
  { name: "hour", unit: "hour", min: 0, max: 23, fmt: String },
  { name: "day-of-month", unit: "day", min: 1, max: 31, fmt: ordinal },
  { name: "month", unit: "month", min: 1, max: 12, names: MONTHS.map((m) => m.slice(0, 3).toLowerCase()), fmt: (v) => MONTHS[v - 1] },
  { name: "day-of-week", unit: "day", min: 0, max: 7, names: DAYS.map((d) => d.slice(0, 3).toLowerCase()), fmt: (v) => DAYS[v % 7] },
];

interface CronPart {
  star: boolean;
  a: number;
  b: number;
  step?: number;
  single: boolean;
}

interface CronField {
  raw: string;
  /** Vixie cron: a field that starts with "*" does not trigger the
   * day-of-month OR day-of-week rule. */
  star: boolean;
  values: number[];
  parts: CronPart[];
  spec: CronSpec;
}

function parseCronField(raw: string, spec: CronSpec, dayField: boolean): CronField | string {
  const text = dayField && raw === "?" ? "*" : raw;
  const parts: CronPart[] = [];
  const values = new Set<number>();
  const num = (tok: string): number | null => {
    if (/^\d+$/.test(tok)) return Number(tok);
    const idx = spec.names?.indexOf(tok.toLowerCase()) ?? -1;
    if (idx < 0) return null;
    return spec.name === "month" ? idx + 1 : idx;
  };
  for (const part of text.split(",")) {
    const m = /^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d+))?$/i.exec(part);
    if (!m || (m[1] === "*" && m[2] !== undefined)) {
      if (/[LW#]/i.test(part)) return `"${part}" in the ${spec.name} field uses L/W/# which standard cron does not support`;
      return `Cannot read "${part}" in the ${spec.name} field`;
    }
    const star = m[1] === "*";
    const step = m[3] !== undefined ? Number(m[3]) : undefined;
    if (step !== undefined && step < 1) return `Step "/${m[3]}" in the ${spec.name} field must be 1 or more`;
    const top = spec.name === "day-of-week" ? 6 : spec.max;
    const a = star ? spec.min : num(m[1]);
    const b = star ? top : m[2] !== undefined ? num(m[2]) : step !== undefined ? top : a;
    if (a === null || b === null) return `"${part}" is not a valid ${spec.name} value`;
    for (const v of [a, b]) {
      if (v < spec.min || v > spec.max) return `${v} is out of range for ${spec.name} (${spec.min}-${spec.max})`;
    }
    if (a > b) return `The range "${part}" in the ${spec.name} field goes backwards`;
    for (let v = a; v <= b; v += step ?? 1) values.add(spec.name === "day-of-week" ? v % 7 : v);
    parts.push({ star, a, b, step, single: !star && m[2] === undefined && step === undefined });
  }
  return { raw: text, star: text.startsWith("*"), values: [...values].sort((x, y) => x - y), parts, spec };
}

function partPhrase(p: CronPart, spec: CronSpec): string {
  const units = `${spec.unit}s`;
  if (p.star) return p.step ? `every ${p.step} ${units}` : `every ${spec.unit}`;
  if (p.single) return spec.fmt(p.a);
  if (p.a !== p.b && (p.step === undefined || p.step === 1)) return `${spec.fmt(p.a)} through ${spec.fmt(p.b)}`;
  return `every ${p.step} ${units} from ${spec.fmt(p.a)} through ${spec.fmt(p.b)}`;
}

const fieldPhrase = (f: CronField): string => joinList(f.parts.map((p) => partPhrase(p, f.spec)));
const allSingles = (f: CronField): boolean => f.parts.every((p) => p.single);
const starStep = (f: CronField): number | undefined =>
  f.parts.length === 1 && f.parts[0].star ? f.parts[0].step : undefined;

function explainCron(f: CronField[]): string {
  const [mi, ho, dom, mo, dow] = f;
  let time: string;
  if (mi.raw === "*" && ho.raw === "*") time = "Every minute";
  else if (starStep(mi) && ho.raw === "*") time = `Every ${starStep(mi)} minutes`;
  else if (allSingles(mi) && allSingles(ho) && mi.values.length * ho.values.length <= 6) {
    const times = ho.values.flatMap((h) => mi.values.map((m) => `${pad2(h)}:${pad2(m)}`));
    time = `At ${joinList(times)}`;
  } else if (allSingles(mi) && ho.raw === "*") {
    time = mi.values.length === 1 && mi.values[0] === 0 ? "At the start of every hour" : `At minute ${joinList(mi.values.map(String))} past every hour`;
  } else {
    const minute =
      mi.raw === "*" ? "Every minute" : starStep(mi) ? `Every ${starStep(mi)} minutes` : `At minute${mi.values.length > 1 ? "s" : ""} ${fieldPhrase(mi)}`;
    const hour =
      ho.raw === "*" ? "" : starStep(ho) ? `, every ${starStep(ho)} hours` : `, during hour${ho.values.length > 1 ? "s" : ""} ${fieldPhrase(ho)}`;
    time = minute + hour;
  }
  const phrases: string[] = [];
  const domRestricted = dom.values.length < 31;
  const dowRestricted = dow.values.length < 7;
  const domText = (() => {
    const p = fieldPhrase(dom);
    return p.startsWith("every") ? `${p} of the month` : `on the ${p} of the month`;
  })();
  const dowText = (() => {
    const p = fieldPhrase(dow);
    return p.startsWith("every") ? p : `on ${p}`;
  })();
  if (domRestricted && dowRestricted && !dom.star && !dow.star) phrases.push(`${domText} or ${dowText}`);
  else {
    if (domRestricted) phrases.push(domText);
    if (dowRestricted) phrases.push(dowText);
  }
  if (mo.values.length < 12) {
    const p = fieldPhrase(mo);
    phrases.push(p.startsWith("every") ? p : `in ${p}`);
  }
  return `${[time, ...phrases].join(", ")}.`;
}

/** Next `count` run times strictly after `fromMs`, in UTC. Scans day by day
 * (not minute by minute) so rare schedules like Feb 29th stay cheap. */
export function nextCronRuns(fields: CronField[], fromMs: number, count = 5): Date[] {
  const [mi, ho, dom, mo, dow] = fields;
  const from = new Date(fromMs);
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const orDays = !dom.star && !dow.star;
  const out: Date[] = [];
  for (let d = 0; d < 366 * 8 && out.length < count; d++) {
    const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + d));
    if (!mo.values.includes(day.getUTCMonth() + 1)) continue;
    const domHit = dom.values.includes(day.getUTCDate());
    const dowHit = dow.values.includes(day.getUTCDay());
    if (orDays ? !(domHit || dowHit) : !(domHit && dowHit)) continue;
    for (const h of ho.values) {
      for (const m of mi.values) {
        const t = day.getTime() + h * 3_600_000 + m * 60_000;
        if (t >= startMs && out.length < count) out.push(new Date(t));
      }
    }
  }
  return out;
}

export function parseCron(expr: string): CronField[] | string {
  const trimmed = expr.trim();
  if (trimmed.toLowerCase() === "@reboot") return "@reboot runs once when the cron daemon starts - it has no schedule";
  const src = CRON_MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (src.startsWith("@")) return `Unknown shortcut "${src}". Known: ${Object.keys(CRON_MACROS).join(", ")}`;
  const parts = src.split(/\s+/);
  if (parts.length === 6 || parts.length === 7) {
    return `That has ${parts.length} fields (seconds/year, Quartz style). Standard cron has 5: minute hour day-of-month month day-of-week`;
  }
  if (parts.length !== 5) return `Expected 5 fields (minute hour day-of-month month day-of-week), found ${parts.length}`;
  const fields: CronField[] = [];
  for (let k = 0; k < 5; k++) {
    const f = parseCronField(parts[k], CRON_SPECS[k], k === 2 || k === 4);
    if (typeof f === "string") return f;
    fields.push(f);
  }
  return fields;
}

function runCron(input: string): InstantResult {
  const expr = input.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#")) ?? "";
  if (!expr.trim()) return fail("Type a cron expression like */15 9-17 * * MON-FRI or @daily");
  const fields = parseCron(expr);
  if (typeof fields === "string") return fail(fields);
  const sentence = explainCron(fields);
  const runs = nextCronRuns(fields, Date.now());
  if (runs.length === 0) return fail("This schedule never fires (for example the 31st of February)", sentence);
  const out = [sentence, "", "Next runs (UTC):", ...runs.map((d) => `  ${d.toISOString()}`)];
  return ok(out.join("\n"), "text", `Next run ${relativeTo(runs[0].getTime(), Date.now())} · times in UTC`);
}

// --- 12. Test data -----------------------------------------------------------------

const FIRST_NAMES = [
  "Ada", "Aarav", "Priya", "Liam", "Sofia", "Noah", "Mei", "Mateo", "Amara", "Lucas",
  "Ananya", "Elena", "Kenji", "Fatima", "Oliver", "Zoë", "Diego", "Ingrid", "Kwame", "Chloé",
  "Arjun", "Hana", "Omar", "Isabella", "Rohan", "Freya", "José", "Leila", "Ethan", "Nia",
];
const LAST_NAMES = [
  "Lovelace", "Sharma", "Patel", "O'Brien", "García", "Nguyen", "Kim", "Müller", "Rossi", "Okafor",
  "Tanaka", "Silva", "Johansson", "Haddad", "Iyer", "Kowalski", "Dubois", "Mensah", "Reddy", "Novak",
  "Fernández", "Chen", "Walker", "Nair", "Schmidt", "Andersen", "Costa", "Hughes", "Menon", "Park",
];
const PLACES: [city: string, country: string, dial: string][] = [
  ["Bengaluru", "India", "+91"], ["Mumbai", "India", "+91"], ["London", "United Kingdom", "+44"],
  ["Berlin", "Germany", "+49"], ["Paris", "France", "+33"], ["Toronto", "Canada", "+1"],
  ["Austin", "United States", "+1"], ["São Paulo", "Brazil", "+55"], ["Tokyo", "Japan", "+81"],
  ["Singapore", "Singapore", "+65"], ["Sydney", "Australia", "+61"], ["Lagos", "Nigeria", "+234"],
  ["Stockholm", "Sweden", "+46"], ["Dubai", "United Arab Emirates", "+971"], ["Madrid", "Spain", "+34"],
];
const COMPANIES = [
  "Northwind Labs", "Bluefin Analytics", "Cobalt Systems", "Lumen Health", "Quartz Robotics",
  "Harbor Logistics", "Juniper Finance", "Orbit Media", "Pinecone Retail", "Saffron Foods",
  "Tidal Energy", "Vertex Studio", "Kestrel Security", "Meridian Travel", "Nimbus Cloudworks",
];
const EMAIL_DOMAINS = ["example.com", "example.org", "example.net"]; // reserved - never real inboxes

/** Small seeded PRNG (mulberry32) so a seed gives the same people. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const asciiSlug = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

export interface FakePerson {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  company: string;
  signup_date: string;
}

export function fakePeople(count: number, seed: number, todayMs = Date.now()): FakePerson[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const digits = (n: number): string => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join("");
  const today = Math.floor(todayMs / 86_400_000) * 86_400_000;
  const used = new Set<string>();
  const people: FakePerson[] = [];
  for (let id = 1; id <= count; id++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const [city, country, dial] = pick(PLACES);
    let local = `${asciiSlug(first)}.${asciiSlug(last)}`;
    for (let k = 2; used.has(local); k++) local = `${asciiSlug(first)}.${asciiSlug(last)}${k}`;
    used.add(local);
    people.push({
      id,
      first_name: first,
      last_name: last,
      email: `${local}@${pick(EMAIL_DOMAINS)}`,
      phone: `${dial} ${String(2 + Math.floor(rnd() * 8))}${digits(2)} ${digits(3)} ${digits(4)}`,
      city,
      country,
      company: pick(COMPANIES),
      signup_date: new Date(today - Math.floor(rnd() * 730) * 86_400_000).toISOString().slice(0, 10),
    });
  }
  return people;
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sqlValue = (v: string | number): string => (typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

function runTestData(input: string, opts: Record<string, string>): InstantResult {
  const n = Number(opts.rows);
  const seedText = input.trim();
  const seed = seedText ? (/^\d+$/.test(seedText) ? Number(seedText) >>> 0 : hashSeed(seedText)) : Math.floor(Math.random() * 2 ** 32);
  const people = fakePeople(n, seed);
  const cols = Object.keys(people[0]) as (keyof FakePerson)[];
  const note = `${plural(n, "fake person", "fake people")}${seedText ? ` · seed "${seedText}" repeats them` : ""}`;
  if (opts.format === "CSV") {
    const lines = [cols.join(","), ...people.map((p) => cols.map((c) => csvCell(p[c])).join(","))];
    return ok(lines.join("\n"), "csv", note);
  }
  if (opts.format === "SQL INSERT") {
    const rows = people.map((p) => `  (${cols.map((c) => sqlValue(p[c])).join(", ")})`);
    return ok(`INSERT INTO people (${cols.join(", ")}) VALUES\n${rows.join(",\n")};`, "sql", note);
  }
  return ok(JSON.stringify(people, null, 2), "json", note);
}

// --- 13. Number base ---------------------------------------------------------------

function runNumberBase(input: string): InstantResult {
  const s = input.trim().replace(/[_,\s]/g, "");
  if (!s) return fail("Type an integer: 255, 0xff, 0b11111111 or 0o377");
  const m = /^([+-]?)(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i.exec(s);
  if (!m) {
    if (/^[+-]?\d*\.\d+$/.test(s)) return fail("Integers only - no decimal point");
    if (/^[+-]?0x/i.test(s)) return fail("Hex digits are 0-9 and a-f");
    if (/^[+-]?0b/i.test(s)) return fail("Binary digits are 0 and 1");
    if (/^[+-]?0o/i.test(s)) return fail("Octal digits are 0-7");
    return fail(`"${s.slice(0, 40)}" is not an integer. Use 255, 0xff, 0b1111 or 0o377`);
  }
  const body = m[2].slice(0, 2).toLowerCase() + m[2].slice(2);
  const abs = BigInt(/^0[xbo]/.test(body) ? body : m[2]);
  const neg = m[1] === "-" && abs !== 0n;
  const sign = neg ? "-" : "";
  const detected = /^0x/.test(body) ? "hex" : /^0b/.test(body) ? "binary" : /^0o/.test(body) ? "octal" : "decimal";
  const rows = [
    `Decimal  ${sign}${abs.toString(10)}`,
    `Hex      ${sign}0x${abs.toString(16)}`,
    `Binary   ${sign}0b${abs.toString(2)}`,
    `Octal    ${sign}0o${abs.toString(8)}`,
  ];
  return ok(rows.join("\n"), "text", `Detected ${detected} · ${plural(abs === 0n ? 1 : abs.toString(2).length, "bit")}`);
}

// --- 14. Color ---------------------------------------------------------------------

type Rgba = { r: number; g: number; b: number; a: number };

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

export function parseColor(input: string): Rgba | string {
  const s = input.trim().toLowerCase().replace(/;$/, "");
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
  if (!fn) return "Use #3b82f6, rgb(59, 130, 246) or hsl(217, 91%, 60%)";
  const args = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (args.length !== 3 && args.length !== 4) return `${fn[1]}() needs 3 values (plus optional alpha), found ${args.length}`;
  const alpha = (t: string | undefined): number | null => {
    if (t === undefined) return 1;
    const v = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  };
  const a = alpha(args[3]);
  if (a === null) return "Alpha must be between 0 and 1 (or 0%-100%)";
  if (fn[1].startsWith("rgb")) {
    const ch = args.slice(0, 3).map((t) => (t.endsWith("%") ? (parseFloat(t) / 100) * 255 : parseFloat(t)));
    if (ch.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return "rgb() channels must be 0-255 (or 0%-100%)";
    return { r: Math.round(ch[0]), g: Math.round(ch[1]), b: Math.round(ch[2]), a };
  }
  const hm = /^(-?[\d.]+)(deg|turn|rad)?$/.exec(args[0]);
  if (!hm) return `Cannot read hue "${args[0]}"`;
  let h = parseFloat(hm[1]) * (hm[2] === "turn" ? 360 : hm[2] === "rad" ? 180 / Math.PI : 1);
  h = ((h % 360) + 360) % 360;
  const pct = (t: string) => (/^[\d.]+%?$/.test(t) ? parseFloat(t) / 100 : NaN);
  const sat = pct(args[1]);
  const lig = pct(args[2]);
  if (![sat, lig].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return "hsl() saturation and lightness must be 0%-100%";
  const [r, g, b] = hslToRgb(h, sat, lig);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(x: Rgba, y: Rgba): number {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

function wcagVerdict(ratio: number): string {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA pass";
  if (ratio >= 3) return "AA large text only";
  return "fails AA";
}

function runColor(input: string): InstantResult {
  if (!input.trim()) return fail("Type a color: #3b82f6, rgb(59, 130, 246) or hsl(217, 91%, 60%)");
  const c = parseColor(input);
  if (typeof c === "string") return fail(c);
  const alphaHex = c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, "0") : "";
  const hex = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}${alphaHex}`;
  const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  const a = c.a < 1 ? `, ${+c.a.toFixed(3)}` : "";
  const white = contrastRatio(c, { r: 255, g: 255, b: 255, a: 1 });
  const black = contrastRatio(c, { r: 0, g: 0, b: 0, a: 1 });
  const rows = [
    `HEX  ${hex}`,
    `RGB  rgb${a ? "a" : ""}(${c.r}, ${c.g}, ${c.b}${a})`,
    `HSL  hsl${a ? "a" : ""}(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%${a})`,
    "",
    `Contrast on white  ${white.toFixed(2)}:1  ${wcagVerdict(white)}`,
    `Contrast on black  ${black.toFixed(2)}:1  ${wcagVerdict(black)}`,
  ];
  const better = white >= black ? "white" : "black";
  return ok(rows.join("\n"), "text", `Best text pairing: ${better}${c.a < 1 ? " · contrast ignores alpha" : ""}`);
}

// --- 15. Password ------------------------------------------------------------------

const PASSWORD_SETS: Record<string, string> = {
  "Letters, digits & symbols": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{};:,.?/",
  "Letters & digits": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "No look-alikes": "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789",
};

/** Uniform index in [0, n) by rejection sampling - no modulo bias. */
function randomIndex(n: number, c: Crypto): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    c.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function generatePassword(length: number, alphabet: string): string {
  const c = getCrypto();
  if (!c) throw new Error("No secure random source in this environment");
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomIndex(alphabet.length, c)];
  return out;
}

function runPassword(_input: string, opts: Record<string, string>): InstantResult {
  if (!getCrypto()) return fail("No secure random source available here");
  const len = Number(opts.length);
  const set = PASSWORD_SETS[opts.characters];
  const list = Array.from({ length: 5 }, () => generatePassword(len, set));
  const bits = Math.floor(len * Math.log2(set.length));
  return ok(list.join("\n"), "text", `5 passwords · ${len} chars · ~${bits} bits of entropy each`);
}

// --- 16. Text stats ----------------------------------------------------------------

function runTextStats(input: string): InstantResult {
  if (!input) return fail("Paste some text to count");
  const chars = Array.from(input).length;
  const words = input.match(/\S+/g)?.length ?? 0;
  const lines = input.split(/\r\n|\r|\n/).length;
  const paragraphs = input.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const bytes = utf8(input).length;
  const tokens = Math.ceil(chars / 4);
  const minutes = words / 238;
  const reading = minutes < 1 ? `~${Math.max(1, Math.round(minutes * 60))} sec` : `~${Math.round(minutes)} min`;
  const rows: [string, string | number][] = [
    ["Characters", chars],
    ["No spaces", Array.from(input.replace(/\s/g, "")).length],
    ["Words", words],
    ["Lines", lines],
    ["Paragraphs", paragraphs],
    ["Bytes (UTF-8)", bytes],
    ["LLM tokens", `~${tokens}`],
    ["Reading time", reading],
  ];
  return ok(rows.map(([k, v]) => `${k.padEnd(14)} ${v}`).join("\n"), "text", `${plural(words, "word")} · ~${tokens} tokens`);
}

// --- 17. HTML entities -------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«",
  raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", deg: "°", plusmn: "±",
  times: "×", divide: "÷", middot: "·", bull: "•", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾",
  iexcl: "¡", iquest: "¿", shy: "­", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥",
  check: "✓", ne: "≠", le: "≤", ge: "≥", infin: "∞",
};

export function encodeHtml(s: string, nonAscii: boolean): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&#39;";
    else if (nonAscii && cp > 126) out += `&#x${cp.toString(16).toUpperCase()};`;
    else out += ch;
  }
  return out;
}

export function decodeHtml(s: string): { text: string; unknown: number } {
  let unknown = 0;
  const text = s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const cp = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
      unknown++;
      return whole;
    }
    const hit = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    if (hit !== undefined) return hit;
    unknown++;
    return whole;
  });
  return { text, unknown };
}

function runHtml(input: string, opts: Record<string, string>): InstantResult {
  if (!input) return fail("Type or paste text or HTML");
  if (opts.mode === "Decode") {
    const { text, unknown } = decodeHtml(input);
    return ok(text, "text", unknown ? `Decoded · ${plural(unknown, "unknown entity", "unknown entities")} left as-is` : "Decoded");
  }
  const out = encodeHtml(input, opts.mode === "Encode non-ASCII");
  return ok(out, "html", out === input ? "Nothing needed escaping" : "Escaped for HTML text and attributes");
}

// --- 18. SQL format ----------------------------------------------------------------

type SqlTok = { t: "word" | "lit" | "num" | "op" | "punct" | "comment" | "lcomment"; v: string };

const SQL_KEYWORDS = new Set(
  (
    "select from where and or not in is null as on join left right inner outer full cross group by order having limit offset " +
    "union all distinct insert into values update set delete create table alter drop primary foreign references default " +
    "case when then else end asc desc between like ilike exists with returning true false count sum avg min max coalesce " +
    "cast over partition using natural intersect except any some recursive lateral nulls"
  ).split(" ")
);
const SQL_COMPOUNDS = [
  ["LEFT", "OUTER", "JOIN"], ["RIGHT", "OUTER", "JOIN"], ["FULL", "OUTER", "JOIN"],
  ["GROUP", "BY"], ["ORDER", "BY"], ["PARTITION", "BY"], ["LEFT", "JOIN"], ["RIGHT", "JOIN"],
  ["INNER", "JOIN"], ["FULL", "JOIN"], ["CROSS", "JOIN"], ["UNION", "ALL"], ["INSERT", "INTO"], ["DELETE", "FROM"],
];
const SQL_CLAUSES = new Set([
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION", "UNION ALL",
  "INTERSECT", "EXCEPT", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "RETURNING", "WITH",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "LEFT OUTER JOIN", "RIGHT OUTER JOIN",
  "FULL OUTER JOIN", "CROSS JOIN",
]);
/** Clauses whose top-level commas start a new line. */
const SQL_LIST_CLAUSES = new Set(["SELECT", "SET", "VALUES"]);
/** Keywords that call like functions: no space before "(". */
const SQL_FUNCS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST"]);

export function tokenizeSql(s: string): SqlTok[] | string {
  const toks: SqlTok[] = [];
  let i = 0;
  const n = s.length;
  const closeQuoted = (open: number, close: string, what: string): number | string => {
    let j = open + 1;
    for (;;) {
      if (j >= n) {
        const { line, col } = lineCol(s, open);
        return `Unterminated ${what} starting at line ${line}, column ${col}`;
      }
      if (s[j] === close) {
        if (s[j + 1] === close && close !== "]") {
          j += 2; // doubled quote is an escaped quote
          continue;
        }
        return j + 1;
      }
      j++;
    }
  };
  while (i < n) {
    const c = s[i];
    const prev = toks[toks.length - 1];
    if (/\s/.test(c)) {
      i++;
    } else if (s.startsWith("--", i)) {
      const e = s.indexOf("\n", i);
      toks.push({ t: "lcomment", v: s.slice(i, e < 0 ? n : e).trimEnd() });
      i = e < 0 ? n : e;
    } else if (s.startsWith("/*", i)) {
      const e = s.indexOf("*/", i + 2);
      if (e < 0) {
        const { line, col } = lineCol(s, i);
        return `Unterminated /* comment starting at line ${line}, column ${col}`;
      }
      toks.push({ t: "comment", v: s.slice(i, e + 2) });
      i = e + 2;
    } else if (c === "'" || (/[nNeExXbB]/.test(c) && s[i + 1] === "'")) {
      const q = c === "'" ? i : i + 1;
      const end = closeQuoted(q, "'", "string literal");
      if (typeof end === "string") return end;
      toks.push({ t: "lit", v: s.slice(i, end) });
      i = end;
    } else if (c === '"' || c === "`" || c === "[") {
      const end = closeQuoted(i, c === "[" ? "]" : c, "quoted identifier");
      if (typeof end === "string") return end;
      toks.push({ t: "lit", v: s.slice(i, end) });
      i = end;
    } else if (
      /\d/.test(c) ||
      (c === "." && /\d/.test(s[i + 1] ?? "")) ||
      (c === "-" && /\d/.test(s[i + 1] ?? "") && (!prev || prev.t === "op" || prev.v === "(" || prev.v === "," || (prev.t === "word" && SQL_KEYWORDS.has(prev.v.toLowerCase()))))
    ) {
      const m = /-?(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/iy;
      m.lastIndex = i;
      const hit = m.exec(s)![0];
      toks.push({ t: "num", v: hit });
      i += hit.length;
    } else if (/[A-Za-z_@#$À-￿]/.test(c) || (c === ":" && /[A-Za-z_]/.test(s[i + 1] ?? ""))) {
      const m = /:?[A-Za-z_@#$À-￿][\w@#$À-￿]*/y;
      m.lastIndex = i;
      const hit = m.exec(s)![0];
      toks.push({ t: "word", v: hit });
      i += hit.length;
    } else if ("(),;.".includes(c)) {
      toks.push({ t: "punct", v: c });
      i++;
    } else {
      const m = /(?:<>|<=|>=|!=|==|\|\||::|->>|->|[^\s\w])/y;
      m.lastIndex = i;
      const hit = m.exec(s)![0];
      toks.push({ t: "op", v: hit });
      i += hit.length;
    }
  }
  return toks;
}

export function formatSql(sql: string): string | { error: string } {
  const raw = tokenizeSql(sql);
  if (typeof raw === "string") return { error: raw };
  // Uppercase keywords (not after "." - that is a column) and merge compounds.
  const toks: SqlTok[] = [];
  for (let k = 0; k < raw.length; k++) {
    const tok = raw[k];
    const afterDot = raw[k - 1]?.v === ".";
    if (tok.t !== "word" || afterDot || !SQL_KEYWORDS.has(tok.v.toLowerCase())) {
      toks.push(tok);
      continue;
    }
    const compound = SQL_COMPOUNDS.find((words) =>
      words.every((w, x) => raw[k + x]?.t === "word" && raw[k + x].v.toUpperCase() === w)
    );
    if (compound) {
      toks.push({ t: "word", v: compound.join(" ") });
      k += compound.length - 1;
    } else toks.push({ t: "word", v: tok.v.toUpperCase() });
  }

  type Frame = { sub: boolean; clause: string; between: boolean };
  const stack: Frame[] = [{ sub: true, clause: "", between: false }];
  const level = () => stack.filter((f) => f.sub).length - 1;
  const lines: string[] = [];
  let line = "";
  let prev: SqlTok | undefined;
  const newline = (indent: number) => {
    if (line.trim()) lines.push(line.trimEnd());
    line = " ".repeat(indent);
  };
  const append = (text: string, space: boolean) => {
    line += line.trim() && space ? ` ${text}` : text;
  };
  const isKw = (t: SqlTok | undefined) => t?.t === "word" && (SQL_KEYWORDS.has(t.v.toLowerCase()) || SQL_CLAUSES.has(t.v));

  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const frame = stack[stack.length - 1];
    const indent = 2 * level();
    let space = true;
    if (tok.v === "," || tok.v === ";" || tok.v === ")" || tok.v === "." || tok.v === "::") space = false;
    if (prev && (prev.v === "(" || prev.v === "." || prev.v === "::")) space = false;
    if (
      tok.v === "(" &&
      prev?.t === "word" &&
      (!isKw(prev) || SQL_FUNCS.has(prev.v)) &&
      frame.clause !== "INSERT INTO"
    ) {
      space = false;
    }

    if (tok.t === "word" && SQL_CLAUSES.has(tok.v) && frame.sub) {
      newline(indent);
      append(tok.v, true);
      frame.clause = tok.v;
      frame.between = false;
    } else if (tok.t === "word" && (tok.v === "AND" || tok.v === "OR") && frame.sub) {
      if (tok.v === "AND" && frame.between) {
        frame.between = false;
        append(tok.v, true);
      } else if (frame.clause === "WHERE" || frame.clause === "HAVING" || frame.clause.endsWith("JOIN")) {
        newline(indent + 2);
        append(tok.v, true);
      } else append(tok.v, true);
    } else if (tok.v === "BETWEEN") {
      frame.between = true;
      append(tok.v, true);
    } else if (tok.v === "(") {
      append("(", space);
      const next = toks[k + 1];
      stack.push({ sub: next?.t === "word" && (next.v === "SELECT" || next.v === "WITH"), clause: "", between: false });
    } else if (tok.v === ")") {
      const closed = stack.length > 1 ? stack.pop()! : undefined;
      if (closed?.sub) newline(2 * level());
      append(")", false);
    } else if (tok.v === ",") {
      append(",", false);
      if (frame.sub && SQL_LIST_CLAUSES.has(frame.clause)) newline(indent + 2);
    } else if (tok.v === ";") {
      append(";", false);
      newline(0);
      lines.push("");
      stack.length = 1;
      stack[0] = { sub: true, clause: "", between: false };
    } else if (tok.t === "lcomment") {
      append(tok.v, true);
      newline(indent + (frame.clause ? 2 : 0));
    } else {
      append(tok.v, space);
    }
    prev = tok;
  }
  newline(0);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function runSql(input: string): InstantResult {
  if (!input.trim()) return fail("Paste a SQL query to format");
  const r = formatSql(input);
  if (typeof r !== "string") return fail(r.error);
  const statements = r.split(/;\s*(?:\n|$)/).filter((x) => x.trim()).length;
  return ok(r, "sql", `Formatted ${plural(statements, "statement")} · string literals untouched`);
}

// --- samples -----------------------------------------------------------------------

const b64urlJson = (v: unknown) => bytesToBase64(utf8(JSON.stringify(v)), true);

const SAMPLE_JWT = [
  b64urlJson({ alg: "HS256", typ: "JWT" }),
  b64urlJson({
    sub: "user_8f2c1a",
    name: "Ada Lovelace",
    email: "ada@example.com",
    roles: ["admin", "developer"],
    iat: 1789000000,
    exp: 1893456000,
  }),
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");

// --- the registry ------------------------------------------------------------------

const TOOL_DEFS: InstantTool[] = [
  {
    id: "json",
    name: "JSON formatter",
    description: "Format, minify or validate JSON - errors point at the exact line and column",
    icon: "code",
    category: "data",
    placeholder: 'Paste JSON, e.g. {"name":"VegaDūta","tags":["ai","dev"]}',
    sample: '{"id":42,"name":"VegaDūta","active":true,"tags":["agents","dev-tools"],"owner":{"team":"platform","region":"ap-south-1"},"score":98.5,"archived":null}',
    options: [{ id: "mode", label: "Mode", choices: ["Format", "Minify", "Sort keys"], default: "Format" }],
    run: runJson,
  },
  {
    id: "jwt-decode",
    name: "JWT decoder",
    description: "Read a JWT's header and claims with human expiry times - nothing leaves this panel",
    icon: "eye",
    category: "security",
    placeholder: "Paste a JWT (eyJhbGciOi...) - it is decoded locally, never sent anywhere",
    sample: SAMPLE_JWT,
    run: runJwt,
  },
  {
    id: "base64",
    name: "Base64",
    description: "Encode or decode base64, UTF-8 safe, standard or URL-safe",
    icon: "layers",
    category: "encode",
    placeholder: "Text to encode, or base64 to decode",
    sample: "Hello, VegaDūta! 👋 Instant tools run offline.",
    options: [
      { id: "mode", label: "Mode", choices: ["Encode", "Decode"], default: "Encode" },
      { id: "variant", label: "Alphabet", choices: ["Standard", "URL-safe"], default: "Standard" },
    ],
    run: runBase64,
  },
  {
    id: "url-encode",
    name: "URL encoder",
    description: "Encode or decode URL components, or turn a query string into JSON",
    icon: "globe",
    category: "encode",
    placeholder: "Text, a%20b, or a URL / query string like a=1&b=x%20y",
    sample: "https://app.vegaduta.ai/search?q=agent%20memory&tags=rag&tags=mcp&page=2&sort=recent",
    options: [{ id: "mode", label: "Mode", choices: ["Encode", "Decode", "Parse query string"], default: "Parse query string" }],
    run: runUrl,
  },
  {
    id: "uuid",
    name: "UUID generator",
    description: "Random v4 UUIDs from the secure random source",
    icon: "spark",
    category: "generate",
    placeholder: "No input needed - pick how many and run",
    sample: "",
    options: [{ id: "count", label: "How many", choices: ["1", "5", "10", "25"], default: "5" }],
    run: runUuid,
  },
  {
    id: "hash",
    name: "Hash",
    description: "SHA-1, SHA-256, SHA-384 or SHA-512 of text, as hex",
    icon: "key",
    category: "security",
    placeholder: "Text to hash (UTF-8)",
    sample: "The quick brown fox jumps over the lazy dog",
    options: [{ id: "algorithm", label: "Algorithm", choices: ["SHA-256", "SHA-1", "SHA-384", "SHA-512"], default: "SHA-256" }],
    run: runHash,
  },
  {
    id: "timestamp",
    name: "Timestamp converter",
    description: "Epoch seconds/ms to dates and back - leave empty for now",
    icon: "target",
    category: "time",
    placeholder: "1789000000, 1789000000000, 2026-09-18T10:00:00Z - or empty for now",
    sample: "1789000000",
    run: runTimestamp,
  },
  {
    id: "regex",
    name: "Regex tester",
    description: "Test a pattern: every match with its index and groups",
    icon: "flask",
    category: "text",
    placeholder: "First line: /pattern/flags\nThen the text to test",
    sample:
      "/(?<user>[\\w.]+)@(?<domain>[\\w-]+\\.\\w+)/g\nContact ada.lovelace@example.com or ops@vegaduta.ai - not @nobody.",
    run: runRegex,
  },
  {
    id: "case-convert",
    name: "Case converter",
    description: "camelCase, snake_case, kebab-case and more - one name per line",
    icon: "wrench",
    category: "text",
    placeholder: "One name or phrase per line, e.g. user_id or XMLHttpRequest",
    sample: "user_id\nXMLHttpRequest\ncreated-at timestamp\nMAX_RETRY_COUNT",
    options: [{ id: "target", label: "Convert to", choices: CASE_TARGETS, default: "camelCase" }],
    run: runCase,
  },
  {
    id: "text-diff",
    name: "Text diff",
    description: "Line diff of two texts separated by a ----- line",
    icon: "commit",
    category: "text",
    placeholder: "Original text\n-----\nChanged text",
    sample:
      "server:\n  port: 8080\n  host: localhost\nlogging:\n  level: info\n-----\nserver:\n  port: 8443\n  host: api.vegaduta.ai\n  tls: true\nlogging:\n  level: info",
    run: runDiff,
  },
  {
    id: "cron-explain",
    name: "Cron explainer",
    description: "A cron expression in plain English, plus the next 5 runs",
    icon: "bolt",
    category: "time",
    placeholder: "*/15 9-17 * * MON-FRI  or  @daily",
    sample: "30 9 * * MON-FRI",
    run: runCron,
  },
  {
    id: "test-data",
    name: "Test data",
    description: "Realistic fake people as JSON, CSV or SQL INSERT",
    icon: "users",
    category: "generate",
    placeholder: "Optional seed (e.g. 42) to get the same rows again - empty for random",
    sample: "42",
    options: [
      { id: "rows", label: "Rows", choices: ["5", "10", "25", "50"], default: "10" },
      { id: "format", label: "Format", choices: ["JSON", "CSV", "SQL INSERT"], default: "JSON" },
    ],
    run: runTestData,
  },
  {
    id: "number-base",
    name: "Number bases",
    description: "An integer in decimal, hex, binary and octal - any size",
    icon: "chip",
    category: "data",
    placeholder: "255, 0xff, 0b11111111 or 0o377",
    sample: "0xDEADBEEF",
    run: runNumberBase,
  },
  {
    id: "color",
    name: "Color converter",
    description: "HEX, RGB and HSL, plus WCAG contrast against white and black",
    icon: "target",
    category: "data",
    placeholder: "#3b82f6, rgb(59, 130, 246) or hsl(217, 91%, 60%)",
    sample: "#3b82f6",
    run: runColor,
  },
  {
    id: "password",
    name: "Password generator",
    description: "Strong random passwords, generated on this device",
    icon: "key",
    category: "security",
    placeholder: "No input needed - pick a length and run",
    sample: "",
    options: [
      { id: "length", label: "Length", choices: ["12", "16", "24", "32"], default: "16" },
      { id: "characters", label: "Characters", choices: Object.keys(PASSWORD_SETS), default: "Letters, digits & symbols" },
    ],
    run: runPassword,
  },
  {
    id: "text-stats",
    name: "Text stats",
    description: "Characters, words, lines, bytes, LLM tokens and reading time",
    icon: "map",
    category: "text",
    placeholder: "Paste any text",
    sample:
      "VegaDūta runs agents where you work.\n\nInstant tools need no sign-in, no model and no network - they are useful the second the panel opens. Paste text here to see how long it is, how many bytes it takes and roughly how many tokens a model would see.",
    run: runTextStats,
  },
  {
    id: "html-entities",
    name: "HTML entities",
    description: "Escape text for HTML, or decode &amp; / &#x27; style entities",
    icon: "code",
    category: "encode",
    placeholder: "<a href=\"x\">Tom & Jerry</a>  or  &lt;b&gt;bold&lt;/b&gt;",
    sample: '<a href="/pricing?plan=pro&seats=5" title="Café & Co">Upgrade → “Pro”</a>',
    options: [{ id: "mode", label: "Mode", choices: ["Encode", "Encode non-ASCII", "Decode"], default: "Encode" }],
    run: runHtml,
  },
  {
    id: "sql-format",
    name: "SQL formatter",
    description: "Uppercase keywords and put each clause on its own line",
    icon: "layers",
    category: "data",
    placeholder: "select id, name from users where active = true order by name",
    sample:
      "select u.id, u.email, count(o.id) as orders from users u left join orders o on o.user_id = u.id and o.status <> 'cancelled' where u.created_at between '2026-01-01' and '2026-06-30' and u.email like '%@example.com' group by u.id, u.email having count(o.id) > 2 order by orders desc limit 20;",
    run: runSql,
  },
];

export const INSTANT_TOOLS: InstantTool[] = TOOL_DEFS.map(defineTool);

export function findInstantTool(id: string): InstantTool | undefined {
  return INSTANT_TOOLS.find((t) => t.id === id);
}
