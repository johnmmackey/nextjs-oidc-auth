# @johnmmackey/nextjs-oidc-auth

Cognito OIDC authentication for Next.js App Router. Provides a plug-and-play route handler factory covering the full sign-in / sign-out / session lifecycle using PKCE + nonce via [`openid-client`](https://github.com/panva/node-openid-client).

## Features

- PKCE + nonce sign-in via the Cognito hosted UI
- Server-side sessions stored in any `KVStore` implementation (Redis, DynamoDB, etc.)
- Automatic access-token refresh when within 5 minutes of expiry
- Optional Cognito SSO logout (clears both the app session and the Cognito session)
- Built-in in-memory store for local development (safe across Next.js HMR reloads)
- Debug logging via `debug: true` or `OIDC_DEBUG=1`

## Requirements

- Next.js ≥ 15 (App Router)
- `server-only` package

## Installation

```bash
npm install @johnmmackey/nextjs-oidc-auth
```

## Setup

### 1. Create the catch-all API route

Create `app/api/auth/[...path]/route.ts`:

```ts
import { createCognitoAuth } from "@johnmmackey/nextjs-oidc-auth";

const { GET, POST } = createCognitoAuth({
  region: process.env.AWS_REGION!,
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  clientId: process.env.COGNITO_CLIENT_ID!,
  clientSecret: process.env.COGNITO_CLIENT_SECRET!,
  appUrl: process.env.APP_URL!,            // e.g. "https://myapp.example.com"
  sessionStore: myRedisSessionStore,       // see KVStore section below
});

export { GET, POST };
```

This single route handles all of the following paths automatically:

| Path | Description |
|---|---|
| `GET /api/auth/signin` | Starts the OIDC flow — redirects to Cognito |
| `GET /api/auth/callback` | Handles the authorization code callback, sets session cookie |
| `GET /api/auth/session` | Returns `{ sub, email, givenName, familyName }` for the current session (401 if unauthenticated) |
| `GET /api/auth/signout` | Clears the session cookie and redirects (to Cognito logout if `cognitoDomain` is set) |
| `POST /api/auth/signout` | Clears the session cookie (204 No Content) — useful for client-side sign-out |

### 2. Register the callback URL in Cognito

Add `https://<your-app-url>/api/auth/callback` to the **Allowed callback URLs** in your Cognito app client.

### 3. Protect server components / route handlers

Use `getSession` in any Server Component or Route Handler:

```ts
import { createCognitoAuth } from "@johnmmackey/nextjs-oidc-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

const { getSession } = createCognitoAuth({ /* same config */ });

export default async function ProtectedPage() {
  const session = await getSession(await headers());
  if (!session) redirect("/auth/signin");

  return <div>Hello, {session.givenName}!</div>;
}
```

`getSession` returns a `SessionData` object or `null`:

```ts
interface SessionData {
  sub: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: number; // Unix ms
  idToken?: string;
}
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `region` | `string` | **required** | AWS region of the Cognito User Pool |
| `userPoolId` | `string` | **required** | Cognito User Pool ID |
| `clientId` | `string` | **required** | Cognito app client ID |
| `clientSecret` | `string` | **required** | Cognito app client secret |
| `appUrl` | `string` | **required** | Public base URL of the app (no trailing slash) |
| `sessionStore` | `KVStore<SessionData>` | **required** | Server-side session storage |
| `pkceStore` | `KVStore<PkceEntry>` | in-memory | Storage for PKCE state during the auth flow |
| `cookieName` | `string` | `"fd_session"` | Name of the session cookie |
| `cookieDomain` | `string` | host-only | Cookie domain scope. Set to a parent domain such as `".example.com"` to share a session across subdomains |
| `cookiePath` | `string` | `"/"` | Cookie path scope |
| `cookieSameSite` | `"lax" \| "strict" \| "none"` | `"lax"` | SameSite attribute for the session cookie |
| `cookieSecure` | `boolean` | `NODE_ENV === "production"` | Secure attribute for the session cookie |
| `sessionTtlSeconds` | `number` | `28800` (8 h) | Session lifetime in seconds |
| `pkceTtlSeconds` | `number` | `600` (10 min) | PKCE state lifetime in seconds |
| `signInRedirectPath` | `string` | `"/"` | Where to redirect after successful sign-in |
| `cognitoDomain` | `string` | — | Cognito hosted UI domain (e.g. `my-app.auth.us-east-1.amazoncognito.com`). When set, sign-out redirects to Cognito's logout endpoint |
| `logoutUri` | `string` | `${appUrl}/auth/signin` | Post-logout redirect URI (must be registered in Cognito) |
| `scope` | `string` | `"openid email profile"` | OAuth scopes requested during sign-in |
| `debug` | `boolean` | `false` | Enable `[oidc-auth]` checkpoint logging to stdout |

### Cookie scoping and shared sessions

By default, the library issues a host-only session cookie, so existing behavior is unchanged. That is the right choice for a single app host, including the common case where the same host is used on different local ports.

To share a session cookie across subdomains such as `competition.example.com` and `officials.example.com`, set `cookieDomain` to the parent domain:

```ts
createCognitoAuth({
  // ...
  appUrl: "https://competition.example.com",
  cookieDomain: ".example.com",
  cookieSameSite: "lax",
  cookieSecure: true,
});
```

Notes:

- Leaving `cookieDomain` unset keeps the cookie host-only.
- Apps on the same host but different ports usually do not need `cookieDomain`.
- Cross-subdomain production deployments should use HTTPS. In practice that means leaving `cookieSecure` enabled or setting it explicitly to `true`.

### Migration notes

No code changes are required for existing consumers.

- If you omit the new cookie options, behavior stays the same: host-only cookie, `Path=/`, `SameSite=lax`, and `Secure` enabled automatically in production only.
- To share a session across subdomains, set `cookieDomain` to a parent domain such as `".example.com"` in every participating app.
- If you set `cookieSameSite: "none"`, you should also set `cookieSecure: true` for browser compatibility.
- Sign-out now clears cookies using the same scope attributes as sign-in, so shared-domain cookies are deleted correctly when `cookieDomain` is configured.

### Release checklist

Use this flow when cutting a git-tagged release:

1. Confirm the intended version is set in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md` so the release notes are under a dated heading for that version.
3. Run `npm test`.
4. Run `npm pack --dry-run` and confirm only the expected files will ship.
5. Commit the release changes, for example `git add . && git commit -m "release: v0.5.0"`.
6. Create an annotated tag, for example `git tag -a v0.5.0 -m "v0.5.0"`.
7. Push the commit and tag with `git push origin main --follow-tags`.
8. Publish the package with `npm publish` from the tagged commit.
9. Verify the published version and, if you use GitHub releases, create a release from the matching tag.

## KVStore interface

Any object that satisfies this interface can be used as `sessionStore` or `pkceStore`:

```ts
interface KVStore<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### Example: Redis (ioredis)

```ts
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL!);

const sessionStore = {
  async get(key: string) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  },
  async set(key: string, value: unknown, ttlSeconds: number) {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  },
  async delete(key: string) {
    await redis.del(key);
  },
};
```

You can pass the same store for both `sessionStore` and `pkceStore` to avoid maintaining two connections.

## Cognito SSO logout

To also terminate the Cognito SSO session on sign-out, provide `cognitoDomain`:

```ts
createCognitoAuth({
  // ...
  cognitoDomain: "my-app.auth.us-east-1.amazoncognito.com",
  logoutUri: "https://myapp.example.com/auth/signin", // must be in Cognito allowed sign-out URLs
});
```

`GET /api/auth/signout` will redirect to  
`https://<cognitoDomain>/logout?client_id=<clientId>&logout_uri=<logoutUri>`.

## Debug logging

```ts
createCognitoAuth({
  // ...
  debug: true,
});
```

Or set the environment variable at runtime without changing code:

```
OIDC_DEBUG=1
```

Log lines are prefixed with `[oidc-auth]` and trace each async step (OIDC discovery, PKCE storage, token exchange, session write).

## Exported types

```ts
export interface KVStore<T> { ... }
export interface SessionData { ... }
export interface SessionCookie { ... }
export interface PkceEntry { ... }
export interface CognitoAuthConfig { ... }
export function createCognitoAuth(config: CognitoAuthConfig): {
  GET: (request: Request, ctx: Ctx) => Promise<Response>;
  POST: (request: Request, ctx: Ctx) => Promise<Response>;
  getSession: (headers: Headers) => Promise<SessionData | null>;
  deleteSession: (headers: Headers) => Promise<string>;
};
```

## License

MIT
