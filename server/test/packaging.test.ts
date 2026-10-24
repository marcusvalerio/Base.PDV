import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash, CANCEL } from './helpers.js';

describe('embalagem de compra e baixa em outro produto', () => {
  it('copo de chopp desconta do barril; cancelamento devolve ao barril', async () => {
    const { admin, op, db } = await setup();
    const barril = await product(admin, { name: 'Chopp Pilsen (barril)', category_id: 3, unit: 'L', price_cents: 2400, cost_cents: 1000, initial_stock_milli: 50000, pack_label: 'barril', pack_size_milli: 50000 });
    const copo = (await admin.post('/api/products', { name: 'Copo de Chopp 300ml', category_id: 3, unit: 'UN', price_cents: 900, stock_source_id: barril, stock_source_qty_milli: 300 })).body.id;
    // PDV mostra quantos copos ainda dá para servir
    const list = (await op.get('/api/products')).body;
    expect(list.find((p: any) => p.id === copo).stock_milli).toBe(166000);
    await openCash(op);
    const s = (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: copo, qtyMilli: 3000 }] })).body;
    expect(s.total_cents).toBe(2700);
    expect(s.items[0]).toMatchObject({ stock_product_id: barril, stock_qty_milli: 900 });
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [barril])).s).toBe(49100);
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [copo])).s).toBe(0);
    // custo do copo = custo do litro × 0,3 → margem calculada
    const a = (await admin.get('/api/analytics?preset=today')).body;
    expect(a.summary.cogsCents).toBe(900);
    expect((await op.post(`/api/sales/${s.id}/cancel`, { reason: 'teste de estorno', code: CANCEL })).status).toBe(200);
    expect((await db.one('SELECT stock_milli AS s FROM products WHERE id = ?', [barril])).s).toBe(50000);
  });

  it('regras: copo não recebe entrada, não entra no inventário e precisa ser por unidade', async () => {
    const { admin } = await setup();
    const barril = await product(admin, { name: 'Barril', category_id: 3, unit: 'L', price_cents: 2000, initial_stock_milli: 30000 });
    expect((await admin.post('/api/products', { name: 'Jarra', category_id: 3, unit: 'L', price_cents: 1, stock_source_id: barril, stock_source_qty_milli: 1500 })).status).toBe(400);
    expect((await admin.post('/api/products', { name: 'Copo', category_id: 3, unit: 'UN', price_cents: 1, stock_source_id: barril })).status).toBe(400);
    const copo = (await admin.post('/api/products', { name: 'Copo', category_id: 3, unit: 'UN', price_cents: 800, stock_source_id: barril, stock_source_qty_milli: 400 })).body.id;
    expect((await admin.post('/api/stock/entries', { productId: copo, qtyMilli: 1000 })).status).toBe(400);
    expect((await admin.patch(`/api/products/${barril}`, { stock_source_id: copo, stock_source_qty_milli: 1000 })).status).toBe(400);
    const inv = (await admin.post('/api/inventory', { scope: 'FULL' })).body;
    expect(inv.items.map((i: any) => i.productId)).toEqual([barril]);
  });

  it('embalagem exige nome e quantidade juntos', async () => {
    const { admin } = await setup();
    expect((await admin.post('/api/products', { name: 'Doce', category_id: 5, unit: 'UN', price_cents: 100, pack_label: 'caixa' })).status).toBe(400);
    const r = await admin.post('/api/products', { name: 'Doce', category_id: 5, unit: 'UN', price_cents: 100, cost_cents: 50, pack_label: 'caixa', pack_size_milli: 20000 });
    expect(r.status).toBe(201);
    const p = (await admin.get('/api/products?all=1')).body.find((x: any) => x.id === r.body.id);
    expect(p).toMatchObject({ pack_label: 'caixa', pack_size_milli: 20000 });
  });
});
