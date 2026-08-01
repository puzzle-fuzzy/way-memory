import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWayMemoryDatabase } from "../services/api/src/database";

type PragmaRow = Record<string, number | string>;

const temporaryDirectory = mkdtempSync(join(tmpdir(), "way-memory-storage-"));
const database = openWayMemoryDatabase(join(temporaryDirectory, "check.sqlite"));

try {
  const journalMode = database.query("PRAGMA journal_mode").get() as PragmaRow;
  const synchronous = database.query("PRAGMA synchronous").get() as PragmaRow;
  const busyTimeout = database.query("PRAGMA busy_timeout").get() as PragmaRow;
  const walAutoCheckpoint = database.query("PRAGMA wal_autocheckpoint").get() as PragmaRow;
  const journalSizeLimit = database.query("PRAGMA journal_size_limit").get() as PragmaRow;
  const autoVacuum = database.query("PRAGMA auto_vacuum").get() as PragmaRow;

  const actual = {
    journalMode: journalMode.journal_mode,
    synchronous: synchronous.synchronous,
    busyTimeout: busyTimeout.timeout,
    walAutoCheckpoint: walAutoCheckpoint.wal_autocheckpoint,
    journalSizeLimit: journalSizeLimit.journal_size_limit,
    autoVacuum: autoVacuum.auto_vacuum,
  };
  const expected = {
    journalMode: "wal",
    synchronous: 1,
    busyTimeout: 5000,
    walAutoCheckpoint: 256,
    journalSizeLimit: 4 * 1024 * 1024,
    autoVacuum: 2,
  };

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SQLite bounded-storage policy mismatch: ${JSON.stringify({ actual, expected })}`);
  }

  console.log("Storage smoke passed", actual);
} finally {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
