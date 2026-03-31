# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-03-31

### Added

- configurable cookie scoping in `CognitoAuthConfig` via `cookieDomain`, `cookiePath`, `cookieSameSite`, and `cookieSecure`
- domain-aware session cookie clearing so cross-subdomain shared cookies can be removed correctly on sign-out
- cookie behavior tests covering default host-only cookies and configured shared-domain cookies

### Changed

- `SessionCookie` now supports an optional `domain` and configurable SameSite values

## [0.3.5] - 2026-03-27
- fixed scope - added profile. Is also now configurable through the API

## [0.3.4] - 2026-03-26

### Added

- `debug` option in `CognitoAuthConfig` — enables `[oidc-auth]` prefixed checkpoint
  logging to stdout at each async step of the sign-in flow (PKCE lookup, OIDC
  discovery, token exchange, session write). Useful for diagnosing hangs where
  a promise stalls silently and error handlers never fire.
- `OIDC_DEBUG=1` environment variable as a runtime alternative to `debug: true`.

## [0.3.3] - 2026-03-26
- fix a redirect bug related to URLs in the token exchange

## [0.3.2] - 2026-03-26
- fix a redirect bug

## [0.3.0] - 2026-03-26

### Added

- `signInRedirectPath` option in `CognitoAuthConfig` — configures where the browser is sent after a successful sign-in. Defaults to `"/"`.

## [0.2.0] - 2026-03-26

### Added

- Initial release.
- `createCognitoAuth` factory returning Next.js App Router `GET` / `POST` handlers, `getSession`, and `deleteSession`.
- PKCE + nonce flow via `openid-client`.
- Server-side session storage via a generic `KVStore<SessionData>` interface.
- In-memory `KVStore` backed by `globalThis` for safe use across Next.js HMR reloads.
- Automatic access-token refresh when within 5 minutes of expiry.
- Configurable cookie name, session TTL, and PKCE state TTL.
- Optional Cognito hosted-UI logout endpoint support via `cognitoDomain` and `logoutUri`.
