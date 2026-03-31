const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

function serializeCookie(cookie) {
  const parts = [`${cookie.name}=${cookie.value}`];
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
  if (cookie.path) parts.push(`Path=${cookie.path}`);
  if (typeof cookie.maxAge === "number") parts.push(`Max-Age=${cookie.maxAge}`);
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
  if (cookie.secure) parts.push("Secure");
  return parts.join("; ");
}

function loadAuthModule() {
  const nextServerMock = {
    NextResponse: {
      redirect(url, init = {}) {
        const headers = new Headers(init.headers);
        headers.set("Location", String(url));
        const response = new Response(null, { status: init.status ?? 307, headers });
        response.cookies = {
          set(cookie) {
            response.cookie = cookie;
            headers.append("Set-Cookie", serializeCookie(cookie));
          },
        };
        return response;
      },
    },
  };

  const openIdClientMock = {
    discovery: async () => ({ issuer: "https://example.com" }),
    buildAuthorizationUrl: () => new URL("https://example.com/signin"),
    authorizationCodeGrant: async () => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      id_token: "id-token",
      claims() {
        return {
          sub: "user-123",
          email: "user@example.com",
          given_name: "Test",
          family_name: "User",
        };
      },
    }),
    refreshTokenGrant: async () => {
      throw new Error("refresh should not be called in cookie tests");
    },
    randomState: () => "state",
    randomNonce: () => "nonce",
    randomPKCECodeVerifier: () => "verifier",
    calculatePKCECodeChallenge: async () => "challenge",
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "next/server") return nextServerMock;
    if (request === "openid-client") return openIdClientMock;
    if (request === "server-only") return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../dist/index.js");
  delete require.cache[modulePath];

  try {
    return require("../dist/index.js");
  } finally {
    Module._load = originalLoad;
  }
}

function createStores() {
  const sessionEntries = new Map();
  const pkceEntries = new Map([
    ["pkce:test-state", { codeVerifier: "verifier", nonce: "nonce" }],
  ]);

  return {
    sessionStore: {
      async get(key) {
        return sessionEntries.get(key) ?? null;
      },
      async set(key, value) {
        sessionEntries.set(key, value);
      },
      async delete(key) {
        sessionEntries.delete(key);
      },
    },
    pkceStore: {
      async get(key) {
        return pkceEntries.get(key) ?? null;
      },
      async set(key, value) {
        pkceEntries.set(key, value);
      },
      async delete(key) {
        pkceEntries.delete(key);
      },
    },
  };
}

async function completeSignIn(overrides = {}) {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";

  const { createCognitoAuth } = loadAuthModule();
  const { sessionStore, pkceStore } = createStores();
  const auth = createCognitoAuth({
    region: "us-east-1",
    userPoolId: "us-east-1_abc123",
    clientId: "client-id",
    clientSecret: "client-secret",
    appUrl: "https://competition.example.com",
    sessionStore,
    pkceStore,
    ...overrides,
  });

  try {
    return await auth.GET(
      new Request("https://competition.example.com/api/auth/callback?state=test-state&code=auth-code"),
      { params: Promise.resolve({ path: ["callback"] }) }
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

test("default sign-in cookie remains host-only with existing defaults", async () => {
  const response = await completeSignIn();

  assert.equal(response.cookie.name, "fd_session");
  assert.equal(response.cookie.path, "/");
  assert.equal(response.cookie.sameSite, "lax");
  assert.equal(response.cookie.secure, false);
  assert.equal(response.cookie.domain, undefined);
});

test("configured cookie domain is included in the sign-in cookie", async () => {
  const response = await completeSignIn({
    cookieDomain: ".example.com",
    cookiePath: "/",
    cookieSameSite: "none",
    cookieSecure: true,
  });

  assert.equal(response.cookie.domain, ".example.com");
  assert.equal(response.cookie.path, "/");
  assert.equal(response.cookie.sameSite, "none");
  assert.equal(response.cookie.secure, true);
});

test("configured cookie domain is included when clearing the session cookie", async () => {
  const { createCognitoAuth } = loadAuthModule();
  const { sessionStore } = createStores();
  const auth = createCognitoAuth({
    region: "us-east-1",
    userPoolId: "us-east-1_abc123",
    clientId: "client-id",
    clientSecret: "client-secret",
    appUrl: "https://competition.example.com",
    sessionStore,
    cookieName: "shared_session",
    cookieDomain: ".example.com",
    cookiePath: "/",
    cookieSameSite: "none",
    cookieSecure: true,
  });

  const header = await auth.deleteSession(
    new Headers({ cookie: "shared_session=session-id-123" })
  );

  assert.match(header, /shared_session=;/);
  assert.match(header, /Path=\//);
  assert.match(header, /SameSite=None/);
  assert.match(header, /Domain=\.example\.com/);
  assert.match(header, /Secure/);
  assert.match(header, /Max-Age=0/);
});