import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../logger.js';
import { runMigrations } from './migrations.js';

/** A better-sqlite3 connection. */
export type Db = Database.Database;

/**
 * Open (creating if needed) the PalSentry database and bring its schema up to date.
 *
 * Pragmas worth explaining:
 * - `journal_mode = WAL` lets the metrics poller write while the UI reads, with no reader
 *   blocking. This is the main reason SQLite is sufficient here.
 * - `synchronous = NORMAL` is the recommended pairing with WAL: durable across process crashes,
 *   and only at risk from an OS-level power loss. Monitoring samples are not worth the extra
 *   fsync per write.
 * - `busy_timeout` makes concurrent writers wait rather than immediately throwing SQLITE_BUSY.
 */
export function openDatabase(dbPath: string, logger: Logger): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db, logger);

  logger.debug({ dbPath }, 'Database ready');
  return db;
}
