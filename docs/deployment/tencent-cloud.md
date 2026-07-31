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

The production environment file must contain `WAY_MEMORY_AUTH_MODE=enforced`, a long random `WAY_MEMORY_BOOTSTRAP_TOKEN`, `WAY_MEMORY_PUBLIC_ORIGIN=https://way-memory.yxswy.com`, `WAY_MEMORY_ALLOWED_ORIGIN=https://way-memory.yxswy.com`, and the persistent `WAY_MEMORY_DB_PATH`. Never commit that file or copy its contents into deployment logs.

Set `WAY_MEMORY_DB_PATH=/opt/way-memory/data/way-memory.sqlite` in the systemd environment. The service creates the directory and uses a bounded SQLite snapshot store: 100 retained sessions, a 1,024-sample raw replay tail per session, and a two-second flush interval. Keep `/opt/way-memory/data` on the persistent system disk and include it in the backup policy.

The API keeps live sessions in memory for low-latency WebSocket updates and persists bounded session snapshots to SQLite. A process restart recovers recent sessions as stopped instead of losing the learned route. Each retained session keeps a bounded raw replay ring of 1,024 normalized samples, plus bounded Pose, location and event tracks.

After restarting `way-memory-api.service`, poll `http://127.0.0.1:8787/health` until it responds before checking the public `/api/health`; systemd may report the unit active a fraction before Bun has bound the socket.

Runtime memory protection and coordinate validation are documented in `docs/data-integrity.md`: 20 sessions, 500 location points, 500 legacy relative points, 1,200 Pose points, 128 motion events, 1,024 raw replay samples per session, bounded sensor snapshots, bounded payloads, timestamp ordering, coordinate range checks, duplicate suppression, and short-gap jump rejection.

The route registry is also bounded: 100 persisted routes, up to 50 observation summaries and 128 manual nodes per route, plus 500 geographic and 1,200 Pose points in the reference window. Repeated observations are eligible for GNSS-nearest alignment only after the server's coverage/residual checks; local ENU/AR frames are not concatenated automatically.

This MVP entry point is HTTP/WS on the server IP and is not a production privacy boundary. The API authorization core is implemented but not enabled on this test deployment; do not send real user route history to it. Before production use, finish the Android Keystore and dashboard enrollment clients, configure `WAY_MEMORY_ENV=production`, `WAY_MEMORY_AUTH_MODE=enforced`, a one-time `WAY_MEMORY_BOOTSTRAP_TOKEN`, and `WAY_MEMORY_PUBLIC_ORIGIN=https://...`, then add the domain/TLS proxy. The production guard refuses to bind if the HTTPS/auth configuration is missing.

`/health` is intentionally kept as the loopback service check and is not exposed by the Nginx SPA fallback. Use `/api/health` for a public deployment probe; it is proxied to the same API process.

## Latest test deployment evidence

The latest anonymous test deployment was built from Git commit `51aaa6e` and switched only after a remote API/Web SHA-256 comparison. The remote API bundle hash was `21a8e99b0fc87ef8abbdbea1b01ec154fa5b2ba823f1c87b6b1b9a9c0d50a14d`; the web index hash was `eb463a710e019d5944a68eaec668ec41edab4a7d13d64c24dc7f3b0bad1883a4`.

- Backup retained on the host: `/var/backups/way-memory/20260731T163254Z/`;
- `way-memory-api.service`: active after restart;
- public `/`: HTTP 200;
- public `/api/health`: HTTP 200;
- public Pose WebSocket smoke: passed;
- public live sample smoke: passed;
- public Android queue batch smoke: 100 samples accepted, 0 dropped;
- public long-closure smoke: passed with 1,200 retained Pose points;
- compact `GET /api/sessions` history response: approximately 44 KB after the bounded session-list change;
- `/opt/way-memory/data`: approximately 6.8 MB at verification time.

These are test-environment facts, not a production release claim: the public entry point is still IP-based HTTP/WS with `WAY_MEMORY_AUTH_MODE=off`. The HTTPS/authenticated templates below remain uninstalled until DNS, certificates, and protected environment variables are available.
