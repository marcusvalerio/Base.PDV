import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup, agent, key, product, openCash, PASS } from './helpers.js';

describe('liberação de módulos (admin central)', () => {
  it('módulos bloqueados só o admin central libera, por estabelecimento', async () => {
    const { app, admin, op, tenantId } = await setup({ modules: false });
    expect((await admin.get('/api/inventory')).status).toBe(403);
    expect((await op.get('/api/tabs')).status).toBe(403);
    const boot = (await op.get('/api/bootstrap')).body;
    expect(boot.modules.inventario).toBe(false);
    expect(boot.paymentMethods.map((m: any) => m.code)).not.toContain('FIADO');
    // O administrador do estabelecimento não libera (não existe mais rota para isso).
    expect((await admin.put('/api/modules', { inventario: true })).status).toBe(404);
    expect((await admin.get(`/api/central/tenants/${tenantId}/modules`)).status).toBe(401);
    const sup = await agent(app, 'super', true);
    expect((await sup.put(`/api/central/tenants/${tenantId}/modules`, { inventario: true, mesas: true })).status).toBe(200);
    expect((await admin.get('/api/inventory')).status).toBe(200);
    expect((await op.get('/api/tabs')).status).toBe(200);
    expect((await admin.get('/api/analytics')).status).toBe(403);
  });

  it('fiado bloqueado também na venda', async () => {
    const { admin, op, db } = await setup({ modules: false });
    const pid = await product(admin);
    await openCash(op);
    const cid = (await db.one("INSERT INTO customers (name, created_at) VALUES ('X', 'x') RETURNING id")).id;
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(r.status).toBe(403);
  });

  it('login do estabelecimento não entra no painel central e vice-versa', async () => {
    const { app, admin } = await setup();
    expect((await admin.get('/api/central/tenants')).status).toBe(401);
    const res = await request(app).post('/api/central/login').set('X-Requested-With', 'pdv').send({ username: 'admin', password: PASS });
    expect(res.status).toBe(401);
    const res2 = await request(app).post('/api/auth/login').set('X-Requested-With', 'pdv').send({ username: 'super', password: PASS });
    expect(res2.status).toBe(401);
  });
});

describe('vários estabelecimentos', () => {
  it('dados separados, login único entre estabelecimentos', async () => {
    const { app, admin, op } = await setup();
    const pid = await product(admin, { name: 'Produto da Loja 1' });
    const sup = await agent(app, 'super', true);
    const r = await sup.post('/api/central/tenants', { name: 'Loja Dois', admin: { name: 'Dono Dois', username: 'dono2', password: PASS }, exempt: true });
    expect(r.status).toBe(201);
    // Login repetido entre estabelecimentos é recusado.
    expect((await sup.post('/api/central/tenants', { name: 'Loja Três', admin: { name: 'Xis', username: 'admin', password: PASS }, exempt: true })).status).toBe(409);
    expect((await admin.post('/api/users', { name: 'Ypsilon', username: 'dono2', password: PASS, role: 'OPERADOR' })).status).toBe(409);
    const dono2 = await agent(app, 'dono2');
    const list2 = (await dono2.get('/api/products')).body;
    expect(list2.find((p: any) => p.name === 'Produto da Loja 1')).toBeUndefined();
    const h = await dono2.get(`/api/products/${pid}/history`);
    expect(JSON.stringify(h.body)).not.toContain('Produto da Loja 1');
    expect((await op.get('/api/products')).body.find((p: any) => p.name === 'Produto da Loja 1')).toBeTruthy();
    expect((await dono2.get('/api/bootstrap')).body.storeName).toBe('Loja Dois');
    const tenants = (await sup.get('/api/central/tenants')).body;
    expect(tenants.map((t: any) => t.name).sort()).toEqual(['Loja Dois', 'Loja Teste']);
  });

  it('assinatura: sem pagamento o sistema fica fora do ar; suspensão manual também', async () => {
    const { app, base, tenantId } = await setup();
    const sup = await agent(app, 'super', true);
    const r = await sup.post('/api/central/tenants', { name: 'Loja Paga', admin: { name: 'Dono', username: 'dono.pago', password: PASS } });
    const tid = r.body.id;
    const dono = await agent(app, 'dono.pago');
    const blocked = await dono.get('/api/products');
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    expect((await dono.get('/api/bootstrap')).status).toBe(200);
    expect((await dono.get('/api/billing/status')).body.access.ok).toBe(false);
    await base.run("UPDATE tenants SET subscription_status = 'active' WHERE id = ?", [tid]);
    expect((await dono.get('/api/products')).status).toBe(200);
    await base.run("UPDATE tenants SET subscription_status = 'past_due' WHERE id = ?", [tid]);
    expect((await dono.get('/api/products')).status).toBe(402);
    // Período de teste concedido pelo admin central libera.
    await sup.patch(`/api/central/tenants/${tid}`, { trial_ends_at: new Date(Date.now() + 864e5).toISOString() });
    expect((await dono.get('/api/products')).status).toBe(200);
    // Suspensão manual bloqueia mesmo isento.
    await sup.patch(`/api/central/tenants/${tenantId}`, { status: 'SUSPENDED' });
    const admin = await agent(app, 'admin');
    expect((await admin.get('/api/products')).status).toBe(402);
  });
});

describe('inventário e acuracidade', () => {
  async function ctx() {
    const s = await setup();
    const a = await product(s.admin, { name: 'Cerveja', barcode: '7891', initial_stock_milli: 10000, cost_cents: 300 });
    const b = await product(s.admin, { name: 'Refri', category_id: 2, barcode: '7892', initial_stock_milli: 5000, cost_cents: 200 });
    const c = await product(s.admin, { name: 'Chopp', category_id: 3, unit: 'L', price_cents: 2000, cost_cents: 1000, initial_stock_milli: 20000 });
    return { ...s, a, b, c };
  }

  it('contagem cega, leitura item a item, acuracidade e ajuste', async () => {
    const { admin, op, a, b, c, db } = await ctx();
    const inv = (await admin.post('/api/inventory', { scope: 'FULL', blind: true })).body;
    expect(inv.totalItems).toBe(3);
    // operador conta sem ver o saldo do sistema
    const view = (await op.get(`/api/inventory/${inv.id}`)).body;
    expect(view.items[0].systemMilli).toBeUndefined();
    expect(view.accuracy).toBeNull();
    expect((await op.get('/api/products/by-code/7891')).body.id).toBe(a);
    for (let i = 0; i < 10; i++) await op.post(`/api/inventory/${inv.id}/count`, { productId: a, qtyMilli: 1000, mode: 'add' }); // 10 = ok
    await op.post(`/api/inventory/${inv.id}/count`, { productId: b, qtyMilli: 4000, mode: 'set' }); // falta 1
    await op.post(`/api/inventory/${inv.id}/count`, { productId: c, qtyMilli: 19500, mode: 'set' }); // falta 0,5 L
    expect((await op.post(`/api/inventory/${inv.id}/count`, { productId: b, qtyMilli: 500, mode: 'set' })).status).toBe(400); // fração de unidade
    expect((await op.post(`/api/inventory/${inv.id}/finish`, { apply: true })).status).toBe(403);
    const adminView = (await admin.get(`/api/inventory/${inv.id}`)).body;
    expect(adminView.accuracy).toMatchObject({ countedItems: 3, matchedItems: 1, divergentItems: 2 });
    const done = (await admin.post(`/api/inventory/${inv.id}/finish`, { apply: true })).body;
    // valor sistema: 10*3 + 5*2 + 20*10 = 240,00; divergência: 2,00 + 5,00 = 7,00
    expect(done.accuracy.systemValueCents).toBe(24000);
    expect(done.accuracy.divergenceAbsCents).toBe(700);
    expect(done.accuracy.valueAccuracy).toBeCloseTo(1 - 700 / 24000);
    expect(done.accuracy.itemAccuracy).toBeCloseTo(1 / 3);
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [b])).s).toBe(4000);
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [c])).s).toBe(19500);
    expect((await op.post(`/api/inventory/${inv.id}/count`, { productId: a, qtyMilli: 1000, mode: 'add' })).status).toBe(409);
    const list = (await admin.get('/api/inventory')).body;
    expect(list[0].item_accuracy).toBeCloseTo(1 / 3);
  });

  it('venda depois da contagem não vira divergência falsa', async () => {
    const { admin, op, a, db } = await ctx();
    await openCash(op);
    const inv = (await admin.post('/api/inventory', { scope: 'PARTIAL', productIds: [a] })).body;
    await op.post(`/api/inventory/${inv.id}/count`, { productId: a, qtyMilli: 10000, mode: 'set' });
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: a, qtyMilli: 3000 }] });
    const done = (await admin.post(`/api/inventory/${inv.id}/finish`, { apply: true })).body;
    expect(done.accuracy.itemAccuracy).toBe(1);
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [a])).s).toBe(7000);
  });

  it('inventário por categoria recusa produto de outra categoria; encerrar sem ajustar não mexe no estoque', async () => {
    const { admin, a, b, db } = await ctx();
    const inv = (await admin.post('/api/inventory', { scope: 'CATEGORY', categoryId: 1 })).body;
    expect(inv.totalItems).toBe(1);
    expect((await admin.post(`/api/inventory/${inv.id}/count`, { productId: b, qtyMilli: 1000, mode: 'set' })).status).toBe(400);
    await admin.post(`/api/inventory/${inv.id}/count`, { productId: a, qtyMilli: 8000, mode: 'set' });
    const done = (await admin.post(`/api/inventory/${inv.id}/finish`, { apply: false })).body;
    expect(done.applied).toBe(false);
    expect(done.accuracy.itemAccuracy).toBe(0);
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [a])).s).toBe(10000);
  });

  it('meta de acuracidade é definida pelo administrador', async () => {
    const { admin, op } = await setup();
    expect((await op.get('/api/inventory-target')).body.targetPct).toBeNull();
    expect((await op.put('/api/settings', { inventory_accuracy_target: 98 })).status).toBe(403);
    expect((await admin.put('/api/settings', { inventory_accuracy_target: 101 })).status).toBe(400);
    expect((await admin.put('/api/settings', { inventory_accuracy_target: 97.5 })).status).toBe(200);
    expect((await op.get('/api/inventory-target')).body.targetPct).toBe(97.5);
  });

  it('nome e logo do estabelecimento (sem sessão não revela nada)', async () => {
    const { app, admin } = await setup();
    expect((await admin.put('/api/settings', { store_name: 'Bar do Teste', store_logo_url: 'https://exemplo.com/logo.png' })).status).toBe(200);
    expect((await admin.put('/api/settings', { store_logo_url: 'http://inseguro.com/x.png' })).status).toBe(400);
    expect((await admin.get('/api/public/info')).body).toEqual({ storeName: 'Bar do Teste', storeLogo: 'https://exemplo.com/logo.png' });
    expect((await request(app).get('/api/public/info')).body).toEqual({ storeName: '', storeLogo: '' });
    expect((await admin.get('/api/bootstrap')).body.storeName).toBe('Bar do Teste');
  });
});

describe('primeiro acesso de estabelecimento novo', () => {
  it('avisa que falta o código do caixa e informa o estabelecimento da sessão', async () => {
    const { app } = await setup();
    const sup = await agent(app, 'super', true);
    const tid = (await sup.post('/api/central/tenants', { name: 'Loja Nova', admin: { name: 'Dona Nova', username: 'dona.nova', password: PASS }, exempt: true })).body.id;
    const dona = await agent(app, 'dona.nova');
    expect((await dona.get('/api/bootstrap')).body.setupPending).toBe(true);
    expect((await dona.get('/api/auth/me')).body.user.tenantId).toBe(tid);
    expect((await dona.put('/api/settings/cash-code', { code: '5678' })).status).toBe(200);
    expect((await dona.get('/api/bootstrap')).body.setupPending).toBe(false);
  });
});
