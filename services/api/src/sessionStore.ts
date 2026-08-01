import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ObservationSession, SensorSample } from "@way-memory/contracts";
import { openWayMemoryDatabase } from "./database";

export type SessionSnapshot = {
  session: ObservationSession;
  rawSamples: SensorSample[];
};

/** Bounded durable snapshots for the single-node deployment. */
export class SessionStore {
  private readonly database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = openWayMemoryDatabase(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        session_json TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_snapshots_updated_at
        ON session_snapshots(updated_at DESC);
    `);
  }

  save(session: ObservationSession, rawSamples: SensorSample[]) {
    const now = new Date().toISOString();
    this.database.query(`
      INSERT INTO session_snapshots(session_id, started_at, updated_at, status, session_json, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        status = excluded.status,
        session_json = excluded.session_json,
        raw_json = excluded.raw_json
    `).run(
      session.sessionId,
      session.startedAt,
      now,
      session.status,
      JSON.stringify(session),
      JSON.stringify(rawSamples),
    );
  }

  load(limit: number, retainedAfterIso?: string): SessionSnapshot[] {
    const query = retainedAfterIso
      ? this.database.query(`
        SELECT session_json, raw_json
        FROM session_snapshots
        WHERE updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(retainedAfterIso, limit)
      : this.database.query(`
        SELECT session_json, raw_json
        FROM session_snapshots
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit);
    const rows = query as Array<{ session_json: string; raw_json: string }>;
    return rows.flatMap((row) => {
      try {
        const session = JSON.parse(row.session_json) as ObservationSession;
        const rawSamples = JSON.parse(row.raw_json) as SensorSample[];
        if (!session.sessionId || !Array.isArray(rawSamples)) return [];
        return [{ session, rawSamples }];
      } catch {
        return [];
      }
    });
  }

  delete(sessionId: string) {
    const result = this.database.query("DELETE FROM session_snapshots WHERE session_id = ?").run(sessionId);
    this.database.exec("PRAGMA incremental_vacuum(64)");
    return result.changes > 0;
  }

  prune(maxSessions: number, retainedAfterIso?: string) {
    if (retainedAfterIso) {
      this.database.query("DELETE FROM session_snapshots WHERE updated_at < ?").run(retainedAfterIso);
    }
    this.database.query(`
      DELETE FROM session_snapshots
      WHERE session_id NOT IN (
        SELECT session_id FROM session_snapshots
        ORDER BY updated_at DESC
        LIMIT ?
      )
    `).run(maxSessions);
    this.database.exec("PRAGMA incremental_vacuum(64)");
  }
}
