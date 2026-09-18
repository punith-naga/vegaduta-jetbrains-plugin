// The agent seam: one provider-agnostic contract for a multi-step, tool-calling
// coding agent, shared by every client host (VS Code, JetBrains via the webview,
// Chrome). Deliberately separate from `edge/engine.ts`: LocalEngine is a
// text-in/text-out completion contract frozen across three hosts, and bolting
// tool-calling onto it would break all of them. This layer sits beside it.
//
// Typed-failure contract, same convention as edge/engine.ts and api/sdlc.ts:
// nothing here throws to a caller. Every failure is a `{ ok: false, reason }`.
//
// WHO EXECUTES WHAT. The model and the loop live here and are host-agnostic.
// The *tools* are not: reading a file, editing a buffer and running a command
// mean different things in an editor, a JCEF panel and a browser tab. So a host
// supplies a `ToolExecutor`; this module never touches a filesystem, a process
// or a platform API of its own.

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type AgentFailureReason =
  | "no-model" // nothing configured/reachable to talk to
  | "model-failed" // the provider call itself failed (network, 5xx, bad key)
  | "model-refused" // provider returned a content-policy refusal
  | "no-tool-support" // the model/endpoint cannot do tool-calling at all
  | "step-budget-exceeded" // hit maxSteps without finishing
  | "empty-reply" // model returned neither text nor a tool call
  | "aborted"; // caller's AbortSignal fired

export interface AgentFailure {
  ok: false;
  reason: AgentFailureReason;
  /** Original error text, for logs - never rendered raw in the UI. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Provider-assigned id; echoed back on the matching tool result. */
  id: string;
  name: string;
  /** Parsed arguments. Providers hand these over as a JSON *string* and small
   * models routinely emit invalid JSON - the model adapter is responsible for
   * repairing or rejecting, so the loop only ever sees an object. */
  args: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema object describing a tool's parameters. Kept as a loose record
 * on purpose: every provider wants slightly different dialect quirks and this
 * is passed through, not interpreted, by this layer. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** True when running this tool changes the user's machine (writes a file,
   * runs a command). Hosts gate these behind approval; read-only tools run
   * unattended. The loop does not enforce it - the executor does - but it
   * travels with the spec so a host cannot forget which is which. */
  mutating: boolean;
}

export interface ToolOutcome {
  /** What the model is told. Errors are content, not exceptions: a failed tool
   * call the model can read and correct is worth far more than a dead turn. */
  content: string;
  /** True when the tool failed. Surfaced to the host for UI; the model still
   * receives `content` either way. */
  failed?: boolean;
}

export interface ToolExecutor {
  /** The tools this host actually implements, in the order they should be
   * offered to the model. */
  specs(): ToolSpec[];
  /** Never throws: a thrown error inside a tool must come back as a failed
   * ToolOutcome so the loop can feed it to the model. */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome>;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface ModelReply {
  ok: true;
  /** Assistant prose. May be empty when the model only called tools. */
  content: string;
  toolCalls: ToolCall[];
  modelId: string;
}

export type ModelResult = ModelReply | AgentFailure;

export interface AgentModel {
  /** Stable id for logs and the status bar, e.g. "ollama:qwen2.5-coder:7b". */
  id: string;
  /** True when this model can be talked to right now. Never rejects. */
  probe(): Promise<boolean>;
  /** One round trip. Never throws - typed results only. */
  chat(
    messages: AgentMessage[],
    tools: ToolSpec[],
    signal?: AbortSignal
  ): Promise<ModelResult>;
}

// ---------------------------------------------------------------------------
// Loop events
// ---------------------------------------------------------------------------

/** Emitted as the loop runs so a host can render progress. Every event is
 * advisory: dropping all of them changes nothing about the outcome. */
export type AgentEvent =
  | { type: "step"; index: number; of: number }
  | { type: "assistant"; content: string }
  | { type: "tool-start"; call: ToolCall; mutating: boolean }
  | { type: "tool-end"; call: ToolCall; outcome: ToolOutcome }
  | { type: "done"; reason: "finished" | "no-more-tool-calls" };

export interface AgentRunSuccess {
  ok: true;
  /** The assistant's final prose. */
  answer: string;
  /** Full transcript including tool traffic - hosts persist this, not the caller. */
  messages: AgentMessage[];
  stepsUsed: number;
}

export type AgentRunResult = AgentRunSuccess | AgentFailure;
