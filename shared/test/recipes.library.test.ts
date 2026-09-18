// Pins the house rules of the built-in SDLC recipe library
// (src/webview/chat/recipes/library.ts) against the fixed Recipe contract.

import { describe, expect, it } from "vitest";
import { BUILT_IN_RECIPES } from "../src/webview/chat/recipes/library";
import type { Role, SdlcPhase } from "../src/webview/chat/recipes/types";
import type { ContextKind } from "../src/webview/protocol";

// Record<Union, true> makes tsc fail if a member is added to or removed from
// the union without updating these lists - the runtime checks stay exhaustive.
const PHASES: Record<SdlcPhase, true> = {
  plan: true,
  design: true,
  build: true,
  test: true,
  review: true,
  release: true,
  operate: true,
  automate: true,
};
const ROLES: Record<Role, true> = {
  developer: true,
  tester: true,
  reviewer: true,
  architect: true,
  product: true,
  devops: true,
};
const CONTEXT_KINDS: Record<ContextKind, true> = {
  file: true,
  selection: true,
  diff: true,
  diagnostics: true,
  page: true,
  gitlog: true,
  terminal: true,
  pageElements: true,
};

/** The chat app's own slash commands - recipe aliases must never shadow them. */
const RESERVED_SLASH = [
  "explain", "fix", "tests", "docs", "review", "commit", "summarize",
  "translate", "new", "clear", "models", "help", "tour", "ask-team",
];

const MAX_PROMPT_WORDS = 170;
const MAX_PROMPT_CHARS = 1200;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("BUILT_IN_RECIPES", () => {
  it("ships between 24 and 30 built-in recipes", () => {
    expect(BUILT_IN_RECIPES.length).toBeGreaterThanOrEqual(24);
    expect(BUILT_IN_RECIPES.length).toBeLessThanOrEqual(30);
    for (const r of BUILT_IN_RECIPES) expect(r.builtIn, r.id).toBe(true);
  });

  it("has unique kebab-case ids and unique names", () => {
    const ids = BUILT_IN_RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const names = BUILT_IN_RECIPES.map((r) => r.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("has short, unique slash aliases that never collide with chat commands", () => {
    const aliases = BUILT_IN_RECIPES.map((r) => r.slash).filter((s): s is string => !!s);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const a of aliases) {
      expect(a, a).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(a.length, a).toBeLessThanOrEqual(12);
      expect(RESERVED_SLASH, a).not.toContain(a);
    }
  });

  it("gives every recipe a valid phase, at least one valid role, and a description", () => {
    for (const r of BUILT_IN_RECIPES) {
      expect(PHASES[r.phase], `${r.id} phase`).toBe(true);
      expect(r.roles.length, `${r.id} roles`).toBeGreaterThan(0);
      expect(new Set(r.roles).size, `${r.id} duplicate roles`).toBe(r.roles.length);
      for (const role of r.roles) expect(ROLES[role], `${r.id} role ${role}`).toBe(true);
      expect(r.name.trim().length, r.id).toBeGreaterThan(0);
      expect(r.description.trim().length, r.id).toBeGreaterThan(20);
      expect(typeof r.localFriendly, r.id).toBe("boolean");
    }
  });

  it("covers every SDLC phase and every role", () => {
    const phases = new Set(BUILT_IN_RECIPES.map((r) => r.phase));
    for (const p of Object.keys(PHASES)) expect(phases.has(p as SdlcPhase), p).toBe(true);
    const primary = new Set(BUILT_IN_RECIPES.map((r) => r.roles[0]));
    const any = new Set(BUILT_IN_RECIPES.flatMap((r) => r.roles));
    for (const role of Object.keys(ROLES)) {
      expect(any.has(role as Role), role).toBe(true);
      // each role is the primary (filed-under) role of at least one recipe
      expect(primary.has(role as Role), `primary ${role}`).toBe(true);
    }
  });

  it("uses only valid context kinds, and requiresContext recipes declare some", () => {
    for (const r of BUILT_IN_RECIPES) {
      expect(new Set(r.context).size, `${r.id} duplicate context`).toBe(r.context.length);
      for (const k of r.context) expect(CONTEXT_KINDS[k], `${r.id} context ${k}`).toBe(true);
      if (r.requiresContext) expect(r.context.length, r.id).toBeGreaterThan(0);
    }
  });

  it("keeps prompts non-empty, concise, and wired to {{input}}", () => {
    for (const r of BUILT_IN_RECIPES) {
      expect(r.prompt.trim().length, r.id).toBeGreaterThan(0);
      expect(wordCount(r.prompt), `${r.id} words`).toBeLessThanOrEqual(MAX_PROMPT_WORDS);
      expect(r.prompt.length, `${r.id} chars`).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
      expect(r.prompt.split("{{input}}").length - 1, `${r.id} {{input}} count`).toBe(1);
      // no other template placeholders the chat app would not substitute
      expect(r.prompt.replace("{{input}}", ""), r.id).not.toMatch(/\{\{/);
    }
  });

  it("tells the model to flag uncertainty instead of inventing", () => {
    for (const r of BUILT_IN_RECIPES) {
      expect(r.prompt, r.id).toMatch(/unsure|invent|guess/i);
    }
  });

  it("never refers to attachments by position", () => {
    const positional =
      /\b(first|second|third|last|above|below|following|next|previous)\s+(attachment|attached|file|context)\b|\battach(ed|ment)s?\s+(above|below)\b/i;
    for (const r of BUILT_IN_RECIPES) expect(r.prompt, r.id).not.toMatch(positional);
  });

  it("has coherent output hints", () => {
    for (const r of BUILT_IN_RECIPES) {
      const o = r.output;
      if (!o) continue;
      if (o.kind === "csv") expect(o.languageId, r.id).toBe("csv");
      if (o.kind === "json") expect(o.languageId, r.id).toBe("json");
      if (o.offerCommitMessage) expect(r.context, r.id).toContain("diff");
    }
  });

  it("includes the key SDLC recipes the product promises", () => {
    const byId = new Map(BUILT_IN_RECIPES.map((r) => [r.id, r]));
    const must = (id: string) => {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      return r!;
    };
    expect(must("requirements-to-test-cases-csv").output).toMatchObject({
      kind: "csv", languageId: "csv", offerNewFile: true,
    });
    expect(must("code-to-mermaid-diagram").output?.kind).toBe("mermaid");
    const pw = must("playwright-test-from-page");
    expect(pw.requiresContext).toBe(true);
    expect(pw.context).toEqual(expect.arrayContaining(["pageElements", "page"]));
    const sec = must("security-review-diff");
    expect(sec.requiresContext).toBe(true);
    expect(sec.context).toContain("diff");
    expect(sec.localFriendly).toBe(false);
    const commit = must("commit-message-repo-style");
    expect(commit.context).toEqual(expect.arrayContaining(["diff", "gitlog"]));
    expect(commit.output?.offerCommitMessage).toBe(true);
    expect(must("workflow-brief").output?.offerWorkflow).toBe(true);
    expect(must("release-notes-from-commits").context).toContain("gitlog");
    expect(must("standup-from-commits").context).toContain("gitlog");
    expect(must("scaffold-from-description").output).toMatchObject({ kind: "code", offerNewFile: true });
    for (const id of ["log-stacktrace-analyser", "explain-failing-test", "bug-report-writer"]) {
      expect(must(id).context, id).toContain("terminal");
    }
    for (const id of ["accessibility-review-page"]) {
      expect(must(id).context, id).toEqual(expect.arrayContaining(["page", "pageElements"]));
    }
  });

  it("contains no platform URLs (RULE 0) in prompts", () => {
    for (const r of BUILT_IN_RECIPES) {
      expect(r.prompt, r.id).not.toMatch(/https?:\/\//i);
      expect(r.prompt, r.id).not.toMatch(/localhost|127\.0\.0\.1/i);
    }
  });
});
