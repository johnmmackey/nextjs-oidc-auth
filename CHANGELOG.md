# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
