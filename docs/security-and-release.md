# Security and production release gate

Way-memory stores movement traces, sensor streams, timestamps, and potentially identifiable places. A route recorded for a blind user is sensitive personal data. The current Tencent Cloud IP deployment is a test environment only: it exposes HTTP/WS endpoints without authentication and must not be used for real users or private route history.

## Required production architecture

1. **TLS at the edge**
   - Use a real domain with a valid certificate.
   - Redirect HTTP to HTTPS and proxy WebSocket traffic as WSS.
   - Release Android builds reject an `http://` API base URL.

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

Until these gates exist, public smoke tests may use the IP-based HTTP/WS deployment, but real user route data must not be sent there.
