// Wire-contract tests for the SSE reader. The slice(5) cases guard the
// space-chunk regression documented in src/api/sse.ts - a lone word-boundary
// token arrives as "data: " and its payload is exactly one space.

import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import type { VegadutaClient } from "../src/api/client";
import { STREAM_ERROR_MARKER, createSseEventReader, streamAgentChat } from "../src/api/sse";

function collect(): { deltas: string[]; onChunk: (delta: string) => void } {
  const deltas: string[] = [];
  return { deltas, onChunk: (delta) => deltas.push(delta) };
}

// One backend chunk is one EVENT (terminated by a blank line), not one line -
// a payload with newlines arrives as several `data:` lines and must be
// rejoined with LF. See src/api/sse.ts's header for the Spring framing this
// mirrors.
describe("createSseEventReader", () => {
  function read(lines: string[]): string[] {
    const { deltas, onChunk } = collect();
    const reader = createSseEventReader(onChunk);
    for (const line of lines) reader.consumeLine(line);
    reader.flush();
    return deltas;
  }

  it("strips exactly the 5-char data: prefix", () => {
    expect(read(["data:hello", ""])).toEqual(["hello"]);
  });

  it("preserves a leading payload space (no 6th char eaten)", () => {
    expect(read(["data: hello", ""])).toEqual([" hello"]);
  });

  it("delivers the lone-space chunk: 'data: ' => ' '", () => {
    expect(read(["data: ", ""])).toEqual([" "]);
  });

  it("forwards an empty payload as an empty string", () => {
    expect(read(["data:", ""])).toEqual([""]);
  });

  it("rejoins one event's data lines with a newline", () => {
    expect(read(["data:# Heading", "data:", "data:- one", "data:- two", ""]))
      .toEqual(["# Heading\n\n- one\n- two"]);
  });

  it("keeps separate events separate", () => {
    expect(read(["data:one", "", "data:two", ""])).toEqual(["one", "two"]);
  });

  it("flushes a final event the server never terminated", () => {
    expect(read(["data:tail"])).toEqual(["tail"]);
  });

  it("tolerates CRLF line endings", () => {
    expect(read(["data:a\r", "data:b\r", "\r"])).toEqual(["a\nb"]);
  });

  it("throws ApiError carrying the sentinel's suffix message", () => {
    const { onChunk } = collect();
    const reader = createSseEventReader(onChunk);
    let caught: unknown;
    try {
      reader.consumeLine(`data:${STREAM_ERROR_MARKER}Provider exploded`);
      reader.flush();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(0);
    expect((caught as ApiError).message).toBe("Provider exploded");
  });

  it("throws a default message on a bare sentinel", () => {
    const { onChunk } = collect();
    const reader = createSseEventReader(onChunk);
    reader.consumeLine(`data:${STREAM_ERROR_MARKER}`);
    expect(() => reader.flush()).toThrowError("The response was interrupted. Please try again.");
  });

  it("ignores non-data lines (comments, ids, events, wrong case, indented)", () => {
    expect(read([": keep-alive", "id:1", "event:message", "Data:nope", "  data:x", ""])).toEqual([]);
  });
});

// --- streamAgentChat -------------------------------------------------------

function sseResponse(chunks: (string | Uint8Array)[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

function fakeClient(response: Response): VegadutaClient {
  return { request: async () => response } as unknown as VegadutaClient;
}

describe("streamAgentChat", () => {
  it("buffers events across chunk boundaries and captures X-Session-Id", async () => {
    const { deltas, onChunk } = collect();
    const response = sseResponse(
      ["data:Hel", "lo\n\ndata: \n\nda", "ta:world\n\n"],
      { "X-Session-Id": "sess-123" }
    );
    const result = await streamAgentChat(fakeClient(response), {
      agentId: "a1",
      message: "hi",
      onChunk,
    });
    expect(deltas).toEqual(["Hello", " ", "world"]);
    expect(result.sessionId).toBe("sess-123");
  });

  it("emits a final line that has no trailing newline", async () => {
    const { deltas, onChunk } = collect();
    const response = sseResponse(["data:first\n\n", "data:tail"]);
    await streamAgentChat(fakeClient(response), { agentId: "a1", message: "hi", onChunk });
    expect(deltas).toEqual(["first", "tail"]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const { deltas, onChunk } = collect();
    const bytes = new TextEncoder().encode("data:héllo\n\n");
    const cut = 7; // splits the 2-byte é
    const response = sseResponse([bytes.slice(0, cut), bytes.slice(cut)]);
    await streamAgentChat(fakeClient(response), { agentId: "a1", message: "hi", onChunk });
    expect(deltas).toEqual(["héllo"]);
  });

  it("rejects with the sentinel's message on a mid-stream failure", async () => {
    const { deltas, onChunk } = collect();
    const response = sseResponse([
      "data:partial\n\n",
      `data:${STREAM_ERROR_MARKER}Upstream provider timed out\n\n`,
    ]);
    await expect(
      streamAgentChat(fakeClient(response), { agentId: "a1", message: "hi", onChunk })
    ).rejects.toMatchObject({ name: "ApiError", status: 0, message: "Upstream provider timed out" });
    expect(deltas).toEqual(["partial"]);
  });

  it("falls back to the caller's sessionId when no header is returned", async () => {
    const { onChunk } = collect();
    const response = sseResponse(["data:ok\n\n"]);
    const result = await streamAgentChat(fakeClient(response), {
      agentId: "a1",
      message: "hi",
      sessionId: "sess-prev",
      onChunk,
    });
    expect(result.sessionId).toBe("sess-prev");
  });

  it("surfaces a non-ok response body's error as ApiError", async () => {
    const { onChunk } = collect();
    const response = new Response(JSON.stringify({ error: "Agent not found" }), {
      status: 404,
      statusText: "Not Found",
    });
    await expect(
      streamAgentChat(fakeClient(response), { agentId: "missing", message: "hi", onChunk })
    ).rejects.toMatchObject({ name: "ApiError", status: 404, message: "Agent not found" });
  });
});
