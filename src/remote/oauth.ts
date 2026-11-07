/**
 * The OAuth authorization server for remote mode (on when DATA_ANALYST_ACCOUNTS=1): what lets a claude.ai custom
 * connector sign in, so each user's own API keys can be stored on this server and used for their tool calls.
 *
 * - dynamic client registration (claude.ai registers itself), PKCE authorization codes (S256, checked by the
 *   SDK's token handler), access tokens (1 hour) and rotating refresh tokens (30 days);
 * - the consent page creates an account, or reconnects one with the account code shown when it was created;
 * - an account is only a key ring: it has no profile, email or password.
 */
import crypto from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { consentPage } from "./pages.js";
import { sign } from "./sign.js";
import * as store from "./store.js";

const ACCESS_S = 3600;
const REFRESH_S = 30 * 86400;
const CODE_S = 600;
const token = () => crypto.randomBytes(32).toString("base64url");

const clientsStore: OAuthRegisteredClientsStore = {
  getClient: (id) => store.getClient(id),
  registerClient: (c) => {
    const full: OAuthClientInformationFull = { ...c, client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(c.token_endpoint_auth_method && c.token_endpoint_auth_method !== "none" ? { client_secret: token() } : {}) };
    store.putClient(full);
    return full;
  },
};

/** The consent form posts this signed blob back to /oauth/consent, so the request cannot be altered. */
export type PendingAuth = { k: "consent"; client: string; redirect: string; state?: string; challenge: string;
  scopes?: string[]; resource?: string };

/** Issue the authorization code and the redirect URL, after the user consented as `account`. */
export function grantCode(p: PendingAuth, account: string): string {
  const code = token();
  store.putGrant(code, { kind: "code", client: p.client, account, exp: Date.now() / 1000 + CODE_S, challenge: p.challenge,
    redirect: p.redirect, scopes: p.scopes, resource: p.resource });
  const u = new URL(p.redirect);
  u.searchParams.set("code", code);
  if (p.state) u.searchParams.set("state", p.state);
  return u.toString();
}

function issue(client: string, account: string, scopes?: string[], resource?: string): OAuthTokens {
  const access = token(), refresh = token();
  const now = Date.now() / 1000;
  store.putGrant(access, { kind: "access", client, account, exp: now + ACCESS_S, scopes, resource });
  store.putGrant(refresh, { kind: "refresh", client, account, exp: now + REFRESH_S, scopes, resource });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_S, refresh_token: refresh,
    ...(scopes?.length ? { scope: scopes.join(" ") } : {}) };
}

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending = sign({ k: "consent", client: client.client_id, redirect: params.redirectUri, state: params.state,
      challenge: params.codeChallenge, scopes: params.scopes, resource: params.resource?.toString() }, CODE_S);
    res.status(200).type("html").send(consentPage(client.client_name || "An assistant", pending));
  },

  async challengeForAuthorizationCode(_client, code): Promise<string> {
    const g = store.getGrant(code, "code");
    if (!g) throw new InvalidGrantError("unknown or expired authorization code");
    return g.challenge!;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri): Promise<OAuthTokens> {
    const g = store.getGrant(code, "code");
    if (!g || g.client !== client.client_id) throw new InvalidGrantError("unknown or expired authorization code");
    if (redirectUri && g.redirect !== redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    store.dropGrant(code);
    return issue(client.client_id, g.account, g.scopes, g.resource);
  },

  async exchangeRefreshToken(client, refresh, scopes): Promise<OAuthTokens> {
    const g = store.getGrant(refresh, "refresh");
    if (!g || g.client !== client.client_id) throw new InvalidGrantError("unknown or expired refresh token");
    store.dropGrant(refresh);
    return issue(client.client_id, g.account, scopes?.length ? scopes : g.scopes, g.resource);
  },

  async verifyAccessToken(t: string): Promise<AuthInfo> {
    const g = store.getGrant(t, "access");
    if (!g || !store.accountExists(g.account)) throw new InvalidTokenError("invalid or expired access token");
    return { token: t, clientId: g.client, scopes: g.scopes || [], expiresAt: Math.floor(g.exp),
      ...(g.resource ? { resource: new URL(g.resource) } : {}), extra: { account: g.account } };
  },

  async revokeToken(_client, req): Promise<void> {
    store.dropGrant(req.token);
  },
};
