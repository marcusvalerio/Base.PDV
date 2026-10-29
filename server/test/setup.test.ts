import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { memoryDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { setup as fullSetup } from './helpers.js';

const post = (app: any, body: any) => request(app).post('/api/central/setup').set('X-Requested-With', 'pdv').send(body);
const body = { token: 'token-secreto-123', name: 'Dono Teste', username: 'dono', password: 'senha-forte-123' };

describe('configuração inicial', () => {
  afterEach(() => { delete process.env.SETUP_TOKEN; });

  it('cria o primeiro admin central só com o token e só uma vez', async () => {
    const db = await memoryDb(); await migrate(db);
    const app = createApp(db);
    expect((await request(app).get('/api/central/setup-status')).body).toEqual({ needed: true, enabled: false });
    expect((await post(app, body)).status).toBe(403);
    process.env.SETUP_TOKEN = 'token-secreto-123';
    expect((await post(app, { ...body, token: 'errado-errado-123' })).status).toBe(403);
    expect((await post(app, body)).status).toBe(201);
    expect((await post(app, { ...body, username: 'outro' })).status).toBe(403);
    expect((await request(app).get('/api/central/setup-status')).body.needed).toBe(false);
    const login = await request(app).post('/api/central/login').set('X-Requested-With', 'pdv').send({ username: 'dono', password: body.password });
    expect(login.body.admin.username).toBe('dono');
  });

  it('não funciona em sistema já configurado', async () => {
    process.env.SETUP_TOKEN = 'token-secreto-123';
    const { app } = await fullSetup();
    expect((await post(app, body)).status).toBe(403);
  });
});

import { cleanDatabaseUrl } from '../src/db.js';
describe('DATABASE_URL', () => {
  const ok = 'postgresql://u:p@ep-x-pooler.c-2.sa-east-1.aws.neon.tech/pdv?sslmode=require';
  it('aceita colagens comuns', () => {
    expect(cleanDatabaseUrl(ok)).toBe(ok);
    expect(cleanDatabaseUrl(`DATABASE_URL=${ok}`)).toBe(ok);
    expect(cleanDatabaseUrl(`"${ok}"`)).toBe(ok);
    expect(cleanDatabaseUrl(`psql '${ok}'`)).toBe(ok);
  });
  it('recusa endereço quebrado sem mostrar a senha', () => {
    expect(() => cleanDatabaseUrl('postgresql://u:segredo@base/pdv')).toThrow(/"base"/);
    try { cleanDatabaseUrl('postgresql://u:segredo@base/pdv'); } catch (e: any) { expect(e.message).not.toMatch(/segredo/); }
    expect(() => cleanDatabaseUrl('basepdv')).toThrow(/postgresql:\/\//);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashSecret } from '../src/security.js';
describe('instalação antiga (um estabelecimento no schema public)', () => {
  it('vira o estabelecimento nº 1 sem perder dados; super admin vira admin central', async () => {
    const db = await memoryDb();
    const dir = join(import.meta.dirname, '../src/migrations');
    await db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
      await db.run('INSERT INTO schema_migrations VALUES (?, ?)', [f, 'x']);
    }
    const t = new Date().toISOString();
    await db.run("INSERT INTO users (name, username, password_hash, role, is_super_admin, created_at, updated_at) VALUES ('Dono', 'marcus.admin', ?, 'ADMIN', 1, ?, ?)", [hashSecret('senha-forte-123'), t, t]);
    await db.run("INSERT INTO users (name, username, password_hash, role, created_at, updated_at) VALUES ('Caixa', 'teste.caixa1', ?, 'OPERADOR', ?, ?)", [hashSecret('senha-forte-123'), t, t]);
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('store_name', 'Bar Antigo', ?)", [t]);
    await db.run("INSERT INTO products (name, category_id, unit, price_cents, created_at, updated_at) VALUES ('Cerveja', 1, 'UN', 600, ?, ?)", [t, t]);
    const ran = await migrate(db);
    expect(ran).toContain('legacy -> t_1');
    expect((await migrate(db))).toEqual([]);
    const app = createApp(db);
    const login = (u: string, path = '/api/auth/login') => request(app).post(path).set('X-Requested-With', 'pdv').send({ username: u, password: 'senha-forte-123' });
    const caixa = await login('teste.caixa1');
    expect(caixa.status).toBe(200);
    const cookie = (caixa.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    expect(cookie).toMatch(/^pdv_session=1\./);
    const prods = await request(app).get('/api/products').set('Cookie', cookie);
    expect(prods.body.map((p: any) => p.name)).toEqual(['Cerveja']);
    expect((await login('marcus.admin', '/api/central/login')).status).toBe(200);
    expect((await login('marcus.admin')).status).toBe(200);
    const tenant = await db.one('SELECT * FROM tenants WHERE id = 1');
    expect(tenant.name).toBe('Bar Antigo');
    expect(tenant.billing_exempt).toBe(1);
  });
});

describe('saúde e cópia de segurança', () => {
  it('health responde; backup só para o admin central e sem sessões', async () => {
    const { app, tenantId, admin } = await import('./helpers.js').then((h) => h.setup());
    expect((await request(app).get('/api/health')).body.ok).toBe(true);
    expect((await admin.get(`/api/central/tenants/${tenantId}/backup`)).status).toBe(401);
    const { agent } = await import('./helpers.js');
    const sup = await agent(app, 'super', true);
    const b = await sup.get(`/api/central/tenants/${tenantId}/backup`);
    expect(b.status).toBe(200);
    expect(b.headers['content-disposition']).toContain('attachment');
    expect(b.body.tables.users.length).toBeGreaterThan(0);
    expect(b.body.tables.sessions).toBeUndefined();
    expect(b.body.tables.payment_methods.length).toBeGreaterThan(0);
  });
});
