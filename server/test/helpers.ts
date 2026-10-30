import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { memoryDb, migrate, schemaDb, withSchema } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { setSetting } from '../src/services/settings.js';
import { hashSecret } from '../src/security.js';
import { setModules, MODULES } from '../src/services/modules.js';
import { createTenant, createPlatformAdmin, reserveUsername } from '../src/services/platform.js';

export const PASS = 'senha-de-teste-123';
export const CODE = '4321';
export const CANCEL = '9090';

/** Plataforma em memória com um estabelecimento (isento de assinatura), admin "admin", operadora "op" e admin central "super". */
export async function setup(opts: { modules?: boolean; fetch?: any } = {}) {
  const base = await memoryDb();
  await migrate(base);
  const app = createApp(base, { fetch: opts.fetch });
  const tenantId = await createTenant(base, { name: 'Loja Teste', admin: { name: 'Admin Teste', username: 'admin', password: PASS }, exempt: true,
    modules: Object.fromEntries(Object.keys(MODULES).map((k) => [k, opts.modules !== false])) }, null);
  const schema = `t_${tenantId}`;
  const db = schemaDb(base, schema);
  const adminId = (await db.one("SELECT id FROM users WHERE username = 'admin'")).id as number;
  await reserveUsername(base, 'op', tenantId);
  const opId = await withSchema(base, schema, async (t) => {
    const id = await createUser(t, { name: 'Operadora Teste', username: 'op', password: PASS, role: 'OPERADOR' }, adminId);
    await setSetting(t, 'shared_cash_code_hash', hashSecret(CODE), adminId);
    await setSetting(t, 'cancel_code_hash', hashSecret(CANCEL), adminId);
    return id;
  });
  await createPlatformAdmin(base, { name: 'Super Teste', username: 'super', password: PASS });
  const admin = await agent(app, 'admin');
  const op = await agent(app, 'op');
  return { db, base, app, admin, op, adminId, opId, tenantId, schema };
}

export type Client = ReturnType<typeof wrap>;

function wrap(app: any, cookie: string) {
  const h = (r: request.Test) => r.set('Cookie', cookie).set('X-Requested-With', 'pdv');
  return {
    get: (u: string) => h(request(app).get(u)),
    post: (u: string, b?: any) => h(request(app).post(u)).send(b ?? {}),
    patch: (u: string, b?: any) => h(request(app).patch(u)).send(b ?? {}),
    put: (u: string, b?: any) => h(request(app).put(u)).send(b ?? {}),
    del: (u: string) => h(request(app).delete(u)),
  };
}

export async function agent(app: any, username: string, central = false) {
  const res = await request(app).post(central ? '/api/central/login' : '/api/auth/login').set('X-Requested-With', 'pdv').send({ username, password: PASS });
  if (res.status !== 200) throw new Error('login falhou: ' + JSON.stringify(res.body));
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return wrap(app, cookie);
}

export const key = () => randomUUID();

export async function product(c: Client, over: Record<string, any> = {}) {
  const res = await c.post('/api/products', { name: 'Cerveja Lata', category_id: 1, unit: 'UN', price_cents: 600, cost_cents: 350, initial_stock_milli: 50000, min_stock_milli: 10000, ...over });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.id as number;
}

export async function openCash(c: Client, float = 10000) {
  const r = await c.post('/api/cash/open', { code: CODE, openingFloatCents: float });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.id as number;
}
