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

export type EnginePlatform = "vscode" | "chrome" | "jetbrains";

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
    }
  | { type: "auth.changed"; auth: AuthState }
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
      /** Run the FIRST fenced code block in `code` in a disposable sandbox.
       * `language` is the editor languageId the block came from (VS Code
       * commands and quick actions both tag it); the host maps it to E2B's
       * python|node|bash and refuses (typed "unavailable") anything else. */
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
