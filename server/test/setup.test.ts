import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { memoryDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { setup as fullSetup } from './helpers.js';

const post = (app: any, body: any) => request(app).post('/api/setup').set('X-Requested-With', 'pdv').send(body);
const body = { token: 'token-secreto-123', name: 'Dono Teste', username: 'dono', password: 'senha-forte-123' };

describe('configuração inicial', () => {
  afterEach(() => { delete process.env.SETUP_TOKEN; });

  it('cria o primeiro super admin só com o token e só uma vez', async () => {
    const db = await memoryDb(); await migrate(db);
    const app = createApp(db);
    expect((await request(app).get('/api/setup/status')).body).toEqual({ needed: true, enabled: false });
    expect((await post(app, body)).status).toBe(403);
    process.env.SETUP_TOKEN = 'token-secreto-123';
    expect((await post(app, { ...body, token: 'errado-errado-123' })).status).toBe(403);
    expect((await post(app, body)).status).toBe(201);
    expect((await post(app, { ...body, username: 'outro' })).status).toBe(403);
    expect((await request(app).get('/api/setup/status')).body.needed).toBe(false);
    const login = await request(app).post('/api/auth/login').set('X-Requested-With', 'pdv').send({ username: 'dono', password: body.password });
    expect(login.body.user.superAdmin).toBe(true);
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
