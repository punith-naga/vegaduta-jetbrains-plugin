// Platform-served fill-in-the-middle completions - the path a user with no
// WebGPU and no local Ollama server takes, i.e. the only completion source
// the "free" story actually reaches on a plain laptop.
//
// THE CONTRACT BELOW IS READ OFF THE SERVER, not off a design sketch. Source:
// core/chat/src/main/java/com/agenticai/core/chat/FimCompletionController.java,
// FimCompletionService.java, FimCompletionEntitlements.java and
// core/common/GlobalExceptionHandler.java (handlers
// handlePerUserBudgetExhausted / handleTenantLimitExceeded).
//
//   POST {apiBase}/api/completions/fim
//   Authorization: Bearer <token>          (route is authenticated-only)
//   body  { prefix, suffix, language, maxTokens? }
//
//   200  { completion: string, model: string|null }
//        `completion` is ALWAYS present and MAY BE EMPTY: the controller
//        documents "" as the normal "no suggestion" answer (empty hosted
//        pool, saturated worker pool, missed server-side deadline, upstream
//        failure), explicitly not an error. `model` is null whenever
//        `completion` is empty. So an empty 200 must NOT cool the surface
//        down - it is the server working as designed.
//   400  neither prefix nor suffix was sent.
//   401  no / rejected credential.
//   402  PerUserBudgetExhaustedException - the caller's own dollar window is
//        exhausted. Body is { timestamp, status, error, budget, topUp }.
//   403  the OTHER quota code, and the one a 402-only client gets wrong: the
//        plain TenantLimitExceededException (tenant out of plan quota)
//        renders as 403, not 402 - and an ordinary authorization refusal
//        uses 403 too, with the same { timestamp, status, error } body and
//        no discriminating `code` field. The client therefore cannot tell
//        the two apart and treats both the same way: stop asking for this
//        session and carry the server's own message as the reason.
//   404  this core build has no such endpoint (older server).
//   413  prefix + suffix over the controller's context ceiling.
//   503  the deployment registered no FimCompletionEntitlements adapter, so
//        the service refuses to serve platform-paid inference unmetered.
//        Nothing about the request is wrong and nothing the user does fixes
//        it, so this backs off hard rather than retrying per keystroke.
//
// Posture is ported from web/app/lib/edge/toolBridge.ts, which solves the
// same problem (tier-1 client code calling an endpoint that may not exist on
// the deployed server yet):
//   - never throws: every outcome is a typed { ok:false, reason } result;
//   - a 404 marks the whole surface unavailable for the REST OF THE SESSION
//     rather than re-probing - "plain editing keeps working, nothing beyond a
//     details note is ever surfaced to the user";
//   - a reset hook exists for a new sign-in / environment switch.
//
// Two things toolBridge does not have to worry about and this does: the
// caller is an inline-completion provider, so a call can fire on every
// keystroke, and it has a sub-second latency budget. Hence the hard deadline
// on every request and the cooldown windows below - no failure path may turn
// into one request, or one hung await, per character typed.

import { VegadutaClient, type TokenProvider } from "./client";

export const FIM_PATH = "/api/completions/fim";

/** Matches the IDE inline-completion budget (clients/vscode provider) and is
 * the ceiling for any caller that does not pass its own. */
export const DEFAULT_HOSTED_DEADLINE_MS = 1200;

/** Same cap edge/completions.ts uses for the local engine - completions must
 * stay short whoever generates them. */
export const DEFAULT_HOSTED_MAX_TOKENS = 128;

// Back-off windows for the failures that are NOT sticky. These are chosen to
// keep a keystroke-rate caller from hammering the endpoint; they are not
// server-published values.
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const AUTH_COOLDOWN_MS = 60_000;
const ERROR_COOLDOWN_MS = 10_000;
/** 503 means the deployment cannot serve completions at all. Not sticky - a
 * gateway 503 during a rolling restart is transient and should heal without
 * the user reloading the window - but far longer than an ordinary error
 * window, because the documented cause (no entitlements adapter registered)
 * is fixed by a redeploy, not by waiting ten seconds. */
const UNAVAILABLE_COOLDOWN_MS = 300_000;
const MAX_RETRY_AFTER_MS = 300_000;

export type HostedCompletionFailureReason =
  /** No endpoint on this server (404), or nothing to call it with. A 404 is
   * sticky for the session; the other causes (no apiBase yet, a 503 with a
   * retry window) clear on their own, so do not read this reason as always
   * terminal. */
  | "unavailable"
  /** 402 - the caller's dollar budget is exhausted. Sticky for the session. */
  | "quota-exhausted"
  /** 429 - in a cooldown window. */
  | "rate-limited"
  /** 401, 403, or no credential at all. */
  | "unauthorized"
  /** Deadline exceeded - the caller should just show nothing. */
  | "timeout"
  /** The caller's own AbortSignal fired (new keystroke, cancelled request). */
  | "aborted"
  /** Network error, 5xx, unparseable body. */
  | "failed"
  /** 200 with nothing usable in it. */
  | "empty-reply";

export interface HostedCompletionRequest {
  /** Code before the cursor. */
  prefix: string;
  /** Code after the cursor. */
  suffix?: string;
  /** Editor languageId, passed through verbatim. */
  language?: string;
  maxTokens?: number;
  /** Hard deadline; defaults to DEFAULT_HOSTED_DEADLINE_MS and is clamped to
   * it - a hosted completion may never cost more than the local one does. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export type HostedCompletionResult =
  | { ok: true; text: string; model?: string }
  | { ok: false; reason: HostedCompletionFailureReason; detail?: string };

/** Why the surface is switched off for the rest of the session, if it is.
 * `unauthorized` is in here because of the 403 ambiguity described at the top
 * of this file: tenant-quota-exhausted and plain-forbidden share that status
 * and that body, and neither is worth re-asking on every keystroke. */
export interface HostedCompletionDisabled {
  reason: Extract<
    HostedCompletionFailureReason,
    "unavailable" | "quota-exhausted" | "unauthorized"
  >;
  detail: string;
}

export interface HostedCompletionClient {
  /** One completion. Never rejects. */
  complete(req: HostedCompletionRequest): Promise<HostedCompletionResult>;
  /** null while the surface is usable; a reason once a 404/402/403 has closed
   * it for the session. Callers can skip the call entirely on a non-null
   * value. Re-reads the configured apiBase, so a caller that polls only this
   * (and stops calling complete() while it is non-null) still sees the sticky
   * state cleared by an environment switch. */
  disabled(): HostedCompletionDisabled | null;
  /** Forget sticky + cooldown state (new sign-in, manual retry). An apiBase
   * change resets this on its own. */
  reset(): void;
}

/** Read a body's `{ error }` / `{ message }` the way ApiError does, without
 * letting a non-JSON body throw. */
async function errorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? fallback;
  } catch {
    return fallback;
  }
}

/** Retry-After in whole seconds, clamped. HTTP-date form is deliberately not
 * parsed - callers fall back to the fixed window rather than guess. */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

interface Deadline {
  signal: AbortSignal;
  /** True once the timer (not the caller) fired the abort. */
  expired(): boolean;
  dispose(): void;
}

/** Caller signal + hard deadline, combined. Same shape as edge/completions.ts
 * withSoftDeadline, rewritten here rather than imported so that api/ keeps no
 * dependency on edge/ (the browser/IDE clients bundle them separately). */
function startDeadline(deadlineMs: number, caller: AbortSignal | undefined): Deadline {
  const controller = new AbortController();
  let expired = false;
  const onAbort = () => controller.abort();
  if (caller?.aborted) {
    controller.abort();
  } else {
    caller?.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineMs);
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

/** Sentinel for "the signal fired before this promise settled". */
const ABANDONED = Symbol("hosted-completion-abandoned");

/**
 * Await `work`, but give up the instant `signal` aborts.
 *
 * This is what makes the deadline a bound rather than a hope. Not every await
 * on the way to a completion is cancellable: TokenProvider.getToken/refresh
 * take no AbortSignal, and the refresh they delegate to
 * (clients/shared/src/auth/oidc.ts - its postForm passes no signal and sets
 * no timeout) can stay pending for as long as the auth server holds the
 * socket open. Racing the signal cannot cancel that work, so the abandoned
 * promise is left to settle on its own; its value is dropped and its
 * rejection is consumed here so it can never surface as an unhandled
 * rejection.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABANDONED> {
  if (signal.aborted) {
    void work.then(
      () => undefined,
      () => undefined
    );
    return Promise.resolve(ABANDONED);
  }
  return new Promise<T | typeof ABANDONED>((resolve, reject) => {
    const onAbort = () => resolve(ABANDONED);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/**
 * A hosted-completion client bound to whatever apiBase the settings currently
 * name (re-read per call, so an environment switch takes effect without a
 * reload - the same lazy-rebuild ApiFacade does) and to the host's existing
 * TokenProvider, so the 401-refresh-retry and API-key modes come for free
 * from VegadutaClient.
 */
export function createHostedCompletionClient(
  getApiBase: () => string,
  tokens: TokenProvider
): HostedCompletionClient {
  let cached: { apiBase: string; client: VegadutaClient } | null = null;
  let off: HostedCompletionDisabled | null = null;
  let cooldownUntil = 0;
  let cooldownReason: HostedCompletionFailureReason = "failed";

  function currentApiBase(): string {
    return (getApiBase() ?? "").trim();
  }

  /**
   * Point the client at `apiBase`, dropping every piece of per-deployment
   * state if that is a change: a different deployment is a different server,
   * so whatever the last one said about a missing endpoint or an exhausted
   * quota does not apply.
   *
   * disabled() calls this too, and has to: the sticky state's whole purpose
   * is to make callers STOP calling complete(), so a reset that only ran
   * inside complete() could never be reached once the state was set.
   */
  function syncEnvironment(apiBase: string): VegadutaClient | null {
    if (cached?.apiBase !== apiBase) {
      off = null;
      cooldownUntil = 0;
      cached = apiBase ? { apiBase, client: new VegadutaClient(apiBase, tokens) } : null;
    }
    return cached?.client ?? null;
  }

  function coolDown(reason: HostedCompletionFailureReason, ms: number): void {
    cooldownReason = reason;
    cooldownUntil = Date.now() + ms;
  }

  /** Close the surface for the session and report that same reason. */
  function shutDown(
    reason: HostedCompletionDisabled["reason"],
    detail: string
  ): HostedCompletionResult {
    off = { reason, detail };
    return { ok: false, reason, detail };
  }

  return {
    disabled(): HostedCompletionDisabled | null {
      syncEnvironment(currentApiBase());
      return off;
    },

    reset(): void {
      off = null;
      cooldownUntil = 0;
      cached = null;
    },

    async complete(req: HostedCompletionRequest): Promise<HostedCompletionResult> {
      // Arm the deadline BEFORE anything that can await, and abandon the call
      // the moment it fires. Everything below - the credential lookup most of
      // all - is inside the budget, not alongside it.
      const deadline = startDeadline(
        Math.max(
          1,
          Math.min(req.deadlineMs ?? DEFAULT_HOSTED_DEADLINE_MS, DEFAULT_HOSTED_DEADLINE_MS)
        ),
        req.signal
      );
      try {
        if (req.signal?.aborted) {
          return { ok: false, reason: "aborted", detail: "caller aborted" };
        }

        const apiBase = currentApiBase();
        // Resolve the client FIRST: an environment switch clears the sticky
        // state in here, and the `off` guard below must see the cleared value
        // (otherwise a 404 from the old deployment would be permanent).
        const client = syncEnvironment(apiBase);
        if (!client) {
          return { ok: false, reason: "unavailable", detail: "no API base configured" };
        }

        if (off) return { ok: false, reason: off.reason, detail: off.detail };
        if (Date.now() < cooldownUntil) {
          return { ok: false, reason: cooldownReason, detail: "backing off" };
        }
        const prefix = req.prefix ?? "";
        if (!prefix.trim()) return { ok: false, reason: "empty-reply", detail: "empty prefix" };

        // Check for a credential before spending a round trip: a signed-out
        // editor would otherwise fire one guaranteed 401 per keystroke.
        const token = await raceAbort(
          (async () => {
            try {
              return await tokens.getToken();
            } catch {
              return null;
            }
          })(),
          deadline.signal
        );
        if (token === ABANDONED) {
          return deadline.expired()
            ? {
                ok: false,
                reason: "timeout",
                detail: "credential lookup exceeded the hosted completion deadline",
              }
            : { ok: false, reason: "aborted", detail: "caller aborted" };
        }
        if (!token) {
          // Back off here too. Without this, the one failure that cooled down
          // nothing was also the cheapest one to get stuck in: TokenManager
          // returns null both for "signed out" and for "expired token, auth
          // server unreachable" (its refresh() keeps the tokens and returns
          // null on a transient network failure), so a keystroke loop would
          // start an unbounded refresh POST per typing pause, forever.
          coolDown("unauthorized", AUTH_COOLDOWN_MS);
          return { ok: false, reason: "unauthorized", detail: "not signed in" };
        }

        // Raced as well as signal-wired: fetch honours deadline.signal, but
        // VegadutaClient.request awaits getToken() again and, after a 401,
        // refresh() - neither of which takes a signal.
        const response = await raceAbort(
          client.request(FIM_PATH, {
            method: "POST",
            body: {
              prefix,
              suffix: req.suffix ?? "",
              language: req.language ?? "",
              maxTokens: req.maxTokens ?? DEFAULT_HOSTED_MAX_TOKENS,
            },
            signal: deadline.signal,
          }),
          deadline.signal
        );
        if (response === ABANDONED) {
          return deadline.expired()
            ? { ok: false, reason: "timeout", detail: "hosted completion deadline exceeded" }
            : { ok: false, reason: "aborted", detail: "caller aborted" };
        }

        if (response.status === 404) {
          return shutDown("unavailable", `no ${FIM_PATH} on ${apiBase}`);
        }
        if (response.status === 402) {
          return shutDown(
            "quota-exhausted",
            await errorDetail(response, "hosted completion budget exhausted")
          );
        }
        if (response.status === 403) {
          // Either the tenant's plan quota (TenantLimitExceededException,
          // which GlobalExceptionHandler renders as 403, not 402) or a plain
          // authorization refusal. Same status, same body shape, no `code` to
          // separate them, and neither becomes true again sixty seconds later
          // - so stop for the session and hand back the server's own wording.
          return shutDown("unauthorized", await errorDetail(response, "HTTP 403"));
        }
        if (response.status === 429) {
          coolDown("rate-limited", retryAfterMs(response) ?? RATE_LIMIT_COOLDOWN_MS);
          return { ok: false, reason: "rate-limited", detail: "rate limited" };
        }
        if (response.status === 401) {
          // VegadutaClient already retried once after a refresh, so this is a
          // real "this credential can't do that" - back off, but stay
          // recoverable: the user may sign in again mid-session.
          coolDown("unauthorized", AUTH_COOLDOWN_MS);
          return { ok: false, reason: "unauthorized", detail: "HTTP 401" };
        }
        if (response.status === 503) {
          coolDown("unavailable", retryAfterMs(response) ?? UNAVAILABLE_COOLDOWN_MS);
          return {
            ok: false,
            reason: "unavailable",
            detail: await errorDetail(response, "HTTP 503"),
          };
        }
        if (!response.ok) {
          coolDown("failed", ERROR_COOLDOWN_MS);
          return {
            ok: false,
            reason: "failed",
            detail: await errorDetail(response, `HTTP ${response.status}`),
          };
        }

        const body = (await response.json()) as { completion?: unknown; model?: unknown };
        const text = typeof body?.completion === "string" ? body.completion : "";
        // An empty completion is the server's documented "no suggestion"
        // answer, not a failure: no cooldown, nothing reported, show nothing.
        if (!text) return { ok: false, reason: "empty-reply" };
        return {
          ok: true,
          text,
          model: typeof body?.model === "string" ? body.model : undefined,
        };
      } catch (err) {
        // Order matters: the deadline aborts through the same signal the
        // caller does, so ask the timer first.
        if (deadline.expired()) {
          return { ok: false, reason: "timeout", detail: "hosted completion deadline exceeded" };
        }
        if (req.signal?.aborted) {
          return { ok: false, reason: "aborted", detail: "caller aborted" };
        }
        coolDown("failed", ERROR_COOLDOWN_MS);
        return {
          ok: false,
          reason: "failed",
          detail: err instanceof Error ? err.message : String(err),
        };
      } finally {
        deadline.dispose();
      }
    },
  };
}
