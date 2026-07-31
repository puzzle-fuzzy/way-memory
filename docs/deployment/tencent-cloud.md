# Tencent Cloud MVP deployment

This deployment targets the existing Tencent Cloud host `101.35.246.159` described in `R:\YXSwy-部署文档.md`.

- Vite production files: `/var/www/way-memory`
- Bundled Bun API: `/opt/way-memory/api/way-memory-api.js`
- API systemd unit: `way-memory-api.service`
- Nginx entry point: `http://101.35.246.159/`
- WebSocket entry point: `ws://101.35.246.159/realtime?role=dashboard`
- Android `wayMemoryApiUrl`: `http://101.35.246.159`

The API currently stores sessions in memory for the MVP. Restarting the service clears live sessions; persistent route storage is a later milestone.

Runtime memory protection and coordinate validation are documented in `docs/data-integrity.md`: 20 sessions, 500 points per session, bounded sensor snapshots, bounded payloads, timestamp ordering, coordinate range checks, duplicate suppression, and short-gap jump rejection.

This MVP entry point is HTTP/WS on the server IP. Add a domain and TLS certificate before production use; the Android base URL can then be changed to the HTTPS domain and will automatically use WSS.
