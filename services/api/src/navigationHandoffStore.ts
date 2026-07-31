import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export interface NavigationHandoffGrant {
  handoffId: string;
  routeId: string;
  token: string;
  expiresAt: string;
}

const HANDOFF_TTL_MS = 5 * 60 * 1_000;
const MAX_HANDOFFS = 4_096;

const hashSecret = async (secret: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomToken = () => `wm_nav_${crypto.randomUUID()}${crypto.randomUUID()}`;

/** One-time, owner-scoped handoff codes. Raw codes never enter SQLite or logs. */
export class NavigationHandoffStore {
  private readonly database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS navigation_handoffs (
        handoff_hash TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS navigation_handoffs_owner_expiry
        ON navigation_handoffs(owner_id, expires_at, consumed_at);
    `);
  }

  async create(ownerId: string, routeId: string): Promise<NavigationHandoffGrant> {
    this.prune();
    const token = randomToken();
    const handoffId = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + HANDOFF_TTL_MS;
    await this.database.query(`
      INSERT INTO navigation_handoffs(handoff_hash, handoff_id, owner_id, route_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(await hashSecret(token), handoffId, ownerId, routeId, createdAt, expiresAt);
    this.prune();
    return { handoffId, routeId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consume(ownerId: string, token: string): Promise<{ handoffId: string; routeId: string } | null> {
    if (!token || token.length > 256) return null;
    const handoffHash = await hashSecret(token);
    const row = this.database.query(`
      SELECT handoff_id, route_id
      FROM navigation_handoffs
      WHERE handoff_hash = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at > ?
    `).get(handoffHash, ownerId, Date.now()) as { handoff_id: string; route_id: string } | null;
    if (!row) return null;
    const result = this.database.query(`
      UPDATE navigation_handoffs
      SET consumed_at = ?
      WHERE handoff_hash = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(Date.now(), handoffHash, ownerId, Date.now());
    if (result.changes !== 1) return null;
    return { handoffId: row.handoff_id, routeId: row.route_id };
  }

  private prune() {
    const now = Date.now();
    this.database.query("DELETE FROM navigation_handoffs WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
    const count = (this.database.query("SELECT COUNT(*) AS count FROM navigation_handoffs").get() as { count: number }).count;
    if (count > MAX_HANDOFFS) {
      this.database.query(`
        DELETE FROM navigation_handoffs
        WHERE handoff_hash IN (
          SELECT handoff_hash FROM navigation_handoffs
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(count - MAX_HANDOFFS);
    }
  }
}
