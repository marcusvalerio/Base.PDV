import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** Conexão presa ao schema de um estabelecimento (search_path). Só existe no banco base. */
  scope?(schema: string): Promise<{ db: DB; release: () => Promise<void> }>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const PLATFORM_DIR = join(MIGRATIONS_DIR, 'platform');

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

/**
 * O endereço "-pooler" do Neon (PgBouncer em modo transação) pode mandar cada consulta para uma conexão diferente,
 * e o search_path do estabelecimento se perde ("relation ... does not exist"). Usa sempre o endereço direto.
 */
export function directUrl(url: string): string {
  return url.replace(/(@[^/:?]*?)-pooler\./, '$1.');
}

/** Banco real (Neon) via pool de conexões. */
export function pgDb(rawUrl: string): DB {
  const connectionString = directUrl(rawUrl);
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
  const base = wrap(pool, tx, () => pool.end(), execFn);
  base.scope = async (schema: string) => {
    const client = await pool.connect();
    await client.query("SELECT set_config('search_path', $1, false)", [searchPath(schema)]);
    const cExec = async (sql: string) => { await client.query(sql); };
    const ctx: DB['tx'] = async (fn) => {
      await client.query('BEGIN');
      try {
        const r = await fn(wrap(client, txOn(client, 0, cExec), async () => {}, cExec));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    };
    let done = false;
    return {
      db: wrap(client, ctx, async () => {}, cExec),
      release: async () => {
        if (done) return;
        done = true;
        try { await client.query('RESET search_path'); client.release(); } catch (e) { client.release(e as Error); }
      },
    };
  };
  return base;
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
  const base = wrap(locked, tx, () => lite.close(), (sql) => lock(() => execRaw(sql)));
  base.scope = async (schema: string) => {
    // Uma só conexão: cada operação define o search_path dentro da mesma trava.
    const sp = searchPath(schema);
    const setSp = () => raw.query("SELECT set_config('search_path', $1, false)", [sp]);
    const q: Querier = { query: (s, p) => lock(async () => { await setSp(); return raw.query(s, p); }) };
    const ex = (sql: string) => lock(async () => { await setSp(); await execRaw(sql); });
    const stx: DB['tx'] = (fn) => lock(async () => {
      await setSp();
      await raw.query('BEGIN');
      try {
        const r = await fn(wrap(raw, txOn(raw, 0, execRaw), async () => {}, execRaw));
        await raw.query('COMMIT');
        return r;
      } catch (e) {
        await raw.query('ROLLBACK');
        throw e;
      } finally {
        await raw.query("SELECT set_config('search_path', 'public', false)");
      }
    });
    return { db: wrap(q, stx, async () => {}, ex), release: async () => {} };
  };
  return base;
}

const SCHEMA_RE = /^t_\d{1,9}$/;
function searchPath(schema: string) {
  if (!SCHEMA_RE.test(schema)) throw new Error('Schema inválido.');
  return `"${schema}", public`;
}

/** Estabelecimento da requisição atual (definido pelo middleware de sessão). */
export const tenantStore = new AsyncLocalStorage<{ db: DB }>();

/** Banco que usa automaticamente a conexão do estabelecimento da requisição atual; sem estabelecimento, usa o base (schema public). */
export function tenantAware(base: DB): DB {
  const cur = () => tenantStore.getStore()?.db ?? base;
  return {
    all: (s, p) => cur().all(s, p),
    one: (s, p) => cur().one(s, p),
    run: (s, p) => cur().run(s, p),
    exec: (s) => cur().exec(s),
    tx: (fn) => cur().tx(fn),
    close: () => base.close(),
  };
}

/** Executa fn com o banco preso ao schema do estabelecimento (e o torna o "atual" para os serviços). */
export async function withSchema<T>(base: DB, schema: string, fn: (db: DB) => Promise<T>): Promise<T> {
  const h = await base.scope!(schema);
  try { return await tenantStore.run({ db: h.db }, () => fn(h.db)); } finally { await h.release(); }
}

/** DB de um estabelecimento em que cada chamada abre e fecha o próprio escopo (scripts, testes, painel central). */
export function schemaDb(base: DB, schema: string): DB {
  return {
    all: (s, p) => withSchema(base, schema, (d) => d.all(s, p)),
    one: (s, p) => withSchema(base, schema, (d) => d.one(s, p)),
    run: (s, p) => withSchema(base, schema, (d) => d.run(s, p)),
    exec: (s) => withSchema(base, schema, (d) => d.exec(s)),
    tx: (fn) => withSchema(base, schema, (d) => d.tx(fn)),
    close: async () => {},
  };
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

const sqlFiles = (dir: string) => readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();

/** Aplica as migrações do estabelecimento no schema atual (search_path já definido). */
async function migrateTenantSchema(t: DB): Promise<string[]> {
  await t.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((await t.all<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const ran: string[] = [];
  for (const f of sqlFiles(MIGRATIONS_DIR)) {
    if (applied.has(f)) continue;
    await t.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await t.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [f, now()]);
    ran.push(f);
  }
  return ran;
}

/** Cria (se preciso) e atualiza o schema de um estabelecimento. */
export async function migrateTenant(base: DB, schema: string): Promise<string[]> {
  searchPath(schema);
  await base.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  return withSchema(base, schema, (d) => d.tx(async (t) => {
    await t.exec('SELECT pg_advisory_xact_lock(4242002)');
    return migrateTenantSchema(t);
  }));
}

/**
 * Migrações: primeiro a plataforma (schema public: estabelecimentos, admin central, assinaturas),
 * depois o schema de cada estabelecimento. Instalações antigas (tudo no public) viram o estabelecimento nº 1.
 */
export async function migrate(base: DB): Promise<string[]> {
  const ran = await base.tx(async (t) => {
    await t.exec('SELECT pg_advisory_xact_lock(4242001)');
    const legacy = !!(await t.one("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'"))
      && !(await t.one("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenants'"));
    if (legacy) {
      // Move as tabelas do sistema antigo (um estabelecimento só) para o schema t_1, sem apagar nada.
      await t.exec('CREATE SCHEMA IF NOT EXISTS t_1');
      for (const { tablename } of await t.all<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")) {
        await t.exec(`ALTER TABLE public."${tablename}" SET SCHEMA t_1`);
      }
    }
    await t.exec('CREATE TABLE IF NOT EXISTS platform_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((await t.all<{ name: string }>('SELECT name FROM platform_migrations')).map((r) => r.name));
    const out: string[] = [];
    for (const f of sqlFiles(PLATFORM_DIR)) {
      if (applied.has(f)) continue;
      await t.exec(readFileSync(join(PLATFORM_DIR, f), 'utf8'));
      await t.run('INSERT INTO platform_migrations (name, applied_at) VALUES (?, ?)', [f, now()]);
      out.push('platform/' + f);
    }
    if (legacy) {
      const name = (await t.one("SELECT value FROM t_1.settings WHERE key = 'store_name'"))?.value || 'Estabelecimento 1';
      await t.run("INSERT INTO tenants (id, name, schema_name, billing_exempt, created_at) OVERRIDING SYSTEM VALUE VALUES (1, ?, 't_1', 1, ?)", [name, now()]);
      await t.exec("SELECT setval(pg_get_serial_sequence('tenants', 'id'), 1)");
      await t.exec('INSERT INTO user_directory (username_lower, tenant_id) SELECT lower(username), 1 FROM t_1.users ON CONFLICT DO NOTHING');
      // Super administradores antigos viram administradores centrais (mesma senha).
      await t.run(`INSERT INTO platform_admins (name, username, password_hash, active, created_at)
        SELECT name, username, password_hash, 1, ? FROM t_1.users WHERE is_super_admin = 1 ON CONFLICT DO NOTHING`, [now()]);
      out.push('legacy -> t_1');
    }
    return out;
  });
  for (const { schema_name } of await base.all<{ schema_name: string }>('SELECT schema_name FROM tenants ORDER BY id')) {
    ran.push(...(await migrateTenant(base, schema_name)).map((f) => `${schema_name}/${f}`));
  }
  return ran;
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
