import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash } from './helpers.js';
import { lineTotal } from '../src/money.js';

describe('produtos', () => {
  it('cria, altera e registra histórico', async () => {
    const { admin } = await setup();
    const id = await product(admin);
    expect((await admin.patch(`/api/products/${id}`, { price_cents: 650 })).status).toBe(200);
    const h = (await admin.get(`/api/products/${id}/history`)).body;
    expect(h[0]).toMatchObject({ field: 'price_cents', old_value: '600', new_value: '650' });
  });
  it('impede código de barras duplicado', async () => {
    const { admin } = await setup();
    await product(admin, { barcode: '789' });
    const r = await admin.post('/api/products', { name: 'Outro', category_id: 1, unit: 'UN', price_cents: 1, barcode: '789' });
    expect(r.status).toBe(409);
  });
});

describe('cálculo de totais', () => {
  it('calcula linha por volume (chopp em litros)', () => {
    expect(lineTotal(2400, 300)).toBe(720); // 300 mL a R$ 24,00/L
    expect(lineTotal(2400, 500)).toBe(1200);
    expect(lineTotal(999, 333)).toBe(333); // arredondamento ao centavo
    expect(lineTotal(600, 3000)).toBe(1800);
  });
});

describe('vendas no PDV', () => {
  it('exige caixa aberto', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('REGISTER_CLOSED');
  });

  it('registra venda à vista em dinheiro com troco e baixa de estoque', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    await openCash(op);
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'DINHEIRO', items: [{ productId: pid, qtyMilli: 3000 }], receivedCents: 2000 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ total_cents: 1800, change_cents: 200, status: 'COMPLETED' });
    const p = (await admin.get('/api/products')).body.find((x: any) => x.id === pid);
    expect(p.stock_milli).toBe(47000);
    const mov = (await admin.get(`/api/stock/movements?productId=${pid}`)).body;
    expect(mov[0]).toMatchObject({ type: 'SALE', qty_milli: -3000, ref_type: 'sale', ref_id: r.body.id });
  });

  it('usa o preço do servidor, ignorando valores enviados', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    await openCash(op);
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1000, price_cents: 1 }] });
    expect(r.body.total_cents).toBe(600);
  });

  it('recusa dinheiro insuficiente', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    await openCash(op);
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'DINHEIRO', items: [{ productId: pid, qtyMilli: 1000 }], receivedCents: 500 });
    expect(r.status).toBe(400);
  });

  it('não vende produto inativo nem quantidade fracionada de unidade', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    await openCash(op);
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1500 }] })).status).toBe(400);
    await admin.patch(`/api/products/${pid}`, { active: false });
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(r.body.error.code).toBe('PRODUCT_INACTIVE');
  });

  it('é idempotente: reenvio com a mesma chave não duplica a venda nem o estoque', async () => {
    const { admin, op, db } = await setup();
    const pid = await product(admin);
    await openCash(op);
    const body = { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 2000 }] };
    const [a, b] = await Promise.all([op.post('/api/sales', body), op.post('/api/sales', body)]);
    const c = await op.post('/api/sales', body);
    expect(a.body.id).toBe(b.body.id);
    expect(c.body.id).toBe(a.body.id);
    expect(c.status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) n FROM sales').get() as any).n).toBe(1);
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(pid) as any).s).toBe(48000);
  });

  it('cancelamento (admin) devolve estoque e sai dos relatórios', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    await openCash(op);
    const s = (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 2000 }] })).body;
    expect((await op.post(`/api/sales/${s.id}/cancel`, { reason: 'erro' })).status).toBe(403);
    expect((await admin.post(`/api/sales/${s.id}/cancel`, { reason: 'lançado errado' })).status).toBe(200);
    expect((await admin.post(`/api/sales/${s.id}/cancel`, { reason: 'de novo' })).status).toBe(409);
    const p = (await admin.get('/api/products')).body.find((x: any) => x.id === pid);
    expect(p.stock_milli).toBe(50000);
    const a = (await admin.get('/api/analytics?preset=today')).body;
    expect(a.summary.salesCount).toBe(0);
  });
});
