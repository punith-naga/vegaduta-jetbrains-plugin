// Hand-written, dependency-free Markdown for assistant messages.
//
// SECURITY MODEL (this runs in a Chrome extension page and in IDE webviews):
//   - parseMarkdown() produces plain data (blocks + inlines). No HTML is ever
//     parsed or passed through: "<script>" in model output is literal text.
//   - renderMarkdown() builds DOM exclusively with createElement /
//     createTextNode / textContent. No markup-string sinks are used anywhere.
//   - The only attribute taken from model text is a link href, and only after
//     safeHref() accepts it as an absolute http(s) URL. Everything else
//     (javascript:, data:, vbscript:, relative paths, protocol-relative
//     "//host") renders as plain text.
//   - Link clicks are handed to the host (ui.openExternal) by the caller's
//     onLink hook; the anchor never navigates the webview itself.
//
// STREAMING: the parser tolerates unterminated constructs (an open ``` fence
// renders as a code block with `closed: false`), so partial text renders
// sensibly on every chunk. The renderer keys each top-level block by its raw
// source and reuses the DOM node when that source is unchanged, so only the
// block still being written is rebuilt - no flicker, and code-block toolbars
// above the stream stay put.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { type: "heading"; level: number; inlines: Inline[]; raw: string }
  | { type: "paragraph"; inlines: Inline[]; raw: string }
  | { type: "code"; lang: string; text: string; closed: boolean; raw: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][]; raw: string }
  | { type: "quote"; blocks: Block[]; raw: string }
  | { type: "table"; head: Inline[][]; rows: Inline[][][]; align: Array<"left" | "center" | "right" | null>; raw: string }
  | { type: "hr"; raw: string };

// --- links -------------------------------------------------------------------

/** Returns a normalised absolute http(s) URL, or null. The single gate for
 * every href this module emits. */
export function safeHref(raw: string): string | null {
  const candidate = raw.trim().replace(/^<|>$/g, "");
  // Reject anything with control chars or whitespace inside - browsers strip
  // some of them when parsing schemes ("java\tscript:").
  if (!candidate || /[\u0000-\u0020\u007f]/.test(candidate)) return null;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

// --- inline parsing ------------------------------------------------------------

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|~>".split(""));

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/** Bare URL at position i (autolink). Trailing punctuation is left out. */
function matchBareUrl(src: string, i: number): string | null {
  const m = /^https?:\/\/[^\s<>()\[\]"'`]+/i.exec(src.slice(i));
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, "");
}

function findClosing(src: string, from: number, marker: string): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      // Skip inline code spans - markers inside them don't count.
      let run = 0;
      while (src[i + run] === "`") run += 1;
      const close = src.indexOf("`".repeat(run), i + run);
      if (close === -1) {
        i += run;
        continue;
      }
      i = close + run;
      continue;
    }
    if (src.startsWith(marker, i)) return i;
    i += 1;
  }
  return -1;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  if (depth > 8) return [{ t: "text", v: src }];

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      // Hard break on "  \n" or "\\\n"; otherwise a soft break is a space.
      if (buf.endsWith("  ")) {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
      } else {
        buf += "\n";
      }
      i += 1;
      continue;
    }

    if (ch === "`") {
      let run = 0;
      while (src[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = src.indexOf(fence, i + run);
      if (close !== -1) {
        flush();
        let code = src.slice(i + run, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        out.push({ t: "code", v: code });
        i = close + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }

    if (ch === "[") {
      const closeText = findClosing(src, i + 1, "]");
      if (closeText !== -1 && src[closeText + 1] === "(") {
        const closeUrl = src.indexOf(")", closeText + 2);
        if (closeUrl !== -1) {
          const label = src.slice(i + 1, closeText);
          const target = src.slice(closeText + 2, closeUrl).trim().split(/\s+/)[0] ?? "";
          const href = safeHref(target);
          flush();
          if (href) {
            out.push({ t: "link", href, c: parseInline(label, depth + 1) });
          } else {
            // Unsafe or relative target: keep the label, drop the link.
            out.push(...parseInline(label, depth + 1));
          }
          i = closeUrl + 1;
          continue;
        }
      }
    }

    if (ch === "h" || ch === "H") {
      if (!isWordChar(src[i - 1])) {
        const url = matchBareUrl(src, i);
        if (url) {
          const href = safeHref(url);
          if (href) {
            flush();
            out.push({ t: "link", href, c: [{ t: "text", v: url }] });
            i += url.length;
            continue;
          }
        }
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const close = findClosing(src, i + 2, "~~");
      if (close > i + 2) {
        flush();
        out.push({ t: "del", c: parseInline(src.slice(i + 2, close), depth + 1) });
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const double = src[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const after = src[i + marker.length];
      // Intraword underscores (snake_case) are never emphasis.
      const intraword = ch === "_" && isWordChar(src[i - 1]);
      if (!intraword && after && after !== " " && after !== "\n") {
        let close = findClosing(src, i + marker.length, marker);
        // For single markers, skip a close that is actually the start of a double.
        while (!double && close !== -1 && src[close + 1] === ch) {
          close = findClosing(src, close + 2, marker);
        }
        const closeOk =
          close > i + marker.length &&
          src[close - 1] !== " " &&
          !(ch === "_" && isWordChar(src[close + marker.length]));
        if (closeOk) {
          flush();
          const inner = parseInline(src.slice(i + marker.length, close), depth + 1);
          out.push(double ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = close + marker.length;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// --- block parsing ---------------------------------------------------------------

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET_RE = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED_RE = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

export function parseMarkdown(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Fenced code.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      const lang = fence[3] ?? "";
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const l = lines[j];
        const trimmed = l.trim();
        if (trimmed.startsWith(marker[0].repeat(marker.length)) && /^([`~])\1*$/.test(trimmed) && trimmed.length >= marker.length) {
          closed = true;
          break;
        }
        body.push(l.startsWith(fence[1]) ? l.slice(fence[1].length) : l);
        j += 1;
      }
      const end = closed ? j + 1 : j;
      blocks.push({ type: "code", lang, text: body.join("\n"), closed, raw: lines.slice(i, end).join("\n") });
      i = end;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading && line.trimStart().startsWith("#")) {
      blocks.push({ type: "heading", level: heading[1].length, inlines: parseInline(heading[2] ?? ""), raw: line });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr", raw: line });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      let j = i;
      while (j < lines.length && !isBlank(lines[j])) {
        const q = QUOTE_RE.exec(lines[j]);
        if (q) inner.push(q[1]);
        else if (inner.length && !startsBlock(lines[j])) inner.push(lines[j]); // lazy continuation
        else break;
        j += 1;
      }
      blocks.push({
        type: "quote",
        blocks: depth > 6 ? [{ type: "paragraph", inlines: [{ t: "text", v: inner.join("\n") }], raw: "" }] : parseMarkdown(inner.join("\n"), depth + 1),
        raw: lines.slice(i, j).join("\n"),
      });
      i = j;
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const itemRe = isOrdered ? ORDERED_RE : BULLET_RE;
      const items: string[][] = [];
      let j = i;
      let current: string[] | null = null;
      let contentIndent = 2;
      let sawBlank = false;
      while (j < lines.length) {
        const l = lines[j];
        const m = itemRe.exec(l);
        if (m && m[1].length < contentIndent) {
          current = [m[3]];
          items.push(current);
          contentIndent = m[1].length + m[2].length + 1;
          sawBlank = false;
          j += 1;
          continue;
        }
        if (isBlank(l)) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[j + 1];
          if (next !== undefined && (itemRe.test(next) || /^\s{2,}\S/.test(next))) {
            current?.push("");
            sawBlank = true;
            j += 1;
            continue;
          }
          break;
        }
        const indent = /^\s*/.exec(l)?.[0].length ?? 0;
        if (current && indent >= 2) {
          current.push(l.slice(Math.min(indent, contentIndent)));
          j += 1;
          continue;
        }
        if (current && !sawBlank && !startsBlock(l)) {
          current.push(l); // lazy paragraph continuation
          j += 1;
          continue;
        }
        break;
      }
      const start = isOrdered ? Number.parseInt((ordered as RegExpExecArray)[2], 10) : 1;
      blocks.push({
        type: "list",
        ordered: isOrdered,
        start: Number.isFinite(start) ? start : 1,
        items: items.map((item) =>
          depth > 6 ? [{ type: "paragraph", inlines: parseInline(item.join("\n")), raw: "" }] : parseMarkdown(item.join("\n"), depth + 1)
        ),
        raw: lines.slice(i, j).join("\n"),
      });
      i = j;
      continue;
    }

    // GFM table: header row, separator row, then rows.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const headCells = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].includes("|")) {
        rows.push(splitRow(lines[j]).map((c) => parseInline(c)));
        j += 1;
      }
      blocks.push({
        type: "table",
        head: headCells.map((c) => parseInline(c)),
        rows,
        align,
        raw: lines.slice(i, j).join("\n"),
      });
      i = j;
      continue;
    }

    // Paragraph: until a blank line or another block start.
    const para: string[] = [line];
    let j = i + 1;
    while (j < lines.length && !isBlank(lines[j]) && !startsBlock(lines[j])) {
      if (lines[j].includes("|") && j + 1 < lines.length && TABLE_SEP_RE.test(lines[j + 1])) break;
      para.push(lines[j]);
      j += 1;
    }
    const text = para.map((l) => l.replace(/^ {0,3}/, "")).join("\n");
    blocks.push({ type: "paragraph", inlines: parseInline(text), raw: para.join("\n") });
    i = j;
  }
  return blocks;
}

// --- DOM rendering -----------------------------------------------------------------

/** The DOM surface the renderer is allowed to touch - deliberately tiny, so
 * the whole rendering path is auditable (and testable without a browser). */
export interface MdDocument {
  createElement(tag: string): MdElement;
  createTextNode(text: string): unknown;
}

export interface MdElement {
  className: string;
  textContent: string | null;
  append(...nodes: Array<MdElement | unknown>): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
}

export interface MdHooks {
  /** A safe (already validated http/https) link was activated. */
  onLink(href: string): void;
  /** Toolbar controls for a fenced code block. Called on every (re)render of
   * the block; `closed` is false while the fence is still streaming. */
  codeActions?(code: string, lang: string, closed: boolean): MdElement[];
}

const ALLOWED_TAGS = new Set([
  "div", "p", "span", "strong", "em", "del", "code", "pre", "a", "br", "hr",
  "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
]);

function make(doc: MdDocument, tag: string, className?: string): MdElement {
  // Defence in depth: the renderer only ever creates tags from this list.
  if (!ALLOWED_TAGS.has(tag)) throw new Error(`markdown renderer: tag <${tag}> not allowed`);
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function renderInlines(doc: MdDocument, parent: MdElement, inlines: Inline[], hooks: MdHooks): void {
  for (const node of inlines) {
    switch (node.t) {
      case "text":
        parent.append(doc.createTextNode(node.v));
        break;
      case "code": {
        const c = make(doc, "code", "md-code-inline");
        c.textContent = node.v;
        parent.append(c);
        break;
      }
      case "strong":
      case "em":
      case "del": {
        const wrap = make(doc, node.t);
        renderInlines(doc, wrap, node.c, hooks);
        parent.append(wrap);
        break;
      }
      case "link": {
        const href = safeHref(node.href);
        if (!href) {
          renderInlines(doc, parent, node.c, hooks);
          break;
        }
        const a = make(doc, "a", "md-link");
        a.setAttribute("href", href);
        a.setAttribute("title", href);
        a.setAttribute("rel", "noopener noreferrer");
        a.addEventListener("click", (event) => {
          event.preventDefault();
          hooks.onLink(href);
        });
        renderInlines(doc, a, node.c, hooks);
        parent.append(a);
        break;
      }
      case "br":
        parent.append(make(doc, "br"));
        break;
    }
  }
}

export function renderBlock(doc: MdDocument, block: Block, hooks: MdHooks): MdElement {
  switch (block.type) {
    case "heading": {
      const h = make(doc, `h${Math.min(6, Math.max(1, block.level))}`, "md-heading");
      renderInlines(doc, h, block.inlines, hooks);
      return h;
    }
    case "paragraph": {
      const p = make(doc, "p", "md-p");
      renderInlines(doc, p, block.inlines, hooks);
      return p;
    }
    case "hr":
      return make(doc, "hr", "md-hr");
    case "quote": {
      const q = make(doc, "blockquote", "md-quote");
      for (const b of block.blocks) q.append(renderBlock(doc, b, hooks));
      return q;
    }
    case "list": {
      const list = make(doc, block.ordered ? "ol" : "ul", "md-list");
      if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
      for (const item of block.items) {
        const li = make(doc, "li");
        for (const b of item) li.append(renderBlock(doc, b, hooks));
        list.append(li);
      }
      return list;
    }
    case "table": {
      const wrap = make(doc, "div", "md-table-wrap");
      const table = make(doc, "table", "md-table");
      const thead = make(doc, "thead");
      const headRow = make(doc, "tr");
      block.head.forEach((cell, idx) => {
        const th = make(doc, "th");
        const a = block.align[idx];
        if (a) th.className = `md-align-${a}`;
        renderInlines(doc, th, cell, hooks);
        headRow.append(th);
      });
      thead.append(headRow);
      const tbody = make(doc, "tbody");
      for (const row of block.rows) {
        const tr = make(doc, "tr");
        row.forEach((cell, idx) => {
          const td = make(doc, "td");
          const a = block.align[idx];
          if (a) td.className = `md-align-${a}`;
          renderInlines(doc, td, cell, hooks);
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }
    case "code": {
      const wrap = make(doc, "div", `md-codeblock${block.closed ? "" : " md-codeblock-open"}`);
      const bar = make(doc, "div", "md-codebar");
      const label = make(doc, "span", "md-codelang");
      label.textContent = block.lang || "text";
      bar.append(label);
      const actions = make(doc, "div", "md-codeactions");
      for (const action of hooks.codeActions?.(block.text, block.lang, block.closed) ?? []) actions.append(action);
      bar.append(actions);
      const pre = make(doc, "pre", "md-pre");
      const code = make(doc, "code", "md-code");
      code.textContent = block.text;
      pre.append(code);
      wrap.append(bar, pre);
      return wrap;
    }
  }
}

/** Stateful renderer for one message body: call update() with the full text
 * so far on every chunk. Unchanged leading blocks keep their DOM nodes. */
export interface MarkdownView {
  update(text: string): MdElement[];
}

export function createMarkdownView(doc: MdDocument, hooks: MdHooks): MarkdownView {
  let previous: Array<{ raw: string; type: string; node: MdElement }> = [];
  return {
    update(text: string): MdElement[] {
      const blocks = parseMarkdown(text);
      const next = blocks.map((block, idx) => {
        const old = previous[idx];
        // Reuse only when both the source and the block type are unchanged -
        // the last block (still streaming) is always rebuilt.
        if (old && old.raw === block.raw && old.type === block.type && idx < blocks.length - 1) return old;
        return { raw: block.raw, type: block.type, node: renderBlock(doc, block, hooks) };
      });
      previous = next;
      return next.map((entry) => entry.node);
    },
  };
}

/** First fenced code block's content, or null. Used for "Use as commit
 * message" (a model usually fences the message) and "Run". */
export function firstCodeBlock(text: string): { code: string; lang: string } | null {
  for (const block of parseMarkdown(text)) {
    if (block.type === "code") return { code: block.text, lang: block.lang };
  }
  return null;
}
