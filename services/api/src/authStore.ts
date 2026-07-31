import { Database } from "bun:sqlite";

export type AuthRole = "device" | "dashboard";
export type AuthTokenKind = "access" | "ws-ticket";

export interface AuthPrincipal {
  tokenId: string;
  ownerId: string;
  role: AuthRole;
  kind: AuthTokenKind;
  expiresAt: string;
}

export interface BootstrapCredentials {
  ownerId: string;
  deviceToken: string;
  dashboardToken: string;
}

const ACCESS_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
const WS_TICKET_TTL_MS = 60 * 1_000;
const MAX_AUTH_TOKENS = 10_000;

const hashSecret = async (secret: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomSecret = (prefix: string) => `${prefix}${crypto.randomUUID()}${crypto.randomUUID()}`;

export class AuthStore {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS auth_tokens_lookup
        ON auth_tokens(token_hash, revoked_at, expires_at);
      CREATE TABLE IF NOT EXISTS auth_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async bootstrap(bootstrapToken: string, ownerId = `owner-${crypto.randomUUID()}`): Promise<BootstrapCredentials> {
    const configuredBootstrapToken = Bun.env.WAY_MEMORY_BOOTSTRAP_TOKEN;
    if (!configuredBootstrapToken || bootstrapToken !== configuredBootstrapToken) {
      throw new Error("invalid_bootstrap_token");
    }
    const consumed = this.database.query("SELECT value FROM auth_metadata WHERE key = 'bootstrap-consumed'").get() as { value: string } | null;
    if (consumed) throw new Error("bootstrap_already_used");

    const deviceToken = randomSecret("wm_device_");
    const dashboardToken = randomSecret("wm_dashboard_");
    await this.insertToken(deviceToken, ownerId, "device", "access", ACCESS_TOKEN_TTL_MS);
    await this.insertToken(dashboardToken, ownerId, "dashboard", "access", ACCESS_TOKEN_TTL_MS);
    this.database.query("INSERT INTO auth_metadata(key, value) VALUES ('bootstrap-consumed', ?)").run(new Date().toISOString());
    return { ownerId, deviceToken, dashboardToken };
  }

  async authenticate(secret: string, role?: AuthRole, kind: AuthTokenKind = "access"): Promise<AuthPrincipal | null> {
    if (!secret || secret.length > 512) return null;
    const tokenHash = await hashSecret(secret);
    const row = this.database.query(`
      SELECT token_id, owner_id, role, kind, expires_at
      FROM auth_tokens
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(tokenHash, Date.now()) as {
      token_id: string;
      owner_id: string;
      role: AuthRole;
      kind: AuthTokenKind;
      expires_at: number;
    } | null;
    if (!row || row.kind !== kind || (role && row.role !== role)) return null;
    return {
      tokenId: row.token_id,
      ownerId: row.owner_id,
      role: row.role,
      kind: row.kind,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async issueWebSocketTicket(principal: AuthPrincipal): Promise<{ ticket: string; expiresAt: string }> {
    const ticket = randomSecret("wm_ws_");
    const expiresAt = Date.now() + WS_TICKET_TTL_MS;
    await this.insertToken(ticket, principal.ownerId, principal.role, "ws-ticket", WS_TICKET_TTL_MS);
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  async rotate(secret: string, principal: AuthPrincipal): Promise<{ token: string; expiresAt: string }> {
    const token = randomSecret(`wm_${principal.role}_`);
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    await this.insertToken(token, principal.ownerId, principal.role, "access", ACCESS_TOKEN_TTL_MS);
    await this.revoke(secret);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async revoke(secret: string) {
    const tokenHash = await hashSecret(secret);
    this.database.query("UPDATE auth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(Date.now(), tokenHash);
  }

  private async insertToken(token: string, ownerId: string, role: AuthRole, kind: AuthTokenKind, ttlMs: number) {
    this.prune();
    const tokenHash = await hashSecret(token);
    this.database.query(`
      INSERT INTO auth_tokens(token_hash, token_id, owner_id, role, kind, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tokenHash, crypto.randomUUID(), ownerId, role, kind, Date.now(), Date.now() + ttlMs);
  }

  private prune() {
    const now = Date.now();
    this.database.query("DELETE FROM auth_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
    const count = (this.database.query("SELECT COUNT(*) AS count FROM auth_tokens").get() as { count: number }).count;
    if (count > MAX_AUTH_TOKENS) {
      this.database.query(`
        DELETE FROM auth_tokens
        WHERE token_id IN (
          SELECT token_id FROM auth_tokens
          WHERE kind = 'ws-ticket'
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(count - MAX_AUTH_TOKENS);
    }
  }
}
