import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup, PASS } from './helpers.js';

describe('autenticação e permissões', () => {
  it('rejeita senha errada e aceita a correta', async () => {
    const { app } = await setup();
    const bad = await request(app).post('/api/auth/login').set('X-Requested-With', 'pdv').send({ username: 'op', password: 'errada' });
    expect(bad.status).toBe(401);
    const ok = await request(app).post('/api/auth/login').set('X-Requested-With', 'pdv').send({ username: 'op', password: PASS });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('OPERADOR');
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  it('bloqueia rotas sem login', async () => {
    const { app } = await setup();
    expect((await request(app).get('/api/products')).status).toBe(401);
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
  });

  it('exige cabeçalho anti-CSRF em operações de escrita', async () => {
    const { app } = await setup();
    const r = await request(app).post('/api/auth/login').send({ username: 'op', password: PASS });
    expect(r.status).toBe(403);
  });

  it('operador não acessa APIs administrativas', async () => {
    const { op } = await setup();
    for (const path of ['/api/dashboard', '/api/analytics', '/api/users', '/api/settings', '/api/cash', '/api/audit', '/api/restock', '/api/stock/movements']) {
      expect((await op.get(path)).status, path).toBe(403);
    }
    expect((await op.post('/api/products', { name: 'x', category_id: 1, unit: 'UN', price_cents: 1 })).status).toBe(403);
    expect((await op.put('/api/settings', { fiado_surcharge_cents: 0 })).status).toBe(403);
    expect((await op.post('/api/users', { name: 'Hacker', username: 'hack', password: '12345678', role: 'ADMIN' })).status).toBe(403);
    expect((await op.post('/api/stock/adjustments', { productId: 1, qtyMilli: 1000, type: 'ADJUST', reason: 'teste' })).status).toBe(403);
  });

  it('operador não vê custo dos produtos', async () => {
    const { admin, op } = await setup();
    await admin.post('/api/products', { name: 'Item', category_id: 1, unit: 'UN', price_cents: 500, cost_cents: 200 });
    const list = (await op.get('/api/products')).body;
    expect(list[0].cost_cents).toBeUndefined();
    expect((await admin.get('/api/products')).body[0].cost_cents).toBe(200);
  });

  it('usuário bloqueado perde a sessão imediatamente', async () => {
    const { admin, op, opId } = await setup();
    expect((await op.get('/api/auth/me')).status).toBe(200);
    expect((await admin.patch(`/api/users/${opId}`, { active: false })).status).toBe(200);
    expect((await op.get('/api/auth/me')).status).toBe(401);
  });

  it('administrador não pode bloquear a si mesmo', async () => {
    const { admin, adminId } = await setup();
    expect((await admin.patch(`/api/users/${adminId}`, { active: false })).status).toBe(400);
  });

  it('não expõe hash do código de caixa nas configurações', async () => {
    const { admin } = await setup();
    const s = (await admin.get('/api/settings')).body;
    expect(JSON.stringify(s)).not.toMatch(/scrypt/);
    expect(s.shared_cash_code_configured).toBe(true);
  });
});
