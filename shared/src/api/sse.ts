// SSE reader for POST /api/agents/{agentId}/chat. Mirrors the contract
// implemented in web/app/lib/api.ts (streamChat) and AgentController.java:
//
//  - Framing is `data:<content>` with NO separator space from Spring's
//    writer. Strip EXACTLY the 5-char "data:" prefix (slice(5)) - never a
//    6th char. A chunk that is exactly one space (a lone word-boundary
//    token) arrives as "data: ", indistinguishable from "framing space +
//    empty content"; eating the 6th char silently drops every one of those
//    and entire replies render with no spaces between words. This bug
//    shipped once in web/ - do not reintroduce it here.
//  - The server-assigned session id arrives in the `X-Session-Id` response
//    header when the request didn't carry one.
//  - A mid-stream provider failure (HTTP status already committed) arrives
//    as one final synthetic chunk prefixed with STREAM_ERROR_MARKER; it must
//    surface as an error, never as literal streamed text.
//  - One backend chunk is one SSE EVENT, not one line. Spring frames a payload
//    containing newlines as SEVERAL `data:` lines - SseEmitter's
//    SseEventBuilderImpl#data replaces every LF with "LF data:" before
//    writing - terminated by a blank line. Accumulate an event's data lines
//    and rejoin them with LF; forwarding each line separately deletes every
//    newline in the reply, which is catastrophic on the buffered reasoning
//    depths (CAREFUL/RIGOROUS/PLANNED), where the WHOLE answer is a single
//    multi-line event. This bug shipped once in web/ - do not reintroduce it.

import { ApiError } from "./client";
import type { VegadutaClient } from "./client";

/** Mirror of AgentController.STREAM_ERROR_MARKER. */
export const STREAM_ERROR_MARKER = "@@AGENT_CHAT_STREAM_ERROR_9f2b1c@@";

export interface StreamChatParams {
  agentId: string;
  message: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  onChunk: (delta: string) => void;
}

export interface StreamChatResult {
  /** Server-assigned session id (from X-Session-Id) or the one passed in. */
  sessionId: string | null;
}

export async function streamAgentChat(
  client: VegadutaClient,
  params: StreamChatParams
): Promise<StreamChatResult> {
  const response = await client.request(`/api/agents/${params.agentId}/chat`, {
    method: "POST",
    body: {
      sessionId: params.sessionId || undefined,
      message: params.message,
    },
    signal: params.signal,
  });

  if (!response.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await response.json();
    } catch {
      // non-JSON error body - fall through to status text
    }
    throw new ApiError(
      response.status,
      body.error || body.message || `${response.status} ${response.statusText}`
    );
  }

  const sessionId = response.headers.get("X-Session-Id") ?? params.sessionId ?? null;
  if (!response.body) {
    throw new ApiError(0, "The server returned no response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = createSseEventReader(params.onChunk);
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      events.consumeLine(line);
    }
  }
  // A final line, and a final event, that the server never terminated.
  buffer += decoder.decode();
  if (buffer) {
    events.consumeLine(buffer);
  }
  events.flush();

  return { sessionId };
}

export interface SseEventReader {
  /** Feed one complete wire line (without its terminating newline). */
  consumeLine(line: string): void;
  /** Emit a trailing event the server never terminated with a blank line. */
  flush(): void;
}

/** Assembles `data:` lines into whole SSE events. Exported for tests. Throws
 * on the error sentinel; forwards a completed event's payload to `onChunk`;
 * ignores every other field (`event:`, `id:`, `retry:`) and comments. */
export function createSseEventReader(onChunk: (delta: string) => void): SseEventReader {
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n");
    dataLines = [];
    if (payload.startsWith(STREAM_ERROR_MARKER)) {
      throw new ApiError(
        0,
        payload.slice(STREAM_ERROR_MARKER.length) || "The response was interrupted. Please try again."
      );
    }
    onChunk(payload);
  };

  return {
    consumeLine(rawLine: string) {
      // CR tolerance: the spec lets an event line end CR, LF or CRLF. Spring
      // writes bare LF, so this is defensive - but without it a CRLF stream
      // would never produce an empty line and no event would ever dispatch.
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        dispatch();
        return;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5));
      }
    },
    flush: dispatch,
  };
}
