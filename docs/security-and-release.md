# Security and production release gate

Way-memory stores movement traces, sensor streams, timestamps, and potentially identifiable places. A route recorded for a blind user is sensitive personal data. The current Tencent Cloud IP deployment is a test environment only: it exposes HTTP/WS endpoints without authentication and must not be used for real users or private route history.

## Implemented authorization core

The API now has an opt-in enforced authorization mode for the single-node MVP. Set `WAY_MEMORY_AUTH_MODE=enforced` and provide a one-time `WAY_MEMORY_BOOTSTRAP_TOKEN`; `POST /api/auth/bootstrap` returns one device access token and one dashboard access token, and the bootstrap record cannot be used twice. Only token hashes are stored in SQLite.

- Device and dashboard tokens have separate roles and owner IDs.
- Every session is assigned to the authenticated owner; dashboard lists, reads, raw replay, and realtime broadcasts are owner-scoped.
- Device writes and dashboard reads are separate capabilities.
- WebSocket upgrades require a 60-second role-specific ticket obtained through an authenticated HTTP request; long-lived access tokens are not accepted in the WebSocket URL.
- Access-token and ticket rows are pruned on insert and capped at 10,000 rows; expired/revoked tickets cannot grow the SQLite file without bound.
- `POST /api/auth/rotate` revokes the old access token immediately and returns a replacement; `POST /api/auth/revoke` revokes the current token.
- `bun run smoke:auth` exercises the unauthorized, bootstrap, owner binding, role separation, ticket, and rotation paths.

The Android client now encrypts the device token with an Android Keystore-backed AES-GCM key and exchanges it for a short-lived WebSocket ticket before connecting. It still needs a user-facing enrollment handoff and the dashboard sign-in screen before enabling it for real users; copying a token through the current diagnostic field is an acceptance bridge, not the final onboarding UX.

Verified-route navigation now has a separate one-time handoff boundary. The dashboard receives a five-minute route code, the API stores only its SHA-256 hash, and the device consumes it atomically during `session.start`. The code is owner-scoped and does not replace the device token, expose a route list, or authorize raw replay. It is suitable for software-only field testing, but the final product still needs a polished authenticated enrollment and accessibility flow.

## Required production architecture

1. **TLS at the edge**
   - Use a real domain with a valid certificate.
   - Redirect HTTP to HTTPS and proxy WebSocket traffic as WSS.
   - Release Android builds reject an `http://` API base URL.
   - Starting the API with `WAY_MEMORY_ENV=production` also requires `WAY_MEMORY_AUTH_MODE=enforced` and `WAY_MEMORY_PUBLIC_ORIGIN=https://...`; an unsafe production configuration exits before binding a port.
   - Production also requires `WAY_MEMORY_ALLOWED_ORIGIN=https://...`; the API does not allow wildcard CORS when production mode is selected.

2. **User and device authorization**
   - Add an account/session identity before exposing the session list.
   - Register a phone to a user through a one-time enrollment flow; do not identify a device by `ANDROID_ID` alone.
   - Store the device credential in Android Keystore-backed storage and rotate/revoke it.
   - Authorize every session, route, raw replay, annotation, and export by owner/role. A session ID is not a credential.

3. **Realtime authorization**
   - Authenticate the WebSocket upgrade with a short-lived, audience-limited ticket or an authenticated browser session.
   - Do not put long-lived bearer secrets in a URL query string, public JavaScript bundle, or APK build constant.
   - Enforce separate device-ingest and dashboard-read roles; a dashboard must not be able to upload samples.

4. **Data lifecycle**
   - Keep the bounded in-memory/replay limits as resource protection, but add an explicit user retention period.
   - Support session deletion and export, including SQLite snapshots and raw replay data.
   - Redact route coordinates, raw values, tokens, and device identifiers from logs and error responses.
   - Encrypt persistent storage and backups at rest on the production host.

## Release gates

The following are required before calling the service production-ready:

- HTTPS/WSS public probe from a phone network;
- authenticated session creation, resume, dashboard read, raw replay, and unauthorized-access rejection tests;
- per-user isolation test proving one account cannot list or fetch another user's route;
- token rotation/revocation test;
- deletion/export test covering the database snapshot and replay tail;
- backup restore test with secrets excluded from source control and logs.

The repository includes a production systemd/Nginx template, but no public TLS deployment is claimed until `way-memory.yxswy.com` serves the built web app, `/api/health` over HTTPS, and a WSS ticket flow from a phone network.

After DNS, certificates, Nginx, and the protected API environment are installed, run the strict edge preflight from a machine outside the server:

```powershell
$env:WAY_MEMORY_PUBLIC_BASE_URL = "https://way-memory.yxswy.com"
$env:WAY_MEMORY_REQUIRE_AUTH = "1"
$env:WAY_MEMORY_DASHBOARD_TOKEN = "<operator environment value; the script exchanges it for a short-lived WSS ticket>"
bun run preflight:public-tls
```

The preflight requires HTTP to redirect to HTTPS, the web entry point and API health endpoint to be reachable over HTTPS, unauthenticated realtime access to return `401`, and—when the token is supplied—the authenticated WSS handshake to succeed. It never prints the bearer token or ticket. This is an edge check; the physical-phone sensor matrix remains a separate gate.

With the two already-enrolled access tokens set in the operator environment, run the authenticated public smoke as a separate gate:

```powershell
$env:WAY_MEMORY_PUBLIC_BASE_URL = "https://way-memory.yxswy.com"
$env:WAY_MEMORY_DEVICE_TOKEN = "<device token>"
$env:WAY_MEMORY_DASHBOARD_TOKEN = "<dashboard token>"
bun run smoke:public-auth
```

This creates and stops one disposable session, verifies dashboard broadcast, uploads one pose, reconnects with `session.resume`, reads the session and raw replay, and asserts device-read/dashboard-write role separation. It does not rotate or consume bootstrap credentials and never prints token values.

Until these gates exist, public smoke tests may use the IP-based HTTP/WS deployment, but real user route data must not be sent there.
