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

- Paste `deviceToken` into the Android diagnostic credential field. The app encrypts it with Android Keystore and only uses it to obtain a short-lived WebSocket ticket.
- Paste `dashboardToken` into the web console when the protected-service prompt appears. The web console keeps it in the current browser session and sends it only over HTTPS to obtain a ticket; it is not part of the Vite build output.
- The device role can start/resume/write its own sessions. The dashboard role can list/read/raw-replay sessions for the same owner but cannot write sensor samples.
- Rotate a token with `POST /api/auth/rotate` and revoke it with `POST /api/auth/revoke`, both using the current bearer token. A rotated token invalidates the previous token immediately.

The current Android token field is an acceptance bridge. The production enrollment UX still needs a controlled one-time handoff (for example, an authenticated dashboard enrollment action), plus a device revoke/delete flow before release.

## Verification

Run the local enforced-mode regression without using real credentials:

```powershell
bun run smoke:auth
```

This verifies bootstrap single-use, unauthenticated rejection, owner binding, device/dashboard role isolation, WebSocket ticket use, and token rotation. It uses a temporary local SQLite file and synthetic samples only.
