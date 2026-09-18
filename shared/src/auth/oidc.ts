// Keycloak OIDC endpoints + token exchange for the `agentic-ai-ide` public
// client (deploy/keycloak/agentic-ai-realm.json). Two flows share this file:
//  - Device Authorization Grant (VS Code / JetBrains) - see deviceFlow.ts
//  - Auth-code + PKCE via chrome.identity (Chrome) - buildAuthUrl/exchangeCode
// Scope always includes offline_access: realm SSO idle is 4h, which would
// force a re-login every morning; offline tokens idle out at 30 days.

import { IDE_CLIENT_ID, KEYCLOAK_REALM } from "../api/types";

export const OIDC_SCOPE = "openid offline_access";

export interface OidcEndpoints {
  device: string;
  token: string;
  auth: string;
  logout: string;
}

export function oidcEndpoints(authBase: string, realm: string = KEYCLOAK_REALM): OidcEndpoints {
  const base = `${authBase.replace(/\/$/, "")}/realms/${realm}/protocol/openid-connect`;
  return {
    device: `${base}/auth/device`,
    token: `${base}/token`,
    auth: `${base}/auth`,
    logout: `${base}/logout`,
  };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms when the access token expires (with a 30s safety margin). */
  expiresAt: number;
}

export interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

function toTokenSet(json: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}): TokenSet {
  const lifetimeMs = Math.max(0, ((json.expires_in ?? 60) - 30) * 1000);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + lifetimeMs,
  };
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

/** OidcError.code for an HTTP 429 from the token endpoint. */
export const RATE_LIMITED = "rate_limited";

export class OidcError extends Error {
  constructor(
    public readonly code: string,
    description: string,
    /** Set on HTTP 429: the server's Retry-After in ms, when it sent one. */
    public readonly retryAfterMs?: number
  ) {
    super(description);
    this.name = "OidcError";
  }
}

async function tokenRequest(
  tokenUrl: string,
  form: Record<string, string>
): Promise<TokenSet> {
  const response = await postForm(tokenUrl, form);
  const json = (await response.json().catch(() => ({}))) as TokenErrorBody & {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !json.access_token) {
    // HTTP 429 is its own code: auth.vegaduta.ai is behind Cloudflare, whose
    // rate limiting answers with an HTML page (no OAuth error body), and the
    // device-flow poller must be able to tell "slow down" from "failed".
    if (response.status === 429) {
      const retryAfterSec = Number(response.headers.get("retry-after"));
      throw new OidcError(
        RATE_LIMITED,
        "The sign-in server is rate-limiting requests from this network.",
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined
      );
    }
    throw new OidcError(
      json.error ?? String(response.status),
      json.error_description ?? json.error ?? `Token request failed (${response.status})`
    );
  }
  return toTokenSet(json as { access_token: string; refresh_token?: string; expires_in?: number });
}

/** Auth-code flow step 1 (Chrome): the URL to open in launchWebAuthFlow. */
export function buildAuthUrl(params: {
  authBase: string;
  redirectUri: string;
  state: string;
  pkceChallenge: string;
  clientId?: string;
}): string {
  const endpoints = oidcEndpoints(params.authBase);
  const url = new URL(endpoints.auth);
  url.searchParams.set("client_id", params.clientId ?? IDE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", OIDC_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Auth-code flow step 2 (Chrome): exchange the code for tokens. */
export function exchangeCode(params: {
  authBase: string;
  code: string;
  redirectUri: string;
  pkceVerifier: string;
  clientId?: string;
}): Promise<TokenSet> {
  return tokenRequest(oidcEndpoints(params.authBase).token, {
    grant_type: "authorization_code",
    client_id: params.clientId ?? IDE_CLIENT_ID,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.pkceVerifier,
  });
}

/** Shared by both flows: refresh an expired access token. */
export function refreshTokens(params: {
  authBase: string;
  refreshToken: string;
  clientId?: string;
}): Promise<TokenSet> {
  return tokenRequest(oidcEndpoints(params.authBase).token, {
    grant_type: "refresh_token",
    client_id: params.clientId ?? IDE_CLIENT_ID,
    refresh_token: params.refreshToken,
  });
}

export { tokenRequest };
