import { Database } from "bun:sqlite";

/** Open every store with the same bounded single-node SQLite policy. */
export const openWayMemoryDatabase = (path: string) => {
  const database = new Database(path);
  database.exec(`
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 256;
    PRAGMA journal_size_limit = 4194304;
  `);
  return database;
};
