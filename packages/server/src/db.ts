import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const dataDir = process.env.POINTWISE_DATA_DIR ?? join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(join(dataDir, 'pointwise.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  return db;
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id      TEXT PRIMARY KEY,
      event_type    TEXT NOT NULL,
      event_version INTEGER NOT NULL,
      session_id    TEXT NOT NULL,
      client_ts     INTEGER NOT NULL,
      received_ts   INTEGER NOT NULL,
      payload       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, client_ts);

    CREATE TABLE IF NOT EXISTS rejected_events (
      rejection_id  TEXT PRIMARY KEY,
      event_id      TEXT,
      received_ts   INTEGER NOT NULL,
      reasons       TEXT NOT NULL
    );
  `);
}

export function resetDbForTest(): void {
  if (db) {
    db.exec('DELETE FROM events; DELETE FROM rejected_events;');
  }
}
