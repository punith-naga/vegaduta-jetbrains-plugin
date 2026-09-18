import mainSrc from "../src/webview/chat/main.ts?raw";
import markdownSrc from "../src/webview/chat/markdown.ts?raw";
import commandsSrc from "../src/webview/chat/commands.ts?raw";
import historySrc from "../src/webview/chat/history.ts?raw";
import { describe, expect, it } from "vitest";
import {
  createMarkdownView,
  firstCodeBlock,
  parseInline,
  parseMarkdown,
  renderBlock,
  safeHref,
  type MdDocument,
  type MdElement,
} from "../src/webview/chat/markdown";

// A tiny fake DOM that records exactly what the renderer builds. There is no
// markup parser in it at all, so anything that ends up as an element or an
// attribute here was created deliberately by the renderer.

class FakeText {
  constructor(public data: string) {}
}

class FakeEl implements MdElement {
  className = "";
  attrs = new Map<string, string>();
  children: Array<FakeEl | FakeText> = [];
  listeners = new Map<string, (e: { preventDefault(): void }) => void>();
  private ownText: string | null = null;
  constructor(public tag: string) {}
  get textContent(): string {
    if (this.ownText !== null) return this.ownText;
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join("");
  }
  set textContent(v: string | null) {
    this.children = [];
    this.ownText = v ?? "";
  }
  append(...nodes: unknown[]): void {
    for (const n of nodes) {
      if (!(n instanceof FakeEl) && !(n instanceof FakeText)) throw new Error("foreign node appended");
      if (this.ownText !== null) {
        this.children.push(new FakeText(this.ownText));
        this.ownText = null;
      }
      this.children.push(n);
    }
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  addEventListener(type: string, listener: (e: { preventDefault(): void }) => void): void {
    this.listeners.set(type, listener);
  }
}

const fakeDoc: MdDocument = {
  createElement: (tag) => new FakeEl(tag),
  createTextNode: (text) => new FakeText(text),
};

function walk(node: FakeEl, visit: (el: FakeEl) => void): void {
  visit(node);
  for (const c of node.children) if (c instanceof FakeEl) walk(c, visit);
}

function render(md: string, hooks: Partial<Parameters<typeof renderBlock>[2]> = {}): FakeEl {
  const root = new FakeEl("div");
  const h = { onLink: () => {}, ...hooks };
  for (const block of parseMarkdown(md)) root.append(renderBlock(fakeDoc, block, h) as FakeEl);
  return root;
}

function allTags(root: FakeEl): string[] {
  const tags: string[] = [];
  walk(root, (el) => tags.push(el.tag));
  return tags;
}

describe("markdown: security", () => {
  it("renders <script> as literal text, never as an element", () => {
    const root = render('Hello <script>alert("x")</script> world\n\n<script src="https://evil.example/x.js"></script>');
    expect(allTags(root)).not.toContain("script");
    expect(root.textContent).toContain('<script>alert("x")</script>');
  });

  it("keeps onerror= / event-handler attributes inert (text only, no attributes)", () => {
    const root = render('<img src=x onerror="alert(1)"> and <a href="#" onclick="steal()">x</a>');
    expect(allTags(root)).not.toContain("img");
    walk(root, (el) => {
      for (const name of el.attrs.keys()) expect(name.toLowerCase().startsWith("on")).toBe(false);
    });
    expect(root.textContent).toContain('onerror="alert(1)"');
  });

  it("never emits javascript:, data: or vbscript: links", () => {
    const hostile = [
      "[click](javascript:alert(1))",
      "[click](JaVaScRiPt:alert(1))",
      "[click](  javascript:alert(1))",
      "[click](java\tscript:alert(1))",
      "[click](data:text/html;base64,PHNjcmlwdD4=)",
      "[click](vbscript:msgbox(1))",
      "[click](//evil.example/path)",
      "[click](/relative/path)",
      "javascript:alert(1)",
    ];
    for (const md of hostile) {
      const root = render(md);
      const anchors: FakeEl[] = [];
      walk(root, (el) => {
        if (el.tag === "a") anchors.push(el);
      });
      expect(anchors, md).toHaveLength(0);
      if (md.startsWith("[click]")) expect(root.textContent).toContain("click");
    }
  });

  it("only creates elements from the renderer's allow-list", () => {
    const root = render(
      "# h\n\n**b** _i_ ~~d~~ `c`\n\n- a\n- b\n\n1. x\n\n> q\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```\n<iframe src=x></iframe><object></object><style>*{}</style>"
    );
    const allowed = new Set([
      "div", "p", "span", "strong", "em", "del", "code", "pre", "a", "br", "hr",
      "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
      "table", "thead", "tbody", "tr", "th", "td",
    ]);
    for (const tag of allTags(root)) expect(allowed.has(tag), tag).toBe(true);
  });

  it("link clicks go to the host hook and never navigate the webview", () => {
    const opened: string[] = [];
    const root = render("See [docs](https://vegaduta.ai/docs) now", { onLink: (h: string) => opened.push(h) });
    let anchor: FakeEl | null = null;
    walk(root, (el) => {
      if (el.tag === "a") anchor = el;
    });
    expect(anchor).not.toBeNull();
    const a = anchor as unknown as FakeEl;
    expect(a.attrs.get("href")).toBe("https://vegaduta.ai/docs");
    expect(a.attrs.get("rel")).toBe("noopener noreferrer");
    let prevented = false;
    a.listeners.get("click")?.({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(opened).toEqual(["https://vegaduta.ai/docs"]);
  });

  it("safeHref accepts only absolute http(s)", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://")).toBeNull();
    expect(safeHref("ftp://example.com")).toBeNull();
    expect(safeHref("https://exa mple.com")).toBeNull();
  });

  it("the chat sources never use HTML-string DOM sinks", () => {
    const sources: Record<string, string> = { mainSrc, markdownSrc, commandsSrc, historySrc };
    for (const [file, src] of Object.entries(sources)) {
      expect(src.length, file).toBeGreaterThan(500);
      expect(src, file).not.toMatch(/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write\(|DOMParser|createContextualFragment/);
    }
  });
});

describe("markdown: structure", () => {
  it("parses headings, paragraphs and emphasis", () => {
    const blocks = parseMarkdown("## Title\n\nSome **bold** and *it* and `code`.");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(blocks[1].type).toBe("paragraph");
    const inl = (blocks[1] as { inlines: unknown[] }).inlines;
    expect(inl).toContainEqual({ t: "strong", c: [{ t: "text", v: "bold" }] });
    expect(inl).toContainEqual({ t: "em", c: [{ t: "text", v: "it" }] });
    expect(inl).toContainEqual({ t: "code", v: "code" });
  });

  it("does not treat snake_case as emphasis", () => {
    expect(parseInline("call my_func_name now")).toEqual([{ t: "text", v: "call my_func_name now" }]);
  });

  it("parses ordered and unordered lists, including nesting", () => {
    const blocks = parseMarkdown("- one\n- two\n  - nested\n\n3. c\n4. d");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    const items = (blocks[0] as { items: unknown[][] }).items;
    expect(items).toHaveLength(2);
    expect(items[1].some((b) => (b as { type: string }).type === "list")).toBe(true);
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("parses blockquotes and tables", () => {
    const blocks = parseMarkdown("> quoted\n> more\n\n| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(blocks[0].type).toBe("quote");
    expect(blocks[1]).toMatchObject({ type: "table", align: ["left", "right"] });
  });

  it("parses fenced code with language and keeps the body verbatim", () => {
    const blocks = parseMarkdown("```python\nprint('<b>hi</b>')\n```\nafter");
    expect(blocks[0]).toMatchObject({ type: "code", lang: "python", text: "print('<b>hi</b>')", closed: true });
    expect(blocks[1].type).toBe("paragraph");
  });

  it("renders an unterminated fence while streaming", () => {
    const blocks = parseMarkdown("Here:\n```ts\nconst a = 1;");
    expect(blocks[1]).toMatchObject({ type: "code", lang: "ts", text: "const a = 1;", closed: false });
  });

  it("offers code actions only once a fence is closed, with the block's code", () => {
    const seen: Array<[string, string, boolean]> = [];
    render("```js\nlet x = 1;\n```", {
      codeActions: (code: string, lang: string, closed: boolean) => {
        seen.push([code, lang, closed]);
        return [];
      },
    });
    expect(seen).toEqual([["let x = 1;", "js", true]]);
  });

  it("firstCodeBlock finds the first fence", () => {
    expect(firstCodeBlock("x\n```\nfeat: add\n```\n```js\n1\n```")).toEqual({ code: "feat: add", lang: "" });
    expect(firstCodeBlock("no code")).toBeNull();
  });
});

describe("markdown: streaming view", () => {
  it("reuses DOM nodes of unchanged leading blocks", () => {
    const view = createMarkdownView(fakeDoc, { onLink: () => {} });
    const first = view.update("# Title\n\nPara one\n\nPara t");
    const second = view.update("# Title\n\nPara one\n\nPara two is longer");
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect((second[2] as unknown as FakeEl).textContent).toBe("Para two is longer");
  });

  it("produces the same content incrementally as in one shot", () => {
    const text = "Intro **bold**\n\n```py\nprint(1)\n```\n\n- a\n- b [l](https://x.dev)";
    const view = createMarkdownView(fakeDoc, { onLink: () => {} });
    let nodes: MdElement[] = [];
    for (let i = 1; i <= text.length; i += 7) nodes = view.update(text.slice(0, i));
    nodes = view.update(text);
    const incremental = nodes.map((n) => (n as unknown as FakeEl).textContent).join("|");
    const oneShot = createMarkdownView(fakeDoc, { onLink: () => {} })
      .update(text)
      .map((n) => (n as unknown as FakeEl).textContent)
      .join("|");
    expect(incremental).toBe(oneShot);
  });
});
