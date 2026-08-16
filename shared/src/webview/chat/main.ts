// Framework-free chat webview shared byte-identical by all three hosts.
// Speaks only protocol.ts; transport injected by the host page (VS Code /
// JBCef auto-detected, Chrome passes its loopback half via bootChatApp).

import type {
  AgentSummary,
  WorkflowRun,
  WorkflowSummary,
} from "../../api/types";
import { TERMINAL_RUN_STATUSES } from "../../api/types";
import { detectTransport } from "../bridge";
import type {
  AuthState,
  EngineStatus,
  HostToWebview,
  WebviewTransport,
} from "../protocol";
import { nextReqId } from "../protocol";

interface ChatAppState {
  auth: AuthState;
  agents: AgentSummary[];
  workflows: WorkflowSummary[];
  selectedAgentId: string | null;
  sessionId: string | null;
  streamingReqId: string | null;
  engine: EngineStatus;
  hostLocalEngine: boolean;
}

const state: ChatAppState = {
  auth: { signedIn: false },
  agents: [],
  workflows: [],
  selectedAgentId: null,
  sessionId: null,
  streamingReqId: null,
  engine: { state: "unavailable" },
  hostLocalEngine: false,
};

let transport: WebviewTransport;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

// --- rendering -------------------------------------------------------------

function renderAuth(): void {
  const bar = $("auth-bar");
  bar.textContent = "";
  if (state.auth.signedIn) {
    bar.append(
      el("span", "auth-user", state.auth.username || "Signed in"),
      button("Sign out", "btn-ghost", () => transport.post({ type: "auth.signOut" }))
    );
  } else {
    const hint = el(
      "span",
      "auth-hint",
      "Sign in to chat with your agents and run workflows."
    );
    bar.append(hint, button("Sign in", "btn-primary", () => transport.post({ type: "auth.signIn" })));
  }
  ($("composer-input") as HTMLTextAreaElement).disabled = !state.auth.signedIn;
  ($("composer-send") as HTMLButtonElement).disabled = !state.auth.signedIn;
}

function renderAgents(): void {
  const select = $("agent-select") as HTMLSelectElement;
  select.textContent = "";
  for (const agent of state.agents) {
    const option = el("option");
    option.value = agent.id;
    option.textContent = agent.name;
    select.append(option);
  }
  if (state.agents.length === 0) {
    const option = el("option", undefined, state.auth.signedIn ? "No agents yet" : "Sign in first");
    option.value = "";
    select.append(option);
  }
  if (state.selectedAgentId && state.agents.some((a) => a.id === state.selectedAgentId)) {
    select.value = state.selectedAgentId;
  } else {
    state.selectedAgentId = state.agents[0]?.id ?? null;
  }

  const wfSelect = $("workflow-select") as HTMLSelectElement;
  wfSelect.textContent = "";
  const placeholder = el("option", undefined, "Run a workflow…");
  placeholder.value = "";
  wfSelect.append(placeholder);
  for (const wf of state.workflows) {
    const option = el("option");
    option.value = wf.id;
    option.textContent = wf.name;
    wfSelect.append(option);
  }
}

function renderEngine(): void {
  const chip = $("engine-chip");
  chip.className = `engine-chip engine-${state.engine.state}`;
  const label =
    state.engine.state === "ready"
      ? `On-device: ${state.engine.modelId ?? "ready"}${state.engine.backend ? ` (${state.engine.backend})` : ""}`
      : state.engine.state === "loading"
        ? `Loading model… ${Math.round((state.engine.progress ?? 0) * 100)}%`
        : state.engine.state === "idle"
          ? "On-device: available"
          : `On-device off${state.engine.detail ? `: ${state.engine.detail}` : ""}`;
  chip.textContent = label;
}

function appendMessage(role: "user" | "assistant" | "system", text: string): HTMLElement {
  const list = $("messages");
  const item = el("div", `msg msg-${role}`);
  const body = el("div", "msg-body", text);
  item.append(body);
  list.append(item);
  list.scrollTop = list.scrollHeight;
  return body;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.addEventListener("click", onClick);
  return b;
}

// --- run-in-sandbox flow ----------------------------------------------------

/** Finds the FIRST fenced code block in the composer text, e.g. from
 * ```python\n...\n``` - the same shape selection.context writes there. */
function extractFirstFence(text: string): { code: string; languageId?: string } | null {
  const match = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/.exec(text);
  if (!match) return null;
  return { languageId: match[1] || undefined, code: match[2] };
}

const runResults = new Map<string, HTMLElement>();

function runInSandbox(): void {
  const input = $("composer-input") as HTMLTextAreaElement;
  const fence = extractFirstFence(input.value);
  if (!fence) {
    appendMessage("system", "Select or paste a fenced code block (```) to run it in a sandbox.");
    return;
  }
  const reqId = nextReqId("run");
  runResults.set(reqId, appendMessage("system", "Running in sandbox…"));
  transport.post({ type: "sdlc.run", reqId, code: fence.code, languageId: fence.languageId });
}

function renderRunResult(message: Extract<HostToWebview, { type: "sdlc.run.result" }>): void {
  const card = runResults.get(message.reqId);
  runResults.delete(message.reqId);
  if (!card) return;
  if (!message.ok) {
    card.textContent = `⚠ Run failed: ${message.detail ?? message.reason ?? "unknown error"}`;
    return;
  }
  const parts: string[] = [];
  if (message.stdout) parts.push(message.stdout.replace(/\n$/, ""));
  if (message.stderr) parts.push(`stderr:\n${message.stderr.replace(/\n$/, "")}`);
  if (message.timedOut) parts.push("(timed out)");
  parts.push(`exit code ${message.exitCode ?? "?"}`);
  card.textContent = parts.join("\n\n") || "(no output)";
}

// --- chat flow -------------------------------------------------------------

const liveStreams = new Map<string, HTMLElement>();

function sendChat(): void {
  const input = $("composer-input") as HTMLTextAreaElement;
  const message = input.value.trim();
  if (!message || !state.selectedAgentId || state.streamingReqId) return;
  input.value = "";
  appendMessage("user", message);
  const reqId = nextReqId("chat");
  state.streamingReqId = reqId;
  liveStreams.set(reqId, appendMessage("assistant", ""));
  transport.post({
    type: "chat.send",
    reqId,
    agentId: state.selectedAgentId,
    message,
    sessionId: state.sessionId,
  });
  ($("composer-send") as HTMLButtonElement).textContent = "Stop";
}

function finishStream(reqId: string): void {
  liveStreams.delete(reqId);
  if (state.streamingReqId === reqId) {
    state.streamingReqId = null;
    ($("composer-send") as HTMLButtonElement).textContent = "Send";
  }
}

// --- workflow flow ---------------------------------------------------------

const workflowCards = new Map<string, HTMLElement>();

function runWorkflow(workflowId: string): void {
  const wf = state.workflows.find((w) => w.id === workflowId);
  if (!wf) return;
  const reqId = nextReqId("wf");
  const card = appendMessage("system", `Running workflow "${wf.name}"…`);
  workflowCards.set(reqId, card);
  transport.post({ type: "workflow.run", reqId, workflowId, input: "" });
}

function renderWorkflowStatus(reqId: string, run: WorkflowRun): void {
  const card = workflowCards.get(reqId);
  if (!card) return;
  const terminal = TERMINAL_RUN_STATUSES.has(run.status);
  card.textContent = `Workflow "${run.workflowName ?? run.workflowId}": ${run.status}${
    run.errorMessage ? ` — ${run.errorMessage}` : ""
  }`;
  if (terminal) workflowCards.delete(reqId);
}

// --- host messages ---------------------------------------------------------

function onHostMessage(message: HostToWebview): void {
  switch (message.type) {
    case "init":
      state.auth = message.auth;
      state.agents = message.agents;
      state.workflows = message.workflows;
      state.hostLocalEngine = message.hostLocalEngine;
      renderAuth();
      renderAgents();
      renderEngine();
      if (message.hostLocalEngine) {
        void startEngineHost();
      }
      break;
    case "auth.changed":
      state.auth = message.auth;
      renderAuth();
      break;
    case "agents.changed":
      state.agents = message.agents;
      state.workflows = message.workflows;
      renderAgents();
      break;
    case "chat.chunk": {
      const body = liveStreams.get(message.reqId);
      if (body) {
        body.textContent += message.delta;
        $("messages").scrollTop = $("messages").scrollHeight;
      }
      break;
    }
    case "chat.done":
      if (message.sessionId) state.sessionId = message.sessionId;
      finishStream(message.reqId);
      break;
    case "chat.error": {
      const body = liveStreams.get(message.reqId);
      if (body && !body.textContent) {
        body.textContent = `⚠ ${message.message}`;
      } else {
        appendMessage("system", `⚠ ${message.message}`);
      }
      finishStream(message.reqId);
      break;
    }
    case "workflow.status":
      renderWorkflowStatus(message.reqId, message.run);
      break;
    case "workflow.error": {
      const card = workflowCards.get(message.reqId);
      if (card) card.textContent = `⚠ ${message.message}`;
      workflowCards.delete(message.reqId);
      break;
    }
    case "selection.context": {
      const input = $("composer-input") as HTMLTextAreaElement;
      const fence = message.languageId ? "```" + message.languageId : "```";
      input.value = `${input.value ? input.value + "\n" : ""}${fence}\n${message.text}\n\`\`\`\n`;
      input.focus();
      break;
    }
    case "engine.request":
      void handleEngineRequest(message);
      break;
    case "engine.abort":
      engineHost?.abort(message.reqId);
      break;
    case "sdlc.run.result":
      renderRunResult(message);
      break;
  }
}

// --- optional in-webview engine host (loaded lazily; M2 wires the real
// implementation from ../engineHost - kept behind dynamic import so hosts
// that never enable local inference don't pay for the WebLLM bundle) -------

interface EngineHostModule {
  start(onStatus: (s: EngineStatus) => void): Promise<void>;
  run(
    reqId: string,
    kind: string,
    payload: { text: string; languageId?: string; suffix?: string; systemPrompt?: string }
  ): Promise<{ ok: boolean; text?: string; reason?: string }>;
  abort(reqId: string): void;
  download(modelId: string): Promise<void>;
}

let engineHost: EngineHostModule | null = null;

async function startEngineHost(): Promise<void> {
  try {
    const mod = (await import("../engineHost")) as unknown as { createEngineHost(): EngineHostModule };
    engineHost = mod.createEngineHost();
    await engineHost.start((status) => {
      state.engine = status;
      renderEngine();
      transport.post({ type: "engine.status", status });
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    state.engine = { state: "unavailable", detail };
    renderEngine();
    transport.post({ type: "engine.status", status: state.engine });
  }
}

async function handleEngineRequest(
  message: Extract<HostToWebview, { type: "engine.request" }>
): Promise<void> {
  if (!engineHost) {
    transport.post({ type: "engine.result", reqId: message.reqId, ok: false, reason: "engine-off" });
    return;
  }
  const result = await engineHost.run(message.reqId, message.kind, message.payload);
  transport.post({ type: "engine.result", reqId: message.reqId, ...result });
}

// --- boot ------------------------------------------------------------------

export function bootChatApp(injected?: WebviewTransport): void {
  const found = injected ?? detectTransport();
  if (!found) {
    document.body.textContent = "No host transport available.";
    return;
  }
  transport = found;
  transport.onMessage(onHostMessage);

  ($("composer-send") as HTMLButtonElement).addEventListener("click", () => {
    if (state.streamingReqId) {
      transport.post({ type: "chat.abort", reqId: state.streamingReqId });
    } else {
      sendChat();
    }
  });
  ($("composer-input") as HTMLTextAreaElement).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });
  const runButton = document.getElementById("composer-run") as HTMLButtonElement | null;
  runButton?.addEventListener("click", runInSandbox);

  ($("workflow-select") as HTMLSelectElement).addEventListener("change", (event) => {
    const workflowId = (event.target as HTMLSelectElement).value;
    if (workflowId) {
      runWorkflow(workflowId);
      (event.target as HTMLSelectElement).value = "";
    }
  });
  ($("agent-select") as HTMLSelectElement).addEventListener("change", (event) => {
    state.selectedAgentId = (event.target as HTMLSelectElement).value || null;
    state.sessionId = null; // new agent, new conversation
  });

  renderAuth();
  renderAgents();
  renderEngine();
  transport.post({ type: "ready" });
}

// Auto-boot when loaded directly by VS Code / JBCef pages. Chrome's side
// panel imports bootChatApp and passes its loopback transport instead; the
// data attribute lets it opt out of the auto-boot.
if (typeof document !== "undefined" && !document.body?.dataset.manualBoot) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootChatApp());
  } else {
    bootChatApp();
  }
}
