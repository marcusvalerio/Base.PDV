import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = DatabaseSync;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: DB): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    tx(db, () => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, now());
    });
    ran.push(f);
  }
  return ran;
}

let depth = 0;
/** Executa fn em uma transação (BEGIN IMMEDIATE). Suporta aninhamento via savepoints. */
export function tx<T>(db: DB, fn: () => T): T {
  const sp = `sp${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    if (depth === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function audit(db: DB, userId: number | null, action: string, entity?: string, entityId?: number | bigint | null, details?: unknown) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details_json, at) VALUES (?,?,?,?,?,?)').run(
    userId, action, entity ?? null, entityId == null ? null : Number(entityId), details === undefined ? null : JSON.stringify(details), now(),
  );
}
