// Code Tour - pure helpers. The file goes to the model WITH line numbers we
// add ourselves ("  12 | code"), the model answers with a fenced JSON array of
// stops, and parseTourStops reads that array defensively: model output is
// untrusted, so prose around it, missing fences, trailing commas, swapped or
// out-of-range line numbers and junk entries are all tolerated or dropped -
// never trusted and never thrown on.

export interface TourStop {
  title: string;
  /** 1-based, inclusive, clamped to the file. */
  startLine: number;
  endLine: number;
  explanation: string;
}

export const TOUR_MAX_STOPS = 12;
const TITLE_MAX = 120;
const EXPLANATION_MAX = 1200;

/** "  12 | code" for every line, the number right-aligned to the widest one.
 * A trailing newline does not produce an extra numbered empty line. */
export function numberLines(text: string, startLine = 1): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width, " ")} | ${line}`).join("\n");
}

/** Number of lines numberLines would print for `text`. */
export function countLines(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

export const TOUR_INSTRUCTION =
  "Give me a guided tour of the attached file for someone reading it for the first time. " +
  "Every line of the file is prefixed with its line number and \" | \" - use those numbers, and do not include the prefixes in your explanations. " +
  "Pick 3 to 8 stops in reading order: the entry points, the key data structures and the non-obvious logic. " +
  "Start with one or two sentences on what the file is for. Then give the stops as ONE fenced ```json code block " +
  'containing an array of objects exactly like {"title": "...", "startLine": 12, "endLine": 30, "explanation": "..."}. ' +
  "Keep each explanation to two or three sentences.";

/** Extract candidate JSON array text from a model answer: a ```json fence
 * first, then any fence holding an array, then the outermost [ ... ]. */
function candidateArrays(answer: string): string[] {
  const out: string[] = [];
  const fence = /```([A-Za-z]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  const tagged: string[] = [];
  const other: string[] = [];
  for (const m of answer.matchAll(fence)) {
    const body = m[2].trim();
    if (!body.includes("[")) continue;
    if (m[1].toLowerCase() === "json") tagged.push(body);
    else other.push(body);
  }
  out.push(...tagged, ...other);
  const first = answer.indexOf("[");
  const last = answer.lastIndexOf("]");
  if (first >= 0 && last > first) out.push(answer.slice(first, last + 1));
  return out;
}

function tryParseArray(text: string): unknown[] | null {
  const attempts = [text];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const a of attempts) {
    for (const variant of [a, a.replace(/,\s*([\]}])/g, "$1")]) {
      try {
        const v: unknown = JSON.parse(variant);
        if (Array.isArray(v)) return v;
        if (v && typeof v === "object" && Array.isArray((v as { stops?: unknown }).stops)) {
          return (v as { stops: unknown[] }).stops;
        }
      } catch {
        // try the next variant
      }
    }
  }
  return null;
}

function toLine(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Stops from a model answer, validated against a file of `lineCount` lines.
 * Line numbers are clamped into 1..lineCount and swapped when reversed; a
 * stop that starts beyond the file, has no usable line, or has no title and
 * no explanation is dropped. At most TOUR_MAX_STOPS are kept. */
export function parseTourStops(answer: string, lineCount: number): TourStop[] {
  if (typeof answer !== "string" || !answer) return [];
  const max = Number.isFinite(lineCount) && lineCount >= 1 ? Math.floor(lineCount) : Number.MAX_SAFE_INTEGER;
  for (const candidate of candidateArrays(answer)) {
    const arr = tryParseArray(candidate);
    if (!arr) continue;
    const stops: TourStop[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      let start = toLine(r.startLine ?? r.start ?? r.line);
      let end = toLine(r.endLine ?? r.end ?? r.startLine ?? r.start ?? r.line);
      if (start === null) continue;
      if (end === null) end = start;
      if (end < start) [start, end] = [end, start];
      if (start > max || end < 1) continue;
      start = Math.max(1, start);
      end = Math.min(max, end);
      const title = cleanText(r.title ?? r.name, TITLE_MAX);
      const explanation = cleanText(r.explanation ?? r.description ?? r.text, EXPLANATION_MAX);
      if (!title && !explanation) continue;
      stops.push({ title: title || `Lines ${start}-${end}`, startLine: start, endLine: end, explanation });
      if (stops.length >= TOUR_MAX_STOPS) break;
    }
    if (stops.length) return stops;
  }
  return [];
}

/** The answer with its JSON stop block removed - the prose around it, shown
 * above the rendered stop list. */
export function tourProse(answer: string): string {
  return answer
    .replace(/```json[^\n]*\n[\s\S]*?(?:```|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatStopRange(stop: Pick<TourStop, "startLine" | "endLine">): string {
  return stop.startLine === stop.endLine ? `Line ${stop.startLine}` : `Lines ${stop.startLine}–${stop.endLine}`;
}
