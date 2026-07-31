import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { RouteSummary } from "@way-memory/contracts";

export type StoredRoute = RouteSummary & { ownerId: string };

/** Durable, owner-scoped route registry. Track windows remain bounded by the API. */
export class RouteStore {
  private readonly database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS route_records (
        route_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        route_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS route_records_owner_updated
        ON route_records(owner_id, updated_at DESC);
    `);
  }

  save(route: StoredRoute) {
    this.database.query(`
      INSERT INTO route_records(route_id, owner_id, updated_at, route_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(route_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        updated_at = excluded.updated_at,
        route_json = excluded.route_json
    `).run(route.routeId, route.ownerId, route.updatedAt, JSON.stringify(route));
  }

  list(ownerId: string, limit: number): StoredRoute[] {
    return this.loadRows(this.database.query(`
      SELECT route_json
      FROM route_records
      WHERE owner_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(ownerId, limit) as Array<{ route_json: string }>);
  }

  load(limit: number): StoredRoute[] {
    return this.loadRows(this.database.query(`
      SELECT route_json
      FROM route_records
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ route_json: string }>);
  }

  delete(ownerId: string, routeId: string) {
    const result = this.database.query("DELETE FROM route_records WHERE route_id = ? AND owner_id = ?").run(routeId, ownerId);
    return result.changes > 0;
  }

  prune(maxRoutes: number) {
    this.database.query(`
      DELETE FROM route_records
      WHERE route_id NOT IN (
        SELECT route_id FROM route_records
        ORDER BY updated_at DESC
        LIMIT ?
      )
    `).run(maxRoutes);
  }

  private loadRows(rows: Array<{ route_json: string }>) {
    return rows.flatMap((row) => {
      try {
        const route = JSON.parse(row.route_json) as StoredRoute;
        if (!route.routeId || !route.ownerId || !Array.isArray(route.track) || !Array.isArray(route.poseTrack) || !Array.isArray(route.observationSummaries)) return [];
        return [route];
      } catch {
        return [];
      }
    });
  }
}
