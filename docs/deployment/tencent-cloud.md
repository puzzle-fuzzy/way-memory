# Tencent Cloud MVP deployment

This deployment targets the existing Tencent Cloud host `101.35.246.159` described in `R:\YXSwy-部署文档.md`.

- Vite production files: `/var/www/way-memory`
- Bundled Bun API: `/opt/way-memory/api/way-memory-api.js`
- API systemd unit: `way-memory-api.service`
- Nginx entry point: `http://101.35.246.159/`
- WebSocket entry point: `ws://101.35.246.159/realtime?role=dashboard`

The API currently stores sessions in memory for the MVP. Restarting the service clears live sessions; persistent route storage is a later milestone.
