import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { setSetting } from '../src/services/settings.js';
import { hashSecret } from '../src/security.js';

export const PASS = 'senha-de-teste-123';
export const CODE = '4321';

export async function setup() {
  const db = openDb(':memory:');
  const app = createApp(db);
  const adminId = createUser(db, { name: 'Admin Teste', username: 'admin', password: PASS, role: 'ADMIN' }, null);
  const opId = createUser(db, { name: 'Operadora Teste', username: 'op', password: PASS, role: 'OPERADOR' }, adminId);
  setSetting(db, 'shared_cash_code_hash', hashSecret(CODE), adminId);
  const admin = await agent(app, 'admin');
  const op = await agent(app, 'op');
  return { db, app, admin, op, adminId, opId };
}

export type Client = ReturnType<typeof wrap>;

function wrap(app: any, cookie: string) {
  const h = (r: request.Test) => r.set('Cookie', cookie).set('X-Requested-With', 'pdv');
  return {
    get: (u: string) => h(request(app).get(u)),
    post: (u: string, b?: any) => h(request(app).post(u)).send(b ?? {}),
    patch: (u: string, b?: any) => h(request(app).patch(u)).send(b ?? {}),
    put: (u: string, b?: any) => h(request(app).put(u)).send(b ?? {}),
  };
}

export async function agent(app: any, username: string) {
  const res = await request(app).post('/api/auth/login').set('X-Requested-With', 'pdv').send({ username, password: PASS });
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
