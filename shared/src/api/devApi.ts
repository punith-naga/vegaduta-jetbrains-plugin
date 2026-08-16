// Headless fallback surface: /api/dev/v1, authenticated by a hand-pasted
// vmcp_ scoped API key (core/mcpserver/DeveloperApiController.java). Used
// when the user hasn't signed in interactively (CI, restricted machines).
// Chat here is BLOCKING (no SSE) by design - the streaming surface is
// JWT-only. Listing + run-status GETs are the B2 backend additions.

import { ApiError, describeNetworkFailure } from "./client";
import type { AgentSummary, WorkflowRun, WorkflowSummary } from "./types";

export interface DevChatResult {
  reply: string;
  sessionId: string;
}

export class DevApiClient {
  constructor(
    public readonly apiBase: string,
    private readonly apiKey: string
  ) {}

  private async call<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.apiBase).toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (cause) {
      throw new ApiError(0, `Could not reach ${this.apiBase}: ${describeNetworkFailure(cause)}`);
    }
    if (!response.ok) {
      let parsed: { error?: string; message?: string } = {};
      try {
        parsed = await response.json();
      } catch {
        // fall through
      }
      throw new ApiError(
        response.status,
        parsed.error ?? parsed.message ?? `${response.status} ${response.statusText}`
      );
    }
    return (await response.json()) as T;
  }

  chat(agentId: string, message: string, sessionId?: string, signal?: AbortSignal): Promise<DevChatResult> {
    return this.call<DevChatResult>(
      `/api/dev/v1/agents/${agentId}/chat`,
      "POST",
      { message, sessionId },
      signal
    );
  }

  runWorkflow(workflowId: string, input?: string): Promise<WorkflowRun> {
    return this.call<WorkflowRun>(`/api/dev/v1/workflows/${workflowId}/run`, "POST", { input });
  }

  listAgents(): Promise<AgentSummary[]> {
    return this.call<AgentSummary[]>("/api/dev/v1/agents", "GET");
  }

  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.call<WorkflowSummary[]>("/api/dev/v1/workflows", "GET");
  }

  getWorkflowRun(workflowId: string, runId: string): Promise<WorkflowRun> {
    return this.call<WorkflowRun>(`/api/dev/v1/workflows/${workflowId}/runs/${runId}`, "GET");
  }
}

/** A pasted key is expected to look like vmcp_<base64url>; warn-level check
 * only (the server is the authority). */
export function looksLikeApiKey(value: string): boolean {
  return /^vmcp_[A-Za-z0-9_-]{16,}$/.test(value.trim());
}
