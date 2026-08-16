// Wire shapes for the platform endpoints the plugins call. Field names match
// the Java DTOs (Jackson serializes UUID/Instant as strings). Only the fields
// the plugins actually consume are declared - the server may send more.

/** Subset of core/agents/.../dto/AgentResponse.java. */
export interface AgentSummary {
  id: string;
  name: string;
  description?: string | null;
  model?: string | null;
}

/** Subset of core/workflow WorkflowResponse. */
export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string | null;
}

/** Matches WorkflowRunStatus.java (terminal states checked by pollers). */
export type WorkflowRunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | string; // forward-compatible: treat unknown values as non-terminal

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/** Matches core/workflow WorkflowRunResponse (same shape on JWT and dev/v1 surfaces). */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  status: WorkflowRunStatus;
  requestedBy?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  outputFileName?: string | null;
}

/** Environment presets. RULE 0: no localhost defaults anywhere - the two real
 * deployments are staging (.xyz) and production (.ai). `custom` exists for
 * self-hosted installs, entered explicitly by the user in settings. */
export interface PlatformEnvironment {
  apiBase: string;
  authBase: string;
}

export const ENVIRONMENTS: Record<"staging" | "production", PlatformEnvironment> = {
  staging: {
    apiBase: "https://api.vegaduta.xyz",
    authBase: "https://auth.vegaduta.xyz",
  },
  production: {
    apiBase: "https://api.vegaduta.ai",
    authBase: "https://auth.vegaduta.ai",
  },
};

export const KEYCLOAK_REALM = "agentic-ai";
export const IDE_CLIENT_ID = "agentic-ai-ide";
