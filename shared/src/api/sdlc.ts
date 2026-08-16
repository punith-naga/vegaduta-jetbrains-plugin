// SDLC feature calls: E2B sandbox code execution and LLM-free code
// validation. Gated server-side to ROLE_tenant-admin or ROLE_agent-builder
// (core/security/SecurityConfig.java, "IDE/browser plugin SDLC alignment
// 2026-08-09") - a tenant-admin must explicitly grant agent-builder before a
// developer can use these. Every call here is best-effort: a 403 or the
// feature being unconfigured on the tenant (no E2B credential) resolves a
// typed { ok:false, reason, detail } result, never a thrown error, so
// callers can show a clear message instead of crashing the UI - same
// never-throw contract as the rest of the edge layer.
//
// code-intel (POST /api/code-intel/knowledge/query) is intentionally NOT
// wired here in v1: it can only index a git URL or a server-side path, never
// the plugin user's local working tree (see docs/IDE-PLUGIN-PLATFORM-
// CONTRACT), so a useful query first requires a repo to already be
// registered through the web console - out of scope for a client-side
// module. Add it here once that prerequisite has a plugin-side flow.

import type { VegadutaClient } from "./client";
import { ApiError } from "./client";

export type SandboxLanguage = "python" | "node" | "bash";
export type ValidateLanguage = "JAVA" | "PYTHON";

export type SdlcFailureReason = "forbidden" | "unavailable" | "unknown";

export interface RunCodeResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  reason?: SdlcFailureReason;
  detail?: string;
}

export interface ValidateIssue {
  line?: number;
  message: string;
}

export interface ValidateResult {
  ok: boolean;
  valid?: boolean;
  errors?: ValidateIssue[];
  warnings?: string[];
  reason?: SdlcFailureReason;
  detail?: string;
}

/** Maps a common editor languageId to the E2B sandbox's three supported
 * runtimes. Returns null for anything else - callers must not guess a
 * fallback, since running the wrong interpreter silently produces nonsense
 * output rather than a clear error. */
export function toSandboxLanguage(languageId: string | undefined): SandboxLanguage | null {
  switch ((languageId ?? "").toLowerCase()) {
    case "python":
      return "python";
    case "javascript":
    case "typescript":
    case "javascriptreact":
    case "typescriptreact":
      return "node";
    case "shellscript":
    case "bash":
    case "sh":
      return "bash";
    default:
      return null;
  }
}

/** Maps a common editor languageId to the validate endpoint's two supported
 * languages. Returns null for anything else. */
export function toValidateLanguage(languageId: string | undefined): ValidateLanguage | null {
  switch ((languageId ?? "").toLowerCase()) {
    case "java":
      return "JAVA";
    case "python":
      return "PYTHON";
    default:
      return null;
  }
}

function classify(err: unknown): { reason: SdlcFailureReason; detail: string } {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return {
        reason: "forbidden",
        detail: "Your account doesn't have sandbox/validate access yet - ask your tenant admin to grant the agent-builder role.",
      };
    }
    // Covers "no E2B credential configured on this tenant" and similar
    // domain errors - the server's own message (surfaced via ApiError from
    // GlobalExceptionHandler's { error }) already says what's wrong; we
    // don't re-guess it.
    return { reason: "unavailable", detail: err.message };
  }
  return { reason: "unknown", detail: err instanceof Error ? err.message : String(err) };
}

/** POST /api/sdlc/sandbox/run-code - stateless, disposable-sandbox
 * execution. SdlcSandboxService.runCode creates a fresh sandbox, runs the
 * one call, and always tears it down itself - nothing lingers on the
 * tenant's account from this call. */
export async function runCode(
  client: VegadutaClient,
  code: string,
  language: SandboxLanguage,
  timeoutSeconds?: number
): Promise<RunCodeResult> {
  try {
    const body = await client.json<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(
      "/api/sdlc/sandbox/run-code",
      { method: "POST", body: { code, language, timeoutSeconds } }
    );
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, ...classify(err) };
  }
}

/** POST /api/tools/code/validate - LLM-free syntax/safety check via the
 * tool-sandbox microservice. errors/warnings are omitted on a valid verdict
 * server-side; normalized to [] here so callers never null-check. */
export async function validateCode(
  client: VegadutaClient,
  language: ValidateLanguage,
  sourceCode: string
): Promise<ValidateResult> {
  try {
    const body = await client.json<{ valid: boolean; errors?: ValidateIssue[]; warnings?: string[] }>(
      "/api/tools/code/validate",
      { method: "POST", body: { language, sourceCode } }
    );
    return { ok: true, valid: body.valid, errors: body.errors ?? [], warnings: body.warnings ?? [] };
  } catch (err) {
    return { ok: false, ...classify(err) };
  }
}
