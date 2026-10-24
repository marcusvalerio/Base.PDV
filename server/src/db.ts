import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acesso ao PostgreSQL (Neon em produção; PGlite em memória nos testes).
 * Os serviços usam "?" como marcador; é convertido para $1, $2… aqui.
 */
export interface DB {
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows: any[] }>;
  exec(sql: string): Promise<void>;
  /** Transação; chamadas aninhadas viram SAVEPOINT. */
  tx<T>(fn: (t: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Converte "?" em $n, ignorando trechos entre aspas simples. */
export function toPg(sql: string): string {
  let n = 0, out = '', q = false;
  for (const ch of sql) {
    if (ch === "'") q = !q;
    out += ch === '?' && !q ? `$${++n}` : ch;
  }
  return out;
}

// BIGINT e NUMERIC como number (valores do sistema cabem com folga em 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

type Querier = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null; affectedRows?: number }> };

function wrap(q: Querier, txFn: DB['tx'], close: () => Promise<void>, execFn: (sql: string) => Promise<void>): DB {
  const query = async (sql: string, params: unknown[] = []) => {
    const r = await q.query(toPg(sql), params);
    return { rows: r.rows, rowCount: (r.rowCount ?? r.affectedRows ?? 0) as number };
  };
  return {
    all: async (s, p) => (await query(s, p)).rows,
    one: async (s, p) => (await query(s, p)).rows[0],
    run: query,
    exec: execFn,
    tx: txFn,
    close,
  };
}

function txOn(q: Querier, depth: number, execFn: (sql: string) => Promise<void>): DB['tx'] {
  return async (fn) => {
    const sp = `sp${depth}`;
    await q.query(`SAVEPOINT ${sp}`);
    const inner = wrap(q, txOn(q, depth + 1, execFn), async () => {}, execFn);
    try {
      const r = await fn(inner);
      await q.query(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      await q.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw e;
    }
  };
}

/** Banco real (Neon) via pool de conexões. */
export function pgDb(connectionString: string): DB {
  const pool = new pg.Pool({ connectionString: connectionString.replace(/([?&])sslmode=(require|prefer|verify-ca)/, '$1sslmode=verify-full'), max: Number(process.env.DB_POOL_MAX || 10), ssl: /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: true } });
  const execFn = async (sql: string) => { await pool.query(sql); };
  const tx: DB['tx'] = async (fn) => {
    const client = await pool.connect();
    const cExec = async (sql: string) => { await client.query(sql); };
    try {
      await client.query('BEGIN');
      const r = await fn(wrap(client, txOn(client, 0, cExec), async () => {}, cExec));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  return wrap(pool, tx, () => pool.end(), execFn);
}

/** Postgres em memória (PGlite) para testes e demonstração local, sem rede. Uma conexão: transações são serializadas. */
export async function memoryDb(): Promise<DB> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite({ parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) } });
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const raw: Querier = { query: (s, p) => lite.query(s, p as any[]) as any };
  const execRaw = async (sql: string) => { await lite.exec(sql); };
  const locked: Querier = { query: (s, p) => lock(() => raw.query(s, p)) };
  const tx: DB['tx'] = (fn) => lock(async () => {
    await raw.query('BEGIN');
    try {
      const r = await fn(wrap(raw, txOn(raw, 0, execRaw), async () => {}, execRaw));
      await raw.query('COMMIT');
      return r;
    } catch (e) {
      await raw.query('ROLLBACK');
      throw e;
    }
  });
  return wrap(locked, tx, () => lite.close(), (sql) => lock(() => execRaw(sql)));
}

/**
 * Corrige erros comuns ao colar a string de conexão (ex.: "DATABASE_URL=...", aspas, comando "psql '...'")
 * e valida o formato, sem nunca expor a senha em mensagens.
 */
export function cleanDatabaseUrl(raw: string): string {
  let v = raw.trim();
  v = v.replace(/^DATABASE_URL\s*=\s*/i, '').replace(/^psql\s+/i, '').trim();
  v = v.replace(/^['"]|['"]$/g, '').trim();
  let u: URL;
  try { u = new URL(v); } catch { throw new Error('DATABASE_URL inválida: deve começar com postgresql:// (copie de Neon > Connect).'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL inválida: deve começar com postgresql://');
  if (!u.hostname.includes('.')) throw new Error(`DATABASE_URL inválida: servidor "${u.hostname}" não parece um endereço do Neon. Recopie a string completa.`);
  console.log(`Banco: ${u.hostname}/${u.pathname.slice(1)} (usuário ${decodeURIComponent(u.username)})`);
  return v;
}

export async function openDb(url = process.env.DATABASE_URL): Promise<DB> {
  const db = url && url !== 'memory' ? pgDb(cleanDatabaseUrl(url)) : await memoryDb();
  await migrate(db);
  return db;
}

export async function migrate(db: DB): Promise<string[]> {
  return db.tx(async (t) => {
    // Evita duas instâncias migrando ao mesmo tempo.
    await t.exec('SELECT pg_advisory_xact_lock(4242001)');
    await t.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((await t.all<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
    const ran: string[] = [];
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      if (applied.has(f)) continue;
      await t.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      await t.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [f, now()]);
      ran.push(f);
    }
    return ran;
  });
}

export const tx = <T>(db: DB, fn: (t: DB) => Promise<T>) => db.tx(fn);

export function now(): string {
  return new Date().toISOString();
}

/** Código de violação de unicidade do Postgres. */
export const isUniqueViolation = (e: any, constraint?: string) => e?.code === '23505' && (!constraint || String(e.constraint ?? e.detail ?? e.message).includes(constraint));

export async function audit(db: DB, userId: number | null, action: string, entity?: string | null, entityId?: number | null, details?: unknown) {
  await db.run('INSERT INTO audit_log (user_id, action, entity, entity_id, details_json, at) VALUES (?,?,?,?,?,?)', [
    userId, action, entity ?? null, entityId == null ? null : Number(entityId), details === undefined ? null : JSON.stringify(details), now(),
  ]);
}
