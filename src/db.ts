import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { hashPassword } from './auth.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;
  const file = path.resolve(config.dbPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  init(db);
  return db;
}

function init(d: Database.Database): void {
  d.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS draft_cues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sort_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS draft_cue_positions (
    cue_id INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
    position_id INTEGER NOT NULL REFERENCES positions(id),
    PRIMARY KEY (cue_id, position_id)
  );

  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS version_cues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL REFERENCES versions(id),
    sort_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    position_names TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    version_id INTEGER NOT NULL REFERENCES versions(id),
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',          -- open | completed
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    role TEXT NOT NULL,                          -- director | station
    position_id INTEGER,
    show_id INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL REFERENCES shows(id),
    cue_id INTEGER NOT NULL,                     -- 指向 version_cues.id
    position_name TEXT NOT NULL,
    seq INTEGER NOT NULL,                        -- 场内事件序号
    at INTEGER NOT NULL,
    UNIQUE (show_id, cue_id, position_name)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL REFERENCES shows(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    cue_id INTEGER,
    position_name TEXT,
    detail TEXT NOT NULL DEFAULT '',
    UNIQUE (show_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_version_cues_v ON version_cues(version_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_draft_cues_o ON draft_cues(sort_order);
  CREATE INDEX IF NOT EXISTS idx_confirm_show ON confirmations(show_id, cue_id);
  CREATE INDEX IF NOT EXISTS idx_events_show ON events(show_id, seq);
  `);

  // 首次启动：写入导演口令
  const meta = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get() as
    | { name: string }
    | undefined;
  if (!meta) {
    d.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const { hash, salt } = hashPassword(config.directorPassword);
    d.prepare(`INSERT INTO app_meta(key, value) VALUES ('director_hash', ?), ('director_salt', ?)`).run(
      hash,
      salt,
    );
  }
}

export function getDirectorCredentials(): { hash: string; salt: string } {
  const d = getDb();
  const rows = d.prepare(`SELECT key, value FROM app_meta WHERE key IN ('director_hash','director_salt')`).all() as {
    key: string;
    value: string;
  }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return { hash: map.get('director_hash')!, salt: map.get('director_salt')! };
}

export function setDirectorPassword(password: string): void {
  const d = getDb();
  const { hash, salt } = hashPassword(password);
  const stmt = d.prepare(`INSERT INTO app_meta(key,value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  stmt.run('director_hash', hash);
  stmt.run('director_salt', salt);
}
