// Dependency-free HTTP client for the platform API, usable from Node 20+
// (VS Code extension host), Chrome MV3 extension pages, and any other fetch
// environment. Follows desktop-agent/src/api.ts's conventions: ApiError with
// the status attached, undici cause-unwrapping for readable network failures,
// and core's GlobalExceptionHandler `{ error }` body surfaced verbatim.

import type { AgentSummary, WorkflowRun, WorkflowSummary } from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Node's fetch (undici) wraps connect-refused/DNS/TLS failures in a generic
 * `TypeError: fetch failed` whose useful detail lives on `.cause`; for
 * ECONNREFUSED the dual-stack AggregateError's own message is empty and the
 * real messages sit in `.errors[]`. Same unwrapping as desktop-agent. */
export function describeNetworkFailure(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }
  const inner = cause.cause instanceof Error ? cause.cause : cause;
  if (inner.message) {
    return inner.message;
  }
  const aggregate = inner as { code?: string; errors?: unknown };
  if (Array.isArray(aggregate.errors) && aggregate.errors.length > 0) {
    const first = aggregate.errors[0];
    if (first instanceof Error && first.message) {
      return first.message;
    }
  }
  if (aggregate.code) {
    return String(aggregate.code);
  }
  return cause.message || String(cause);
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

/** Supplies bearer tokens. `refresh()` is invoked at most once per request,
 * only after a 401, and should return the new token or null if re-auth is
 * impossible (signed out / refresh token expired). */
export interface TokenProvider {
  getToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class VegadutaClient {
  constructor(
    public readonly apiBase: string,
    private readonly tokens: TokenProvider
  ) {}

  /** Raw request with auth + single 401-retry-after-refresh (the apiFetch
   * pattern from web/app/lib/api.ts, minus the browser toast layer). Returns
   * the Response so streaming callers can take over the body. */
  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const attempt = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = { ...options.headers };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      let bodyInit: string | undefined;
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        bodyInit = JSON.stringify(options.body);
      }
      try {
        return await fetch(new URL(path, this.apiBase).toString(), {
          method: options.method ?? "GET",
          headers,
          body: bodyInit,
          signal: options.signal,
        });
      } catch (cause) {
        if (options.signal?.aborted) {
          throw cause;
        }
        throw new ApiError(0, `Could not reach ${this.apiBase}: ${describeNetworkFailure(cause)}`);
      }
    };

    let response = await attempt(await this.tokens.getToken());
    if (response.status === 401) {
      const refreshed = await this.tokens.refresh();
      if (refreshed) {
        response = await attempt(refreshed);
      }
    }
    return response;
  }

  /** request() + ok-check + JSON parse. */
  async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    if (!response.ok) {
      throw new ApiError(response.status, await extractErrorMessage(response));
    }
    return (await response.json()) as T;
  }

  // --- typed endpoints (JWT surface) ---------------------------------------

  listAgents(signal?: AbortSignal): Promise<AgentSummary[]> {
    return this.json<AgentSummary[]>("/api/agents", { signal });
  }

  listWorkflows(signal?: AbortSignal): Promise<WorkflowSummary[]> {
    return this.json<WorkflowSummary[]>("/api/workflows", { signal });
  }

  runWorkflow(
    workflowId: string,
    input: string,
    clientRunId?: string,
    signal?: AbortSignal
  ): Promise<WorkflowRun> {
    return this.json<WorkflowRun>(`/api/workflows/${workflowId}/run`, {
      method: "POST",
      body: { input, clientRunId },
      signal,
    });
  }

  getWorkflowRun(workflowId: string, runId: string, signal?: AbortSignal): Promise<WorkflowRun> {
    return this.json<WorkflowRun>(`/api/workflows/${workflowId}/runs/${runId}`, { signal });
  }

  cancelWorkflowRun(workflowId: string, runId: string): Promise<WorkflowRun> {
    return this.json<WorkflowRun>(`/api/workflows/${workflowId}/runs/${runId}/cancel`, {
      method: "POST",
    });
  }
}

/** TokenProvider for a static, hand-pasted credential (vmcp_ API key). The
 * key never expires client-side, so refresh() has nothing to do. */
export function staticTokenProvider(token: string): TokenProvider {
  return {
    getToken: async () => token,
    refresh: async () => null,
  };
}
