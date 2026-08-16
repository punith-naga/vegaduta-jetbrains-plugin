import { describe, expect, it } from "vitest";
import { nextReqId } from "../src/webview/protocol";
import type { HostToWebview, WebviewToHost } from "../src/webview/protocol";
import { createLoopbackPair } from "../src/webview/bridge";

/** createLoopbackPair delivers via queueMicrotask; a macrotask hop drains
 * everything scheduled so far. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("nextReqId", () => {
  it("is strictly monotonic, including across prefixes", () => {
    const ids = [
      nextReqId("chat"),
      nextReqId("chat"),
      nextReqId("wf"),
      nextReqId("chat"),
      nextReqId("wf"),
    ];
    expect(ids[0]).toMatch(/^chat-\d+$/);
    expect(ids[2]).toMatch(/^wf-\d+$/);
    const counters = ids.map((id) => Number(id.slice(id.lastIndexOf("-") + 1)));
    for (let i = 1; i < counters.length; i++) {
      expect(counters[i]).toBeGreaterThan(counters[i - 1]);
    }
  });

  it("never collides within a page lifetime", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(nextReqId("x"));
    }
    expect(seen.size).toBe(1000);
  });
});

describe("createLoopbackPair", () => {
  it("delivers webview -> host when the handler is already registered", async () => {
    const { webview, host } = createLoopbackPair();
    const received: WebviewToHost[] = [];
    host.onMessage((m) => received.push(m));

    webview.post({ type: "ready" });
    expect(received).toEqual([]); // async, never reentrant
    await flush();
    expect(received).toEqual([{ type: "ready" }]);
  });

  it("delivers host -> webview when the handler is already registered", async () => {
    const { webview, host } = createLoopbackPair();
    const received: HostToWebview[] = [];
    webview.onMessage((m) => received.push(m));

    host.post({ type: "chat.chunk", reqId: "chat-1", delta: "hello" });
    await flush();
    expect(received).toEqual([{ type: "chat.chunk", reqId: "chat-1", delta: "hello" }]);
  });

  it("queues webview -> host messages posted before the handler exists, in order", async () => {
    const { webview, host } = createLoopbackPair();
    webview.post({ type: "ready" });
    webview.post({ type: "auth.signIn" });
    await flush(); // microtasks ran with no handler -> messages parked

    const received: WebviewToHost[] = [];
    host.onMessage((m) => received.push(m));
    // Queued backlog is drained synchronously on registration.
    expect(received).toEqual([{ type: "ready" }, { type: "auth.signIn" }]);
  });

  it("queues host -> webview messages posted before the handler exists, in order", async () => {
    const { webview, host } = createLoopbackPair();
    host.post({ type: "chat.chunk", reqId: "chat-1", delta: "a" });
    host.post({ type: "chat.done", reqId: "chat-1", sessionId: "sess-1" });
    await flush();

    const received: HostToWebview[] = [];
    webview.onMessage((m) => received.push(m));
    expect(received).toEqual([
      { type: "chat.chunk", reqId: "chat-1", delta: "a" },
      { type: "chat.done", reqId: "chat-1", sessionId: "sess-1" },
    ]);
  });

  it("round-trips a request/response pair by reqId", async () => {
    const { webview, host } = createLoopbackPair();

    host.onMessage((m) => {
      if (m.type === "chat.send") {
        host.post({ type: "chat.chunk", reqId: m.reqId, delta: "pong" });
        host.post({ type: "chat.done", reqId: m.reqId, sessionId: null });
      }
    });

    const received: HostToWebview[] = [];
    webview.onMessage((m) => received.push(m));

    const reqId = nextReqId("chat");
    webview.post({ type: "chat.send", reqId, agentId: "a1", message: "ping", sessionId: null });
    await flush();
    await flush(); // host replies scheduled from within the first drain

    expect(received).toEqual([
      { type: "chat.chunk", reqId, delta: "pong" },
      { type: "chat.done", reqId, sessionId: null },
    ]);
  });
});
