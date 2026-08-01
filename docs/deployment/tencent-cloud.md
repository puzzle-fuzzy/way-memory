# Tencent Cloud MVP deployment

This deployment targets the existing Tencent Cloud host `101.35.246.159` described in `R:\YXSwy-部署文档.md`.

- Vite production files: `/var/www/way-memory`
- Bundled Bun API: `/opt/way-memory/api/way-memory-api.js`
- API systemd unit: `way-memory-api.service`
- Nginx entry point: `http://101.35.246.159/`
- Public health check: `http://101.35.246.159/api/health`
- WebSocket entry point: `ws://101.35.246.159/realtime?role=dashboard`
- Android `wayMemoryApiUrl`: `http://101.35.246.159`

The checked-in IP configuration is intentionally test-only. The production templates are `deploy/tencent-cloud/way-memory-api.production.service` and `deploy/tencent-cloud/way-memory.yxswy.com.nginx.conf.example`; install them only after DNS, ACME certificates, and the protected `/etc/way-memory/way-memory.env` are ready.

The production environment file must contain `WAY_MEMORY_AUTH_MODE=enforced`, a long random `WAY_MEMORY_BOOTSTRAP_TOKEN`, `WAY_MEMORY_PUBLIC_ORIGIN=https://way-memory.yxswy.com`, `WAY_MEMORY_ALLOWED_ORIGIN=https://way-memory.yxswy.com`, `WAY_MEMORY_RETENTION_DAYS=90` (or an explicitly approved 1-3,650 day policy), and the persistent `WAY_MEMORY_DB_PATH`. Never commit that file or copy its contents into deployment logs.

Set `WAY_MEMORY_DB_PATH=/opt/way-memory/data/way-memory.sqlite` in the systemd environment. The service creates the directory and uses a bounded SQLite snapshot store: 100 retained sessions, a 1,024-sample raw replay tail per session, and a two-second flush interval. Keep `/opt/way-memory/data` on the persistent system disk and include it in the backup policy.

The API keeps live sessions in memory for low-latency WebSocket updates and persists bounded session snapshots to SQLite. A process restart recovers recent sessions as stopped instead of losing the learned route. Each retained session keeps a bounded raw replay ring of 1,024 normalized samples, plus bounded Pose, location and event tracks. The configured retention window automatically removes older stopped sessions and routes from both memory and SQLite.

After restarting `way-memory-api.service`, poll `http://127.0.0.1:8787/health` until it responds before checking the public `/api/health`; systemd may report the unit active a fraction before Bun has bound the socket.

Runtime memory protection and coordinate validation are documented in `docs/data-integrity.md`: 20 sessions, 500 location points, 500 legacy relative points, 1,200 Pose points, 128 motion events, 1,024 raw replay samples per session, bounded sensor snapshots, bounded payloads, timestamp ordering, coordinate range checks, duplicate suppression, and short-gap jump rejection.

The route registry is also bounded: 100 persisted routes, up to 50 observation summaries and 128 manual nodes per route, plus 500 geographic and 1,200 Pose points in the reference window. Repeated observations are eligible for GNSS-nearest alignment only after the server's coverage/residual checks; local ENU/AR frames are not concatenated automatically.

This MVP entry point is HTTP/WS on the server IP and is not a production privacy boundary. The API authorization core, Android Keystore storage, and dashboard one-time enrollment-code flow are implemented but not enabled on this test deployment; do not send real user route history to it. Before production use, configure `WAY_MEMORY_ENV=production`, `WAY_MEMORY_AUTH_MODE=enforced`, a one-time `WAY_MEMORY_BOOTSTRAP_TOKEN`, and `WAY_MEMORY_PUBLIC_ORIGIN=https://...`, then add the domain/TLS proxy. The production guard refuses to bind if the HTTPS/auth configuration is missing.

`/health` is intentionally kept as the loopback service check and is not exposed by the Nginx SPA fallback. Use `/api/health` for a public deployment probe; it is proxied to the same API process.

## Latest test deployment evidence

The latest anonymous test deployment uses API commit `3cb2b17` and Web commit `7d574fe`; each switch was made only after a remote SHA-256 comparison. The remote API bundle hash is `5ac3909a9a4d8f5212e29448f9bf6273565ff7c89ea04fcff650ca76d80fe5f3`; the current web index hash is `e3fe7638be4f0252775c292981530d0c19d1e681d24d9acb8845c9277ee96809`.

- Backup retained on the host: `/var/backups/way-memory/20260731T192039Z/`;
- `way-memory-api.service`: active after restart;
- public `/`: HTTP 200;
- public `/api/health`: HTTP 200;
- public Pose WebSocket smoke: passed;
- public live sample smoke: passed;
- public Android queue batch smoke: 100 samples accepted, 0 dropped;
- public route navigation smoke: 3 observations aligned, route published, on-route/off-route projection passed;
- public one-time navigation handoff smoke: route code bound navigation without a route ID, then reuse was rejected;
- public 3D navigation smoke: vertical displacement returned `near-route` with an altitude delta, and horizontal displacement returned `off-route`;
- public long-closure smoke: passed with 1,200 retained Pose points;
- compact `GET /api/sessions` history response: approximately 44 KB after the bounded session-list change;
- `/opt/way-memory/data`: approximately 6.8 MB at verification time.

These are test-environment facts, not a production release claim: the public entry point is still IP-based HTTP/WS with `WAY_MEMORY_AUTH_MODE=off`. The HTTPS/authenticated templates below remain uninstalled until DNS, certificates, and protected environment variables are available.

## Current release boundary (2026-08-01)

The repository `main` branch contains the authenticated route-learning, one-time navigation-handoff, and field-evidence provenance gates. The current public IP deployment has not been switched to this protected release: it remains the anonymous HTTP/WS test environment described above.

The production cutover is currently blocked by external host state, not by the local API checks:

- `way-memory-api.service` is active and the loopback API returns HTTP 200 on `127.0.0.1:8787`.
- The host has no `way-memory.yxswy.com` Nginx server block, no ACME certificate for that hostname, and no `/etc/way-memory/way-memory.env`.
- `way-memory.yxswy.com` currently resolves to `198.18.0.248`, not `101.35.246.159`, from both the workstation resolver and Cloudflare's public resolver.

Before any production restart, create the DNS A record `way-memory.yxswy.com -> 101.35.246.159`, obtain the certificate, provision the protected environment file, and install the checked-in Nginx/systemd templates. Then run the strict TLS preflight and the authenticated public smoke from outside the host. Do not send real route data to the IP-based test endpoint while this boundary remains.

After the production templates are installed, verify the edge before building a release APK:

```powershell
$env:WAY_MEMORY_PUBLIC_BASE_URL = "https://way-memory.yxswy.com"
$env:WAY_MEMORY_REQUIRE_AUTH = "1"
$env:WAY_MEMORY_DASHBOARD_TOKEN = "<operator environment value>"
bun run preflight:public-tls
```

The command must pass from outside the Tencent Cloud host. It is intentionally expected to fail against the current IP-based HTTP test deployment.

Then run the authenticated service loop with the enrolled credentials:

```powershell
$env:WAY_MEMORY_DEVICE_TOKEN = "<device token>"
$env:WAY_MEMORY_DASHBOARD_TOKEN = "<dashboard token>"
bun run smoke:public-auth
```

## Reproducible release bundle

Build the production payload from a clean checkout on `main`:

```powershell
$env:WAY_MEMORY_RELEASE_DIR = ".release/way-memory"
bun run release:build
```

The generated directory contains `web/`, the Bun-bundled `api/way-memory-api.js`, the authenticated systemd/HTTPS Nginx templates and guarded `install-release.sh` under `deploy/tencent-cloud/`, plus `RELEASE-MANIFEST.json` and `RELEASE-SHA256SUMS.txt` with the source commit and SHA-256 for every payload file. The bundle deliberately excludes `.env` files, database data, certificates, private keys, Android signing material, and user capture data. Copy only this generated directory to a staging location on the Tencent Cloud host, review the protected environment file independently, and compare the manifest before restarting the service.

The release bundle is a packaging step, not proof of a public deployment. The public proof still requires DNS, ACME, Nginx, authenticated WebSocket, cross-network route smoke, and a physical Android device matrix to pass.

After building the bundle, verify the bundled API itself before copying it to the host:

```powershell
bun run smoke:release
```

This starts only the generated API with an isolated temporary SQLite file, checks both loopback health endpoints, and removes the temporary process and data when the probe finishes.

On the host, run the installer in check-only mode first:

```bash
sudo bash /tmp/way-memory-release-<commit>/deploy/tencent-cloud/install-release.sh \
  /tmp/way-memory-release-<commit> --check-only
```

It refuses to write anything until the domain resolves to the expected host, the ACME certificate covers the domain and has matching private key material, and the root-owned protected environment file contains enforced authentication and bounded retention settings. Once that check passes, rerun the same command without `--check-only`; it keeps a timestamped backup and verifies local API health, HTTP-to-HTTPS redirect, HTTPS API health, and the web entry point before reporting success. It does not perform the authenticated WSS or physical-phone acceptance gates.
