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

export interface IssuedAccessToken {
  tokenId: string;
  token: string;
  expiresAt: string;
}

export interface EnrollmentCode {
  code: string;
  expiresAt: string;
}

const ACCESS_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
const WS_TICKET_TTL_MS = 60 * 1_000;
const ENROLLMENT_CODE_TTL_MS = 10 * 60 * 1_000;
const MAX_AUTH_TOKENS = 10_000;
const ENROLLMENT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const hashSecret = async (secret: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomSecret = (prefix: string) => `${prefix}${crypto.randomUUID()}${crypto.randomUUID()}`;

const normalizeEnrollmentCode = (code: string) => code.trim().toUpperCase().replace(/[\s-]/g, "");

const randomEnrollmentCode = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const characters = [...bytes].map((byte) => ENROLLMENT_ALPHABET[byte % ENROLLMENT_ALPHABET.length]).join("");
  return `WM-${characters.slice(0, 4)}-${characters.slice(4, 8)}-${characters.slice(8, 12)}`;
};

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
      CREATE TABLE IF NOT EXISTS auth_enrollment_codes (
        code_hash TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS auth_enrollment_codes_expiry
        ON auth_enrollment_codes(expires_at, consumed_at);
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

    const device = await this.issueAccessToken(ownerId, "device");
    const dashboard = await this.issueAccessToken(ownerId, "dashboard");
    this.database.query("INSERT INTO auth_metadata(key, value) VALUES ('bootstrap-consumed', ?)").run(new Date().toISOString());
    return { ownerId, deviceToken: device.token, dashboardToken: dashboard.token };
  }

  async issueAccessToken(ownerId: string, role: AuthRole): Promise<IssuedAccessToken> {
    const token = randomSecret(`wm_${role}_`);
    const tokenId = crypto.randomUUID();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    await this.insertToken(token, ownerId, role, "access", ACCESS_TOKEN_TTL_MS, tokenId);
    return { tokenId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async createEnrollmentCode(ownerId: string): Promise<EnrollmentCode> {
    const code = randomEnrollmentCode();
    const expiresAt = Date.now() + ENROLLMENT_CODE_TTL_MS;
    this.prune();
    this.database.query(`
      INSERT INTO auth_enrollment_codes(code_hash, enrollment_id, owner_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(await hashSecret(normalizeEnrollmentCode(code)), crypto.randomUUID(), ownerId, Date.now(), expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consumeEnrollmentCode(input: string): Promise<(IssuedAccessToken & { ownerId: string }) | null> {
    const normalizedCode = normalizeEnrollmentCode(input);
    if (!normalizedCode || normalizedCode.length > 64) return null;
    const codeHash = await hashSecret(normalizedCode);
    const row = this.database.query(`
      SELECT owner_id
      FROM auth_enrollment_codes
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
    `).get(codeHash, Date.now()) as { owner_id: string } | null;
    if (!row) return null;

    const token = randomSecret("wm_device_");
    const tokenId = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + ACCESS_TOKEN_TTL_MS;
    const tokenHash = await hashSecret(token);
    this.prune();
    const consume = this.database.transaction(() => {
      const consumed = this.database.query(`
        UPDATE auth_enrollment_codes
        SET consumed_at = ?
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(createdAt, codeHash, createdAt);
      if (consumed.changes !== 1) return false;
      this.database.query(`
        INSERT INTO auth_tokens(token_hash, token_id, owner_id, role, kind, created_at, expires_at)
        VALUES (?, ?, ?, 'device', 'access', ?, ?)
      `).run(tokenHash, tokenId, row.owner_id, createdAt, expiresAt);
      return true;
    });
    if (!consume()) return null;
    return { ownerId: row.owner_id, tokenId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  listAccessTokens(ownerId: string, role: AuthRole = "device") {
    return this.database.query(`
      SELECT token_id, role, kind, created_at, expires_at, revoked_at
      FROM auth_tokens
      WHERE owner_id = ? AND role = ? AND kind = 'access'
      ORDER BY created_at DESC
      LIMIT 128
    `).all(ownerId, role) as Array<{
      token_id: string;
      role: AuthRole;
      kind: AuthTokenKind;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>;
  }

  revokeTokenId(ownerId: string, tokenId: string) {
    this.database.query("UPDATE auth_tokens SET revoked_at = ? WHERE token_id = ? AND owner_id = ? AND role = 'device' AND kind = 'access' AND revoked_at IS NULL").run(Date.now(), tokenId, ownerId);
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

  private async insertToken(token: string, ownerId: string, role: AuthRole, kind: AuthTokenKind, ttlMs: number, tokenId = crypto.randomUUID()) {
    this.prune();
    const tokenHash = await hashSecret(token);
    this.database.query(`
      INSERT INTO auth_tokens(token_hash, token_id, owner_id, role, kind, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tokenHash, tokenId, ownerId, role, kind, Date.now(), Date.now() + ttlMs);
  }

  private prune() {
    const now = Date.now();
    this.database.query("DELETE FROM auth_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
    this.database.query("DELETE FROM auth_enrollment_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
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
