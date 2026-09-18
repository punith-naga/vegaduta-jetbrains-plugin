// Pure (DOM-free) logic behind the chat composer: slash commands, how
// attached context is folded into a prompt, and how that prompt is trimmed to
// fit a small on-device model. Kept separate from main.ts so it is unit-tested.

import type { ContextItem, ContextKind, HostCapabilities } from "../protocol";
import { DEFAULT_HOST_CAPABILITIES } from "../protocol";
import {
  computeLocalPromptBudget,
  estimateLocalTokens,
  WEBLLM_FALLBACK_CONTEXT_WINDOW,
} from "../../edge/webllmEngine";
import { parseMarkdown, type Block } from "./markdown";

/** Normalise an optional/partial capabilities object from init. Anything
 * missing or malformed falls back to the conservative default. */
export function normalizeCapabilities(raw: unknown): HostCapabilities {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_HOST_CAPABILITIES, context: [] };
  const r = raw as Partial<HostCapabilities>;
  const context = Array.isArray(r.context)
    ? ALL_CONTEXT_KINDS.filter((k) => (r.context as unknown[]).includes(k))
    : [];
  return {
    context,
    insert: r.insert === true,
    newFile: r.newFile === true,
    runCode: r.runCode === true,
    commitMessage: r.commitMessage === true,
    // Wave-2 flags stay ABSENT unless true - the protocol reads absent as false.
    ...(r.reveal === true ? { reveal: true } : {}),
    ...(r.knowledge === true ? { knowledge: true } : {}),
    ...(r.privateMode === true ? { privateMode: true } : {}),
    ...(r.popOut === true ? { popOut: true } : {}),
    ...(r.localRuntime === true ? { localRuntime: true } : {}),
  };
}

// --- context kinds ---------------------------------------------------------------

/** Every ContextKind the protocol defines, in menu order. */
export const ALL_CONTEXT_KINDS: ContextKind[] = [
  "file",
  "selection",
  "diff",
  "diagnostics",
  "page",
  "gitlog",
  "terminal",
  "pageElements",
];

export const CONTEXT_KIND_LABELS: Record<ContextKind, { label: string; hint: string }> = {
  file: { label: "Current file", hint: "The file open in the active editor" },
  selection: { label: "Selection", hint: "The text selected in the active editor" },
  diff: { label: "Uncommitted changes", hint: "Your working-tree diff" },
  diagnostics: { label: "Problems", hint: "Errors and warnings for the active file" },
  page: { label: "Current page", hint: "Readable text of the open tab" },
  gitlog: { label: "Recent commits", hint: "Your repository's latest commit messages" },
  terminal: { label: "Terminal selection", hint: "The text selected in the terminal" },
  pageElements: { label: "Page elements", hint: "Buttons, links and fields on the open tab" },
};

// --- slash commands -------------------------------------------------------------

export type SlashAction = "prompt" | "new" | "clear" | "models" | "help" | "toolkit" | "tour" | "askTeam";

export interface SlashCommand {
  name: string;
  /** One line for the popup. */
  description: string;
  action: SlashAction;
  /** Instruction sent to the model (action "prompt" only). */
  template?: string;
  /** Context kinds requested before sending (filtered to what the host
   * supports). */
  context?: ContextKind[];
  /** True = the command is meaningless without at least one of its context
   * kinds, so it is hidden on hosts that support none of them. */
  requiresContext?: boolean;
  /** Context kinds requested when the host has them, but which never satisfy
   * requiresContext on their own (e.g. /commit's recent-commit log). */
  optionalContext?: ContextKind[];
  /** The answer is a commit message (offers "Use as commit message"). */
  producesCommitMessage?: boolean;
  /** Set on commands generated from a recipe's slash alias: the recipe id. */
  recipeId?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "explain",
    description: "Explain the selected code (or what you paste after the command)",
    action: "prompt",
    template:
      "Explain what this code does, step by step. Call out anything surprising, risky or non-obvious. Keep it concise.",
    context: ["selection"],
  },
  {
    name: "fix",
    description: "Find and fix bugs in the selection, using current problems",
    action: "prompt",
    template:
      "Find the bugs in this code and fix them. Explain each problem in one line, then give the corrected code in a single fenced code block.",
    context: ["selection", "diagnostics"],
  },
  {
    name: "tests",
    description: "Write unit tests for the selected code",
    action: "prompt",
    template:
      "Write focused unit tests for this code using the testing framework its language and project most likely use. Cover edge cases. Return the tests in one fenced code block.",
    context: ["selection"],
  },
  {
    name: "docs",
    description: "Write documentation comments for the selected code",
    action: "prompt",
    template:
      "Write clear documentation comments for this code in the idiomatic style for its language. Return the documented code in one fenced code block.",
    context: ["selection"],
  },
  {
    name: "review",
    description: "Review your uncommitted changes",
    action: "prompt",
    template:
      "Review this diff like a careful senior engineer. List real problems first (bugs, security, missing error handling, missing tests), each with the file and a concrete fix. Then note smaller suggestions. Say so plainly if it looks good.",
    context: ["diff"],
    requiresContext: true,
  },
  {
    name: "commit",
    description: "Write a commit message for your uncommitted changes",
    action: "prompt",
    template:
      "Write a git commit message for this diff: a subject line under 72 characters in the imperative mood, a blank line, then a short body explaining what changed and why. Return ONLY the message inside one fenced code block.",
    context: ["diff"],
    optionalContext: ["gitlog"],
    requiresContext: true,
    producesCommitMessage: true,
  },
  {
    name: "summarize",
    description: "Summarize the current page or file",
    action: "prompt",
    template:
      "Summarize this in a few short bullet points, then one sentence on what matters most. Do not invent details that are not in the text.",
    context: ["page", "file"],
    requiresContext: true,
  },
  {
    name: "translate",
    description: "Translate the selection (name a language after the command)",
    action: "prompt",
    template:
      "Translate this text into the language named in my note (English if none is named). Keep formatting and any code unchanged.",
    context: ["selection", "page"],
  },
  {
    name: "tour",
    description: "Code Tour - a guided walk through the current file, stop by stop",
    action: "tour",
    context: ["file"],
    requiresContext: true,
  },
  {
    name: "ask-team",
    description: "Ask your team's knowledge base, with sources (type the question after it)",
    action: "askTeam",
  },
  { name: "toolkit", description: "Open the Toolkit - ready-made recipes for every SDLC phase", action: "toolkit" },
  { name: "new", description: "Start a new conversation", action: "new" },
  { name: "clear", description: "Delete this conversation and start fresh", action: "clear" },
  { name: "models", description: "Download or manage free on-device models", action: "models" },
  { name: "help", description: "Show what VegaDūta can do here", action: "help" },
];

export interface CommandAvailability {
  capabilities: HostCapabilities;
  /** The host runs the on-device engine (the model panel exists). */
  hostLocalEngine: boolean;
  /** Team knowledge search is usable right now (capabilities.knowledge,
   * signed in with a JWT, Private Mode off). Absent = no. */
  knowledge?: boolean;
}

/** Names of every built-in command - recipe aliases may not take them. */
export const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));

/** Context kinds of `cmd` this host can actually supply. */
export function supportedContext(cmd: SlashCommand, caps: HostCapabilities): ContextKind[] {
  return (cmd.context ?? []).filter((k) => caps.context.includes(k));
}

/** Context kinds to request for `cmd`: its own plus optional ones, filtered
 * to what the host can supply. */
export function requestableContext(cmd: SlashCommand, caps: HostCapabilities): ContextKind[] {
  return [...(cmd.context ?? []), ...(cmd.optionalContext ?? [])].filter((k) => caps.context.includes(k));
}

export function availableCommands(env: CommandAvailability): SlashCommand[] {
  return SLASH_COMMANDS.filter((cmd) => {
    if (cmd.action === "models") return env.hostLocalEngine;
    if (cmd.action === "askTeam") return env.knowledge === true;
    if (cmd.requiresContext && supportedContext(cmd, env.capabilities).length === 0) return false;
    return true;
  });
}

/** Commands whose name starts with what was typed after "/" (the popup). */
export function matchCommands(input: string, commands: SlashCommand[]): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(input.trimStart());
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}

/** "/review focus on auth" -> { command, arg: "focus on auth" }. Unknown or
 * unavailable commands return null (the text is then sent as typed). */
export function parseSlash(
  input: string,
  commands: SlashCommand[]
): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!m) return null;
  const command = commands.find((c) => c.name === m[1].toLowerCase());
  if (!command) return null;
  return { command, arg: (m[2] ?? "").trim() };
}

/** The instruction text for a prompt command plus the person's note. */
export function commandInstruction(command: SlashCommand, arg: string): string {
  const base = command.template ?? "";
  return arg ? `${base}\n\nMy note: ${arg}` : base;
}

/** Added to /commit's instruction when the host attached the recent commit
 * log: match the team's conventions, never copy the old messages. */
export const COMMIT_STYLE_INSTRUCTION =
  'The attached "Recent commits" show this repository\'s commit conventions. Match them: the same subject ' +
  "format (for example a type(scope): prefix if they use one), casing, tense, subject length and whether bodies " +
  "or trailers are used. Describe ONLY the attached diff - never reuse the content of those older messages.";

/** /commit's instruction, with the style rule when a gitlog is attached. */
export function commitInstruction(base: string, items: ContextItem[]): string {
  return items.some((i) => i.kind === "gitlog") ? `${base}\n\n${COMMIT_STYLE_INSTRUCTION}` : base;
}

// --- prompt assembly --------------------------------------------------------------

/** A fence longer than any backtick run inside `text`, so attached content
 * can never close the block it is wrapped in. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function contextHeading(item: ContextItem): string {
  const kind = CONTEXT_KIND_LABELS[item.kind]?.label ?? item.kind;
  const notes: string[] = [];
  if (item.languageId) notes.push(item.languageId);
  if (item.truncated) notes.push("truncated");
  return `${kind}: ${item.label}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** Folds attachments into the message in a clearly delimited form that both
 * hosted agents and small local models handle well. */
export function buildPrompt(message: string, items: ContextItem[]): string {
  if (items.length === 0) return message;
  const parts: string[] = [message.trim(), "", "--- Attached context ---"];
  for (const item of items) {
    const fence = fenceFor(item.text);
    const lang = item.kind === "diff" ? "diff" : item.languageId ?? "";
    parts.push("", `### ${contextHeading(item)}`, `${fence}${lang}`, item.text.replace(/\n+$/, ""), fence);
  }
  parts.push("", "--- End of attached context ---");
  return parts.join("\n");
}

export interface LocalFit {
  /** Items after trimming (same order; possibly shortened text). */
  items: ContextItem[];
  /** Human-readable notes about what was trimmed or dropped. */
  notes: string[];
  /** False = even with every attachment dropped the message itself is too
   * long for the model. The caller must not send it. */
  fits: boolean;
  budgetTokens: number;
}

const TRIM_MARKER = "\n[... trimmed to fit the on-device model ...]";
/** Headroom for headings, fences and the chat template around attachments. */
const ASSEMBLY_OVERHEAD_TOKENS = 64;

/** Trim attachments so system + message + attachments fit the on-device
 * model's window (4096 tokens unless the model says otherwise). Uses the same
 * estimator and budget as the engine, so a prompt that passes here is not
 * rejected there for its current turn. Earlier attachments keep priority. */
export function fitContextForLocal(
  message: string,
  items: ContextItem[],
  systemPrompt: string,
  contextWindow: number = WEBLLM_FALLBACK_CONTEXT_WINDOW
): LocalFit {
  const budgetTokens = computeLocalPromptBudget(contextWindow);
  const fixed =
    estimateLocalTokens(systemPrompt) + estimateLocalTokens(buildPrompt(message, [])) + ASSEMBLY_OVERHEAD_TOKENS;
  if (fixed > budgetTokens) {
    return { items: [], notes: [], fits: false, budgetTokens };
  }
  let remaining = budgetTokens - fixed;
  const out: ContextItem[] = [];
  const notes: string[] = [];
  for (const item of items) {
    const headingCost = estimateLocalTokens(contextHeading(item)) + 8;
    const cost = estimateLocalTokens(item.text) + headingCost;
    if (cost <= remaining) {
      out.push(item);
      remaining -= cost;
      continue;
    }
    const roomTokens = remaining - headingCost - estimateLocalTokens(TRIM_MARKER);
    // Anything under ~40 tokens of content is not worth sending.
    if (roomTokens < 40) {
      notes.push(`Left out "${item.label}" - no room in the on-device model's ${contextWindow}-token window.`);
      remaining = Math.max(0, remaining);
      continue;
    }
    const keepChars = Math.floor(roomTokens * 3.5) - 1;
    const text = item.text.slice(0, Math.max(0, keepChars)) + TRIM_MARKER;
    out.push({ ...item, text, truncated: true });
    notes.push(
      `Trimmed "${item.label}" to about ${Math.round((keepChars / Math.max(1, item.text.length)) * 100)}% to fit the on-device model's ${contextWindow}-token window.`
    );
    remaining = 0;
  }
  return { items: out, notes, fits: true, budgetTokens };
}

const COMMIT_FENCE_LANGS = new Set(["", "text", "txt", "plain", "plaintext", "git", "gitcommit", "commit", "markdown", "md"]);

/** Text to put in the host's commit box. /commit asks for the message in one
 * fenced block; prefer an untagged/text block (a model may also show code in
 * a tagged block), then a lone block of any kind, else the whole answer. */
export function extractCommitMessage(answer: string): string {
  const blocks = parseMarkdown(answer).filter((b): b is Extract<Block, { type: "code" }> => b.type === "code");
  const preferred = blocks.find((b) => COMMIT_FENCE_LANGS.has(b.lang.toLowerCase()));
  const chosen = preferred ?? (blocks.length === 1 ? blocks[0] : null);
  return (chosen ? chosen.text : answer).trim();
}

/** Webview-side mapping of common markdown fence labels onto editor
 * languageIds the hosts' sandbox mapping understands. */
export function fenceLangToLanguageId(lang: string): string | undefined {
  const l = lang.trim().toLowerCase();
  if (!l) return undefined;
  const map: Record<string, string> = {
    py: "python",
    python: "python",
    python3: "python",
    js: "javascript",
    javascript: "javascript",
    mjs: "javascript",
    node: "javascript",
    ts: "typescript",
    typescript: "typescript",
    jsx: "javascriptreact",
    tsx: "typescriptreact",
    sh: "bash",
    bash: "bash",
    shell: "bash",
    zsh: "bash",
    shellscript: "bash",
  };
  return map[l] ?? l;
}

/** Title for the history list: the first line of the first message. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
