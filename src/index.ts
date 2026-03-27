import "server-only";
import { randomUUID } from "node:crypto";
import {
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  refreshTokenGrant,
  randomState,
  randomNonce,
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
} from "openid-client";
import { NextResponse } from "next/server";

// ─── Public interfaces ────────────────────────────────────────────────────────

/** Generic TTL-bounded key-value store. A single implementation (e.g. Redis)
 *  can satisfy both SessionStore and the internal PKCE store. */
export interface KVStore<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Data stored server-side per session. Never sent to the client. */
export interface SessionData {
  sub: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  accessToken: string;
  refreshToken?: string;
  /** Unix timestamp in milliseconds when the access token expires. */
  accessTokenExpiresAt: number;
  idToken?: string;
}

/** Configuration required to initialise a Cognito OIDC auth handler. */
export interface CognitoAuthConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  sessionStore: KVStore<SessionData>;
  /**
   * Optional separate store for PKCE state. Defaults to an in-memory
   * globalThis-backed store. Supply the same store as `sessionStore` (or a
   * shared Redis client) to make PKCE state durable across instances.
   */
  pkceStore?: KVStore<PkceEntry>;
  /** Cookie name. Defaults to "fd_session". */
  cookieName?: string;
  /** Session TTL in seconds. Defaults to 8 hours. */
  sessionTtlSeconds?: number;
  /** PKCE state TTL in seconds. Defaults to 10 minutes. */
  pkceTtlSeconds?: number;
  /**
   * Path to redirect to after a successful sign-in. Defaults to "/".
   */
  signInRedirectPath?: string;
  /**
   * Cognito hosted UI domain (e.g. "my-app.auth.us-east-1.amazoncognito.com").
   * When set, signing out will redirect to Cognito's logout endpoint so the
   * Cognito SSO session is also terminated.
   */
  cognitoDomain?: string;
  /**
   * URI to redirect to after Cognito logout. Must be registered in the
   * Cognito app client's allowed sign-out URLs.
   * Defaults to "${appUrl}/auth/signin".
   */
  logoutUri?: string;
  /**
   * Enable debug logging to stdout. Each step of the sign-in/sign-out flow
   * emits a `[oidc-auth]` prefixed log line so you can pinpoint exactly where
   * a hang or error occurs.
   *
   * Can also be enabled at runtime by setting the `OIDC_DEBUG=1` environment
   * variable without changing code.
   *
   * Defaults to `false`.
   */
  debug?: boolean;
}

export interface SessionCookie {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  path: string;
  maxAge: number;
  secure: boolean;
}

// ─── Internal types ───────────────────────────────────────────────────────────

export interface PkceEntry {
  codeVerifier: string;
  nonce: string;
}

// ─── globalThis declarations ──────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __cgOidcKV: Map<string, MemEntry<unknown>> | undefined;
}

// Module-level cache for the OIDC Configuration instance. Intentionally NOT
// on globalThis: after Next.js HMR the openid-client module is re-evaluated,
// producing a new Configuration class. The old globalThis instance would then
// fail instanceof checks inside buildAuthorizationUrl. A module-level variable
// is cleared on each HMR reload, forcing a fresh discovery() call.
let _oidcConfig: Awaited<ReturnType<typeof discovery>> | null = null;

// ─── Default in-memory KV store (globalThis-backed for Next.js HMR safety) ───

type MemEntry<T> = { value: T; expiresAt: number };

function getGlobalMap(): Map<string, MemEntry<unknown>> {
  if (!globalThis.__cgOidcKV) {
    globalThis.__cgOidcKV = new Map();
  }
  return globalThis.__cgOidcKV;
}

function makeMemoryKVStore<T>(): KVStore<T> {
  const map = getGlobalMap();
  return {
    async get(key) {
      const entry = map.get(key) as MemEntry<T> | undefined;
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createCognitoAuth(config: CognitoAuthConfig) {
  const {
    region,
    userPoolId,
    clientId,
    clientSecret,
    appUrl,
    sessionStore,
    cookieName = "fd_session",
    sessionTtlSeconds = 8 * 60 * 60,
    pkceTtlSeconds = 10 * 60,
    signInRedirectPath = "/",
    cognitoDomain,
    logoutUri,
  } = config;

  const debugEnabled = config.debug ?? process.env.OIDC_DEBUG === "1";
  const log = debugEnabled
    ? (msg: string, ...args: unknown[]) => console.log(`[oidc-auth] ${msg}`, ...args)
    : () => {};

  const pkceStore: KVStore<PkceEntry> = config.pkceStore ?? makeMemoryKVStore<PkceEntry>();

  const redirectUri = `${appUrl}/api/auth/callback`;

  const issuerUrl = new URL(
    `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`
  );

  // Lazy-cached OIDC discovery. Uses a module-level variable (not globalThis)
  // so that HMR reloads always produce a fresh Configuration instance.
  async function getOidcConfig() {
    if (!_oidcConfig) {
      log("discovery: fetching OIDC config from %s", issuerUrl.toString());
      _oidcConfig = await discovery(issuerUrl, clientId, clientSecret);
      log("discovery: complete");
    }
    return _oidcConfig;
  }

  // ─── Core auth functions ────────────────────────────────────────────────

  async function beginSignIn(): Promise<URL> {
    log("beginSignIn: start");
    const oidcConfig = await getOidcConfig();
    const state = randomState();
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

    log("beginSignIn: storing PKCE state=%s", state);
    await pkceStore.set(`pkce:${state}`, { codeVerifier, nonce }, pkceTtlSeconds);
    log("beginSignIn: PKCE stored");

    const authUrl = buildAuthorizationUrl(oidcConfig, {
      redirect_uri: redirectUri,
      scope: "openid email",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    log("beginSignIn: redirecting to %s", authUrl.toString());
    return authUrl;
  }

  async function completeSignIn(callbackUrl: URL): Promise<{ cookie: SessionCookie }> {
    const state = callbackUrl.searchParams.get("state") ?? "";
    log("completeSignIn: start, state=%s", state);

    log("completeSignIn: looking up PKCE state");
    const pending = await pkceStore.get(`pkce:${state}`);
    log("completeSignIn: PKCE lookup done, found=%s", !!pending);
    if (!pending) throw new Error("Invalid or expired OAuth state");
    await pkceStore.delete(`pkce:${state}`);

    // Reconstruct the callback URL using the configured appUrl origin so that
    // openid-client derives the correct redirect_uri for the token exchange,
    // regardless of the internal hostname/port seen by the Next.js server.
    const appOrigin = new URL(appUrl).origin;
    const canonicalCallbackUrl = new URL(callbackUrl.pathname + callbackUrl.search, appOrigin);
    log("completeSignIn: canonical callback URL: %s", canonicalCallbackUrl.toString());

    log("completeSignIn: fetching OIDC config");
    const oidcConfig = await getOidcConfig();
    log("completeSignIn: starting token exchange");
    const tokens = await authorizationCodeGrant(oidcConfig, canonicalCallbackUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: state,
      expectedNonce: pending.nonce,
    });

    const claims = tokens.claims();
    if (!claims) throw new Error("No ID token claims in token response");
    log("completeSignIn: token exchange complete, sub=%s", claims.sub);

    const sessionData: SessionData = {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      givenName: typeof claims.given_name === "string" ? claims.given_name : undefined,
      familyName: typeof claims.family_name === "string" ? claims.family_name : undefined,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      idToken: tokens.id_token,
    };

    const sessionId = randomUUID();
    log("completeSignIn: storing session id=%s", sessionId);
    await sessionStore.set(sessionId, sessionData, sessionTtlSeconds);
    log("completeSignIn: session stored");

    return {
      cookie: {
        name: cookieName,
        value: sessionId,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: sessionTtlSeconds,
        secure: process.env.NODE_ENV === "production",
      },
    };
  }

  async function getSession(headers: Headers): Promise<SessionData | null> {
    const sessionId = parseCookieHeader(headers.get("cookie") ?? "", cookieName);
    if (!sessionId) return null;

    const data = await sessionStore.get(sessionId);
    if (!data) return null;

    // Auto-refresh when within 5 minutes of expiry
    if (data.refreshToken && Date.now() > data.accessTokenExpiresAt - 5 * 60 * 1000) {
      log("getSession: access token near expiry, refreshing for sub=%s", data.sub);
      try {
        const oidcConfig = await getOidcConfig();
        const tokens = await refreshTokenGrant(oidcConfig, data.refreshToken);
        const refreshed: SessionData = {
          ...data,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? data.refreshToken,
          accessTokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        };
        await sessionStore.set(sessionId, refreshed, sessionTtlSeconds);
        log("getSession: token refresh complete");
        return refreshed;
      } catch (err) {
        log("getSession: token refresh failed: %s", String(err));
        // Refresh failed — return stale session; will retry on next request
      }
    }

    return data;
  }

  async function deleteSession(headers: Headers): Promise<string> {
    const sessionId = parseCookieHeader(headers.get("cookie") ?? "", cookieName);
    if (sessionId) await sessionStore.delete(sessionId);
    return clearSessionCookie(cookieName);
  }

  // ─── Next.js App Router handlers ───────────────────────────────────────

  type Ctx = { params: Promise<{ path: string[] }> };

  async function GET(request: Request, { params }: Ctx): Promise<Response> {
    const [segment] = (await params).path;
    log("GET /api/auth/%s", segment);

    switch (segment) {
      case "signin": {
        try {
          return NextResponse.redirect(await beginSignIn());
        } catch (err) {
          console.error("[oidc-auth] signin error:", err);
          return NextResponse.redirect(`${appUrl}/auth/signin?error=auth_failed`);
        }
      }
      case "callback": {
        try {
          const { cookie } = await completeSignIn(new URL(request.url));
          const dest = new URL(signInRedirectPath, appUrl);
          log("completeSignIn: redirecting to %s", dest.toString());
          const res = NextResponse.redirect(dest);
          res.cookies.set(cookie);
          return res;
        } catch (err) {
          console.error("[oidc-auth] callback error:", err);
          const dest = new URL("/auth/signin", appUrl);
          dest.searchParams.set("error", "auth_failed");
          return NextResponse.redirect(dest);
        }
      }
      case "session": {
        const session = await getSession(request.headers);
        if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { sub, email, givenName, familyName } = session;
        return Response.json({ sub, email, givenName, familyName });
      }
      case "signout": {
        log("signout: clearing session");
        const clearCookie = await deleteSession(request.headers);
        const postLogoutRedirect = logoutUri ?? `${appUrl}/auth/signin`;
        let dest: string;
        if (cognitoDomain) {
          const url = new URL(`https://${cognitoDomain}/logout`);
          url.searchParams.set("client_id", clientId);
          url.searchParams.set("logout_uri", postLogoutRedirect);
          dest = url.toString();
        } else {
          dest = postLogoutRedirect;
        }
        log("signout: redirecting to %s", dest);
        return NextResponse.redirect(dest, {
          status: 302,
          headers: { "Set-Cookie": clearCookie },
        });
      }
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  async function POST(request: Request, { params }: Ctx): Promise<Response> {
    const [segment] = (await params).path;
    if (segment !== "signout") return new Response("Not Found", { status: 404 });
    const cookieHeader = await deleteSession(request.headers);
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookieHeader } });
  }

  return { GET, POST, getSession, deleteSession };
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function clearSessionCookie(name: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function parseCookieHeader(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
