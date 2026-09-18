// The single host<->webview message contract shared by all three plugin
// hosts (VS Code WebviewView, Chrome side panel, JetBrains JBCef). The chat
// UI (webview/chat/) speaks ONLY this protocol; each host implements the
// host side over its native transport (postMessage / in-page loopback /
// cefQuery). Request/response pairs are correlated by `reqId`.
//
// Token rule: on VS Code and JetBrains the access token NEVER enters the
// webview - SSE runs host-side and arrives as chat.chunk messages. Chrome's
// side panel is itself a trusted extension page, so there the "host" half
// lives in the same page (loopback transport) and fetches directly.

import type { AgentSummary, WorkflowRun, WorkflowSummary } from "../api/types";

/** Which host this is. "eclipse" added 2026-09-18 - the Eclipse host had been
 * reporting "jetbrains", the nearest member, because the union lacked it. */
export type EnginePlatform = "vscode" | "chrome" | "jetbrains" | "eclipse";

export type EngineState = "unavailable" | "idle" | "loading" | "ready";

export interface EngineStatus {
  state: EngineState;
  /** 0..1 while state === "loading". */
  progress?: number;
  modelId?: string | null;
  /** Human-readable reason when unavailable (e.g. "No WebGPU in this host"). */
  detail?: string;
  /** Which LocalEngine backend produced this status (webllm | ollama | ...). */
  backend?: string;
}

export interface AuthState {
  signedIn: boolean;
  username?: string | null;
  /** "jwt" (interactive) or "apiKey" (pasted vmcp_ key, reduced features). */
  mode?: "jwt" | "apiKey" | null;
}

export type LocalTaskKind = "completion" | "explain" | "fix" | "refactor" | "chat";

// --- context attachments (2026-09-18) ---------------------------------------
//
// The chat app can ask its host for context to attach to a prompt: the file
// in the active editor, the current selection, the working-tree diff, the
// active file's problems, or (Chrome) the current page. Each host supplies the
// kinds it can and declares them in init.capabilities, so the UI never offers
// something the host cannot deliver. Hosts TRUNCATE before sending - the
// webview never receives an unbounded file - and say so via `truncated`.

export type ContextKind =
  | "file"
  | "selection"
  | "diff"
  | "diagnostics"
  | "page"
  // --- wave 2 (2026-09-18) ---
  /** Recent commit subjects + bodies (git log -n 30), for commit messages in
   * the team's own style, release notes and standups. IDE hosts. */
  | "gitlog"
  /** The IDE terminal's current selection (e.g. a failing test's output).
   * Hosts that can read it; VS Code exposes terminal.selection. */
  | "terminal"
  /** Chrome: the page's interactive elements (role, accessible name, a stable
   * selector hint) - what a Playwright test needs, which page text alone is
   * not. Read through the existing activeTab grant. */
  | "pageElements";

/** Per-item ceiling hosts truncate to. One constant so four hosts agree. */
export const CONTEXT_ITEM_MAX_CHARS = 24_000;

export interface ContextItem {
  kind: ContextKind;
  /** Short, human label for the chip: "src/App.tsx", "Selection (12 lines)",
   * "Working tree diff (3 files)", "2 problems", "Page: <title>". */
  label: string;
  /** The content, already truncated to CONTEXT_ITEM_MAX_CHARS by the host. */
  text: string;
  languageId?: string;
  truncated?: boolean;
}

/** What this host can actually do. Optional on init so an older host keeps
 * working; the webview treats an absent field as the conservative answer. */
export interface HostCapabilities {
  /** Context kinds the host can supply via context.request. */
  context: ContextKind[];
  /** ui.insert writes into a real editor (false = the host copies instead). */
  insert: boolean;
  /** ui.newFile opens an editor tab (false = the host copies instead). */
  newFile: boolean;
  /** sdlc.run is serviced. */
  runCode: boolean;
  /** ui.setCommitMessage writes into the host's commit-message box. */
  commitMessage: boolean;
  // --- wave 2 (2026-09-18) - OPTIONAL so every host built before them still
  // compiles; the webview reads an absent field as false.
  /** ui.reveal opens a file and selects a line range (Code Tour). */
  reveal?: boolean;
  /** knowledge.search is serviced (needs a signed-in JWT; the vmcp_ API-key
   * surface has no knowledge endpoints). */
  knowledge?: boolean;
  /** The host ENFORCES Private Mode on its own network paths (hosted
   * completions, hosted commands) when privacy.mode says so. A host without
   * this still gets the webview-side guarantee, and the UI says which. */
  privateMode?: boolean;
  /** ui.popOut moves the chat into its own window (JetBrains: a windowed
   * tool window). Absent = the panel only explains how to make room. */
  popOut?: boolean;
}

/** One knowledge-base hit, as POST /api/knowledge/search returns it. */
export interface KnowledgeHit {
  id: string;
  source: string | null;
  content: string;
  collectionId: string | null;
  documentId: string | null;
  /** Vector distance - smaller is closer. */
  distance: number | null;
}

export const DEFAULT_HOST_CAPABILITIES: HostCapabilities = {
  context: [],
  insert: false,
  newFile: false,
  runCode: false,
  commitMessage: false,
};

/** POST /api/sdlc/sandbox/run-code's three supported runtimes. */
export type SandboxLanguage = "python" | "node" | "bash";

export interface ValidationOutcome {
  valid: boolean;
  errors?: Array<{ line?: number; message: string }>;
}

// --- host -> webview -------------------------------------------------------

export type HostToWebview =
  | {
      type: "init";
      platform: EnginePlatform;
      apiBase: string;
      auth: AuthState;
      agents: AgentSummary[];
      workflows: WorkflowSummary[];
      /** True when this host wants the webview to run the WebLLM engine. */
      hostLocalEngine: boolean;
      /** Optional edge.* kv values the host wants applied to the webview's
       * engine kv BEFORE the engine host starts (edge.apiBase,
       * edge.ollamaBaseUrl, edge.backend, ...). A null value removes the key.
       * Lets VS Code plumb its settings the way JetBrains' seed script and
       * Chrome's storage mirror already do, without an inline script. */
      edgeSettings?: Record<string, string | null>;
      /** What the host supports. Absent = DEFAULT_HOST_CAPABILITIES. */
      capabilities?: HostCapabilities;
      /** The IDE's own light/dark theme, for hosts whose embedded browser
       * only knows the OS preference (JCEF, SWT). VS Code needs none - its
       * body class already says. Absent = follow the OS. */
      theme?: "dark" | "light";
    }
  | { type: "auth.changed"; auth: AuthState }
  | {
      /** Host asks the chat app to open its on-device model panel (e.g. a
       * "Download an On-Device Model" command). Optional for hosts. */
      type: "ui.showModels";
    }
  | {
      /** Answer to context.request. Kinds the host could not supply appear in
       * `missing` with a reason ("no active editor", "not a git repo"), never
       * as a silently empty item. */
      type: "context.result";
      reqId: string;
      items: ContextItem[];
      missing?: Array<{ kind: ContextKind; reason: string }>;
    }
  | {
      /** A host command (e.g. "Review Changes") stages a prompt: the text goes
       * into the composer, the listed context kinds are requested and
       * attached, and `send: true` submits it once they arrive. */
      type: "ui.prefill";
      text: string;
      context?: ContextKind[];
      send?: boolean;
    }
  | {
      /** Answer to knowledge.search. `reason` on !ok: "signed-out",
       * "forbidden", "unavailable", or a short message. */
      type: "knowledge.result";
      reqId: string;
      ok: boolean;
      hits?: KnowledgeHit[];
      reason?: string;
    }
  | {
      /** The host's view of Private Mode after a privacy.mode request:
       * `enforced` is true only when the host itself now blocks its own
       * network paths (capabilities.privateMode). */
      type: "privacy.state";
      private: boolean;
      enforced: boolean;
    }
  | { type: "agents.changed"; agents: AgentSummary[]; workflows: WorkflowSummary[] }
  | { type: "chat.chunk"; reqId: string; delta: string }
  | { type: "chat.done"; reqId: string; sessionId: string | null }
  | { type: "chat.error"; reqId: string; message: string }
  | { type: "workflow.status"; reqId: string; run: WorkflowRun }
  | { type: "workflow.error"; reqId: string; message: string }
  | { type: "selection.context"; text: string; languageId?: string; fileName?: string }
  | {
      type: "engine.request";
      reqId: string;
      kind: LocalTaskKind;
      payload: {
        text: string;
        languageId?: string;
        /** completion only: text after the cursor. */
        suffix?: string;
        systemPrompt?: string;
      };
    }
  | { type: "engine.abort"; reqId: string }
  | {
      /** POST /api/sdlc/sandbox/run-code's result, gated server-side to
       * ROLE_tenant-admin/ROLE_agent-builder (SecurityConfig, "IDE/browser
       * plugin SDLC alignment 2026-08-09"). `reason` is set on !ok:
       * "forbidden" (role not granted - show the ask-your-admin message
       * verbatim from `detail`), "unavailable" (e.g. no E2B credential
       * configured on this tenant), or "unknown". */
      type: "sdlc.run.result";
      reqId: string;
      ok: boolean;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      timedOut?: boolean;
      reason?: string;
      detail?: string;
    };

// --- webview -> host -------------------------------------------------------

export type WebviewToHost =
  | { type: "ready" }
  | { type: "auth.signIn" }
  | { type: "auth.signOut" }
  | { type: "chat.send"; reqId: string; agentId: string; message: string; sessionId?: string | null }
  | { type: "chat.abort"; reqId: string }
  | { type: "workflow.run"; reqId: string; workflowId: string; input: string }
  | { type: "engine.status"; status: EngineStatus }
  | {
      type: "engine.result";
      reqId: string;
      ok: boolean;
      text?: string;
      /** Typed failure reason when !ok (codegen.ts convention - never throws). */
      reason?: string;
      /** Set only for fix/refactor (code-producing) kinds when the host was
       * able to reach POST /api/tools/code/validate - absent (not `false`)
       * when the caller lacks access or the language isn't validate-covered
       * (JAVA/PYTHON only), so the UI can tell "not validated" from "found
       * issues" apart. codegen.ts's rule: never trust local-model output as
       * correct without this check, but never block on it either. */
      validation?: ValidationOutcome;
    }
  | { type: "download.start"; modelId: string }
  | { type: "download.delete"; modelId: string }
  | { type: "ui.insert"; text: string }
  | { type: "ui.copy"; text: string }
  | { type: "ui.openExternal"; url: string }
  | {
      /** Ask the host for context to attach. Answered by context.result with
       * the same reqId. Only kinds in init.capabilities.context are sent. */
      type: "context.request";
      reqId: string;
      kinds: ContextKind[];
    }
  | {
      /** Open generated content in a new editor tab (capabilities.newFile);
       * a host without editors copies it instead and says so. */
      type: "ui.newFile";
      text: string;
      languageId?: string;
    }
  | {
      /** Write a generated commit message into the host's SCM commit box
       * (capabilities.commitMessage). Never commits - the person does. */
      type: "ui.setCommitMessage";
      text: string;
    }
  | {
      /** Move the chat into its own, resizable window. Only sent when
       * capabilities.popOut. */
      type: "ui.popOut";
    }
  | {
      /** Code Tour: open `path` (workspace-relative, as the host labelled it in
       * a ContextItem) and select lines startLine..endLine, 1-based inclusive.
       * No path = the active editor. Only sent when capabilities.reveal. */
      type: "ui.reveal";
      path?: string;
      startLine: number;
      endLine: number;
    }
  | {
      /** Search the tenant's knowledge base (POST /api/knowledge/search) with
       * the host's token - the webview never holds one. Answered by
       * knowledge.result. Only sent when capabilities.knowledge. */
      type: "knowledge.search";
      reqId: string;
      query: string;
      topK?: number;
      collectionIds?: string[];
    }
  | {
      /** Private Mode on/off. While on, the webview sends no hosted chat, no
       * knowledge search and no attachment anywhere but the local model, and a
       * host with capabilities.privateMode also blocks its own hosted paths.
       * Answered by privacy.state. */
      type: "privacy.mode";
      private: boolean;
    }
  | {
      /** Run `code` in a disposable sandbox. `code` is the RAW source - the
       * webview extracts it from a fenced block before sending, and every host
       * treats it as-is (an earlier comment here said "the first fenced block
       * in `code`", which no host ever did). `languageId` is the editor
       * languageId; the host maps it to E2B's python|node|bash and refuses
       * (typed "unavailable") anything else. */
      type: "sdlc.run";
      reqId: string;
      code: string;
      languageId?: string;
    };

/** Transport each host provides to the webview chat app. */
export interface WebviewTransport {
  post(message: WebviewToHost): void;
  onMessage(handler: (message: HostToWebview) => void): void;
}

/** Transport the host side implements. */
export interface HostTransport {
  post(message: HostToWebview): void;
  onMessage(handler: (message: WebviewToHost) => void): void;
}

let reqCounter = 0;

/** Monotonic per-page request id (no Date.now/random needed - collisions are
 * impossible within one page lifetime, which is the correlation scope). */
export function nextReqId(prefix: string): string {
  reqCounter += 1;
  return `${prefix}-${reqCounter}`;
}
