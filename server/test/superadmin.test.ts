import { describe, it, expect } from 'vitest';
import { setup, agent, key, product, openCash } from './helpers.js';

describe('super administrador e liberação de módulos', () => {
  it('módulos começam bloqueados e só o super admin libera', async () => {
    const { app, admin, op } = await setup({ modules: false });
    expect((await admin.get('/api/inventory')).status).toBe(403);
    expect((await op.get('/api/tabs')).status).toBe(403);
    expect((await admin.get('/api/analytics')).status).toBe(403);
    const boot = (await op.get('/api/bootstrap')).body;
    expect(boot.modules.inventario).toBe(false);
    expect(boot.paymentMethods.map((m: any) => m.code)).not.toContain('FIADO');
    expect((await admin.put('/api/modules', { inventario: true })).status).toBe(403);
    const sup = await agent(app, 'super');
    expect((await sup.put('/api/modules', { inventario: true, mesas: true })).status).toBe(200);
    expect((await admin.get('/api/inventory')).status).toBe(200);
    expect((await op.get('/api/tabs')).status).toBe(200);
    expect((await admin.get('/api/analytics')).status).toBe(403);
  });

  it('fiado bloqueado também na venda', async () => {
    const { admin, op, db } = await setup({ modules: false });
    const pid = await product(admin);
    await openCash(op);
    const cid = Number(db.prepare("INSERT INTO customers (name, created_at) VALUES ('X', 'x')").run().lastInsertRowid);
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(r.status).toBe(403);
  });

  it('admin comum não altera nem cria super admin', async () => {
    const { app, admin, superId } = await setup();
    expect((await admin.patch(`/api/users/${superId}`, { active: false })).status).toBe(403);
    expect((await admin.patch(`/api/users/${superId}`, { password: 'outra-senha-123' })).status).toBe(403);
    expect((await admin.post('/api/users', { name: 'Novo Super', username: 'novo', password: '12345678', role: 'ADMIN', superAdmin: true })).status).toBe(403);
    const sup = await agent(app, 'super');
    expect((await sup.get('/api/auth/me')).body.user.superAdmin).toBe(true);
    expect((await sup.post('/api/users', { name: 'Novo Super', username: 'novo', password: '12345678', role: 'ADMIN', superAdmin: true })).status).toBe(201);
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
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(b) as any).s).toBe(4000);
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(c) as any).s).toBe(19500);
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
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(a) as any).s).toBe(7000);
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
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(a) as any).s).toBe(10000);
  });

  it('meta de acuracidade é definida pelo administrador', async () => {
    const { admin, op } = await setup();
    expect((await op.get('/api/inventory-target')).body.targetPct).toBeNull();
    expect((await op.put('/api/settings', { inventory_accuracy_target: 98 })).status).toBe(403);
    expect((await admin.put('/api/settings', { inventory_accuracy_target: 101 })).status).toBe(400);
    expect((await admin.put('/api/settings', { inventory_accuracy_target: 97.5 })).status).toBe(200);
    expect((await op.get('/api/inventory-target')).body.targetPct).toBe(97.5);
  });
});
