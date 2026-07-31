# Way-memory authentication handoff

The API supports two explicit modes:

- `WAY_MEMORY_AUTH_MODE=off` is for local smoke tests and the current Tencent HTTP/WS test deployment.
- `WAY_MEMORY_AUTH_MODE=enforced` requires bearer access tokens, owner-scoped sessions, and short-lived WebSocket tickets.

Do not send real route history to the current IP deployment. It remains an anonymous test environment until the HTTPS edge, protected runtime variables, and client enrollment handoff are deployed together.

## Provision one self-hosted owner

On the protected API host, configure these variables in the service environment. Keep the bootstrap value outside the repository and rotate it after the one-time provisioning call:

```powershell
$env:WAY_MEMORY_ENV = "production"
$env:WAY_MEMORY_AUTH_MODE = "enforced"
$env:WAY_MEMORY_PUBLIC_ORIGIN = "https://way-memory.example.com"
$env:WAY_MEMORY_ALLOWED_ORIGIN = "https://way-memory.example.com"
$env:WAY_MEMORY_BOOTSTRAP_TOKEN = "generate-a-long-random-value-outside-the-repository"
```

The API refuses to bind in production when HTTPS, enforced authorization, or a specific CORS origin is missing. After the service is running behind TLS, call bootstrap once over the protected channel:

```powershell
$headers = @{ "X-Way-Memory-Bootstrap" = $env:WAY_MEMORY_BOOTSTRAP_TOKEN }
$credentials = Invoke-RestMethod `
  -Method Post `
  -Uri "https://way-memory.example.com/api/auth/bootstrap" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body '{"ownerId":"owner-primary"}'
$credentials | ConvertTo-Json
```

The response contains one `deviceToken` and one `dashboardToken`. Store them in a password manager or an equivalent protected handoff. Never put them in Git, `.env` files that are synced, APK build constants, screenshots, issue comments, or server logs. The bootstrap endpoint is one-time; if the response is lost, rotate the bootstrap configuration and recover the database according to the deployment runbook rather than reusing a copied token.

## Client handoff

- After dashboard authentication, `POST /api/auth/devices` remains available for operator rotation and legacy diagnostics. `GET /api/auth/devices` lists only token metadata, never token plaintext; `POST /api/auth/devices/<tokenId>/revoke` revokes a device without exposing its credential.
- Prefer `POST /api/auth/enrollments`: the dashboard displays a ten-minute one-time pairing code, and Android exchanges it only over HTTPS before encrypting the returned device credential with Android Keystore. The long-lived device token is not rendered by the web client. Local HTTP/WS remains available only for anonymous protocol diagnostics; it cannot be used for pairing.
- Paste `dashboardToken` into the web console when the protected-service prompt appears. The web console keeps it in the current browser session and sends it only over HTTPS to obtain a ticket; it is not part of the Vite build output.
- The device role can start/resume/write its own sessions. The dashboard role can list/read/raw-replay sessions for the same owner but cannot write sensor samples.
- A dashboard can create a ten-minute, one-time text enrollment code with `POST /api/auth/enrollments`. The Android app exchanges it once through `POST /api/auth/enrollments/consume`; only the resulting long-lived device credential is stored in Android Keystore. The code is not a route marker and does not require a QR sticker, NFC tag, or other fixed hardware.
- Rotate a token with `POST /api/auth/rotate` and revoke it with `POST /api/auth/revoke`, both using the current bearer token. A rotated token invalidates the previous token immediately.

The Android long-term token field remains an acceptance bridge for legacy operators. The normal enrollment path is the short one-time pairing code; device credentials remain revocable from the dashboard.

## Verified-route navigation handoff

After a route is `verified`, the dashboard may call `POST /api/routes/<routeId>/handoff`. The API returns a five-minute `wm_nav_...` code once. Only the SHA-256 hash is stored; the raw code is never persisted or logged. The code is owner-scoped, consumed atomically by the device WebSocket `session.start` message, and cannot be reused after success, expiry, or a different-owner attempt.

The Android acceptance screen accepts this code as plain text. It is stored only in the app-private active-session recovery file until the first successful `session.started` response, so screen rotation or process recovery does not silently downgrade the requested navigation session. A normal Stop deletes the recovery file. The handoff code is not a replacement for the device access token and does not grant route-list or raw-data access.

## Verification

Run the local enforced-mode regression without using real credentials:

```powershell
bun run smoke:auth
```

This verifies bootstrap single-use, unauthenticated rejection, owner binding, device/dashboard role isolation, WebSocket ticket use, and token rotation. It uses a temporary local SQLite file and synthetic samples only.
