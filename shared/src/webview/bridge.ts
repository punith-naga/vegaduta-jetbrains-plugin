// Webview-side transport implementations for the three hosts. The chat app
// calls detectTransport() once; the result hides which host it's inside.
//
//  - VS Code: acquireVsCodeApi().postMessage / window "message" events.
//  - JetBrains: window.cefQuery (JBCefJSQuery injects it) for webview->host;
//    host->webview arrives via browser.executeJavaScript calling
//    window.__vegadutaDeliver(json).
//  - Chrome: the side panel page IS the host - createLoopbackPair() wires the
//    two halves together in-page and the panel's own code implements the
//    host half (auth, fetch, SSE) right there.

import type {
  HostToWebview,
  HostTransport,
  WebviewToHost,
  WebviewTransport,
} from "./protocol";

type VsCodeApi = { postMessage(message: unknown): void };

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    cefQuery?: (args: { request: string; onSuccess?: (r: string) => void; onFailure?: (c: number, m: string) => void }) => void;
    __vegadutaDeliver?: (json: string) => void;
  }
}

export function detectTransport(): WebviewTransport | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (window.acquireVsCodeApi) {
    const api = window.acquireVsCodeApi();
    return {
      post: (message) => api.postMessage(message),
      onMessage: (handler) => {
        window.addEventListener("message", (event) => handler(event.data as HostToWebview));
      },
    };
  }
  if (window.cefQuery) {
    return {
      post: (message) => window.cefQuery!({ request: JSON.stringify(message) }),
      onMessage: (handler) => {
        window.__vegadutaDeliver = (json: string) => {
          handler(JSON.parse(json) as HostToWebview);
        };
      },
    };
  }
  return null;
}

/** In-page pair for Chrome (and unit tests): the panel page implements the
 * host half against `host`, the chat app consumes `webview`. Handlers are
 * invoked asynchronously (microtask) to preserve postMessage-like ordering
 * semantics and avoid reentrancy surprises. */
export function createLoopbackPair(): { webview: WebviewTransport; host: HostTransport } {
  let toHost: ((m: WebviewToHost) => void) | null = null;
  let toWebview: ((m: HostToWebview) => void) | null = null;
  const pendingToHost: WebviewToHost[] = [];
  const pendingToWebview: HostToWebview[] = [];

  return {
    webview: {
      post: (message) => {
        queueMicrotask(() => {
          if (toHost) toHost(message);
          else pendingToHost.push(message);
        });
      },
      onMessage: (handler) => {
        toWebview = handler;
        for (const m of pendingToWebview.splice(0)) handler(m);
      },
    },
    host: {
      post: (message) => {
        queueMicrotask(() => {
          if (toWebview) toWebview(message);
          else pendingToWebview.push(message);
        });
      },
      onMessage: (handler) => {
        toHost = handler;
        for (const m of pendingToHost.splice(0)) handler(m);
      },
    },
  };
}
