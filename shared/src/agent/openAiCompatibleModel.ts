// One AgentModel implementation that covers both halves of the free story,
// because they speak the same wire protocol:
//
//   local, $0, no account   - Ollama / LM Studio / llama.cpp on 127.0.0.1
//   BYOK, $0 on free tiers  - Groq, Cerebras, OpenRouter, Together, OpenAI, ...
//
// Anything serving POST /v1/chat/completions with OpenAI-shaped `tools` works.
// That is the whole reason this adapter exists instead of one per provider.
//
// RULE 0 NOTE (same carve-out as edge/ollamaEngine.ts): a 127.0.0.1 default
// here is the USER'S OWN inference server on their own machine. It is not a
// browser-facing platform URL or a token issuer, so the no-localhost rule does
// not apply. There is deliberately no default for a hosted `baseUrl` - a BYOK
// caller must pass one.

import type {
  AgentFailure,
  AgentMessage,
  AgentModel,
  ModelResult,
  ToolCall,
  ToolSpec,
} from "./types";

/** Ollama's OpenAI-compatible endpoint. LM Studio defaults to :1234. */
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434";

const PROBE_TIMEOUT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 180_000;

export interface OpenAiCompatibleOptions {
  /** Origin only, no path. Trailing slashes tolerated. */
  baseUrl?: string;
  /** Omitted for a local server; required by every hosted provider. */
  apiKey?: string;
  /** Model id on that server. When unset, probe() adopts the first one listed. */
  model?: string;
  /** Injected for tests and for hosts with a non-global fetch. */
  fetchImpl?: typeof fetch;
  /** Sent as-is; providers that ignore it are unaffected. */
  temperature?: number;
  maxTokens?: number;
}

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  finish_reason?: string;
}

function failure(reason: AgentFailure["reason"], detail?: unknown): AgentFailure {
  return {
    ok: false,
    reason,
    detail: detail instanceof Error ? detail.message : detail != null ? String(detail) : undefined,
  };
}

/**
 * Small models emit invalid JSON for tool arguments often enough that failing
 * the turn on it is the wrong default. Two repairs, both conservative: parse as
 * given, then parse the outermost brace span. Anything past that is guesswork,
 * so it is reported back to the model rather than silently reshaped.
 */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> | null {
  if (raw == null) return {};
  const text = raw.trim();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the span attempt
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // give up - the loop reports this back to the model as a tool error
    }
  }
  return null;
}

/** Our AgentMessage to the OpenAI chat wire shape. */
function toWireMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Providers disagree on how they reject an unsupported `tools` payload, but all
 * of them say so in the body. Matching the body beats matching the status. */
function looksLikeNoToolSupport(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("tool") &&
    (lower.includes("not supported") ||
      lower.includes("does not support") ||
      lower.includes("unsupported") ||
      lower.includes("unknown parameter") ||
      lower.includes("unrecognized"))
  );
}

export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions = {}): AgentModel {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const base = (options.baseUrl?.trim() || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
  let model = options.model?.trim() ?? "";

  function headers(): Record<string, string> {
    const out: Record<string, string> = { "content-type": "application/json" };
    const key = options.apiKey?.trim();
    if (key) out.authorization = `Bearer ${key}`;
    return out;
  }

  /** Merges the caller's signal with our own deadline so neither is lost. */
  function deadline(ms: number, signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort);
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  async function probe(): Promise<boolean> {
    if (typeof doFetch !== "function") return false;
    const { signal, done } = deadline(PROBE_TIMEOUT_MS);
    try {
      const response = await doFetch(`${base}/v1/models`, { headers: headers(), signal });
      if (!response.ok) return false;
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => !!id);
      // An unset model adopts whatever the server actually has, so "I started
      // Ollama and pulled one model" needs no configuration at all.
      if (!model && ids.length > 0) model = ids[0];
      return ids.length > 0 || !!model;
    } catch {
      return false;
    } finally {
      done();
    }
  }

  return {
    get id(): string {
      return model ? `${base} (${model})` : base;
    },

    probe,

    async chat(
      messages: AgentMessage[],
      tools: ToolSpec[],
      signal?: AbortSignal
    ): Promise<ModelResult> {
      if (typeof doFetch !== "function") return failure("no-model", "no fetch implementation");
      if (!model && !(await probe())) return failure("no-model", `nothing reachable at ${base}`);

      const { signal: timed, done } = deadline(REQUEST_TIMEOUT_MS, signal);
      try {
        const response = await doFetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: headers(),
          signal: timed,
          body: JSON.stringify({
            model,
            messages: toWireMessages(messages),
            ...(tools.length ? { tools: toWireTools(tools), tool_choice: "auto" } : {}),
            ...(options.temperature != null ? { temperature: options.temperature } : {}),
            ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
            stream: false,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          if (looksLikeNoToolSupport(response.status, body)) {
            return failure("no-tool-support", `${response.status}: ${body.slice(0, 400)}`);
          }
          return failure("model-failed", `${response.status}: ${body.slice(0, 400)}`);
        }

        const payload = (await response.json()) as { choices?: WireChoice[] };
        const choice = payload.choices?.[0];
        if (!choice) return failure("empty-reply", "no choices in response");
        if (choice.finish_reason === "content_filter") return failure("model-refused");

        const content = choice.message?.content ?? "";
        const calls: ToolCall[] = [];
        let index = 0;
        for (const wire of choice.message?.tool_calls ?? []) {
          const name = wire.function?.name;
          if (!name) continue;
          const args = parseToolArguments(wire.function?.arguments);
          calls.push({
            id: wire.id ?? `call_${index}`,
            name,
            // A failed parse is NOT dropped: the loop must still answer this
            // tool_call_id or the next request is malformed. Empty args become a
            // readable error from the executor, which the model can correct.
            args: args ?? {},
          });
          index += 1;
        }

        if (!content.trim() && calls.length === 0) return failure("empty-reply");
        return { ok: true, content, toolCalls: calls, modelId: model };
      } catch (error) {
        if (signal?.aborted) return failure("aborted");
        return failure("model-failed", error);
      } finally {
        done();
      }
    },
  };
}
