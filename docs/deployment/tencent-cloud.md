# Tencent Cloud MVP deployment

This deployment targets the existing Tencent Cloud host `101.35.246.159` described in `R:\YXSwy-部署文档.md`.

- Vite production files: `/var/www/way-memory`
- Bundled Bun API: `/opt/way-memory/api/way-memory-api.js`
- API systemd unit: `way-memory-api.service`
- Nginx entry point: `http://101.35.246.159/`
- Public health check: `http://101.35.246.159/api/health`
- WebSocket entry point: `ws://101.35.246.159/realtime?role=dashboard`
- Android `wayMemoryApiUrl`: `http://101.35.246.159`

Set `WAY_MEMORY_DB_PATH=/opt/way-memory/data/way-memory.sqlite` in the systemd environment. The service creates the directory and uses a bounded SQLite snapshot store: 100 retained sessions, a 1,024-sample raw replay tail per session, and a two-second flush interval. Keep `/opt/way-memory/data` on the persistent system disk and include it in the backup policy.

The API keeps live sessions in memory for low-latency WebSocket updates and persists bounded session snapshots to SQLite. A process restart recovers recent sessions as stopped instead of losing the learned route. Each retained session keeps a bounded raw replay ring of 1,024 normalized samples, plus bounded Pose, location and event tracks.

Runtime memory protection and coordinate validation are documented in `docs/data-integrity.md`: 20 sessions, 500 location points, 500 legacy relative points, 1,200 Pose points, 128 motion events, 1,024 raw replay samples per session, bounded sensor snapshots, bounded payloads, timestamp ordering, coordinate range checks, duplicate suppression, and short-gap jump rejection.

This MVP entry point is HTTP/WS on the server IP. Add a domain and TLS certificate before production use; the Android base URL can then be changed to the HTTPS domain and will automatically use WSS.

`/health` is intentionally kept as the loopback service check and is not exposed by the Nginx SPA fallback. Use `/api/health` for a public deployment probe; it is proxied to the same API process.
