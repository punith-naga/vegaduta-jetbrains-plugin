// OAuth 2.0 Device Authorization Grant (RFC 8628) against Keycloak - the
// primary sign-in for VS Code and JetBrains (no redirect URI, so it works
// under Remote-SSH/WSL and needs no loopback port; Keycloak 25 can't do
// wildcard loopback ports anyway). Same UX as `gh auth login`:
//   1. startDeviceFlow() -> show userCode, open verificationUriComplete
//   2. pollForTokens() -> resolves once the user approves in the browser.

import { IDE_CLIENT_ID } from "../api/types";
import { OIDC_SCOPE, OidcError, oidcEndpoints, tokenRequest, type TokenSet, RATE_LIMITED } from "./oidc";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** URI with the code pre-filled - open this one in the system browser. */
  verificationUriComplete: string;
  /** Poll interval in ms (server-directed, default 5s). */
  intervalMs: number;
  /** Epoch ms when the device code expires. */
  expiresAt: number;
}

export async function startDeviceFlow(
  authBase: string,
  clientId: string = IDE_CLIENT_ID
): Promise<DeviceAuthorization> {
  const response = await fetch(oidcEndpoints(authBase).device, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: OIDC_SCOPE }).toString(),
  });
  const json = (await response.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.device_code || !json.user_code) {
    throw new OidcError(
      json.error ?? String(response.status),
      json.error_description ??
        "Could not start device sign-in. Check that the agentic-ai-ide client exists on this Keycloak (see docs/IDE-PLUGIN-PLATFORM-CONTRACT)."
    );
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri ?? "",
    verificationUriComplete: json.verification_uri_complete ?? json.verification_uri ?? "",
    intervalMs: (json.interval ?? 5) * 1000,
    expiresAt: Date.now() + (json.expires_in ?? 600) * 1000,
  };
}

/** Polls the token endpoint until approval, denial, expiry, or abort.
 * Honors RFC 8628 `authorization_pending` / `slow_down` responses. */
/** Longest wait between polls after the server has asked us to slow down. */
const MAX_POLL_INTERVAL_MS = 60_000;

export async function pollForTokens(
  authBase: string,
  authorization: DeviceAuthorization,
  options: { signal?: AbortSignal; clientId?: string } = {}
): Promise<TokenSet> {
  let intervalMs = authorization.intervalMs;
  for (;;) {
    if (options.signal?.aborted) {
      throw new OidcError("aborted", "Sign-in was cancelled.");
    }
    if (Date.now() > authorization.expiresAt) {
      throw new OidcError("expired_token", "The sign-in code expired. Please start again.");
    }
    await sleep(intervalMs, options.signal);
    try {
      return await tokenRequest(oidcEndpoints(authBase).token, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: options.clientId ?? IDE_CLIENT_ID,
        device_code: authorization.deviceCode,
      });
    } catch (err) {
      if (err instanceof OidcError) {
        if (err.code === "authorization_pending") {
          continue;
        }
        if (err.code === "slow_down") {
          intervalMs = Math.min(MAX_POLL_INTERVAL_MS, intervalMs + 5000);
          continue;
        }
        // A 429 from the rate-limiting edge is the same request as slow_down.
        // Found 2026-09-18: Cloudflare in front of auth.vegaduta.ai 429s
        // repeated token polls and, if they continue, BANS THE IP (error 1015)
        // - including the browser page the person is approving the code on.
        // So back off hard (Retry-After, else max(+5s, x2), capped) and keep
        // waiting until the code expires, rather than failing the sign-in or
        // hammering the edge into a ban.
        if (err.code === RATE_LIMITED) {
          intervalMs = Math.min(
            MAX_POLL_INTERVAL_MS,
            err.retryAfterMs ?? Math.max(intervalMs + 5000, intervalMs * 2)
          );
          continue;
        }
      }
      throw err;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OidcError("aborted", "Sign-in was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
