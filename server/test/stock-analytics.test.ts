import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash } from './helpers.js';
import { resolvePeriod } from '../src/services/analytics.js';
import { localDate, addDays } from '../src/tz.js';

describe('estoque', () => {
  it('entrada com validade, ajuste com motivo e perda', async () => {
    const { admin } = await setup();
    const pid = await product(admin, { initial_stock_milli: 5000, min_stock_milli: 6000 });
    let alerts = (await admin.get('/api/stock/alerts')).body;
    expect(alerts.lowStock.map((x: any) => x.id)).toContain(pid);
    const exp = addDays(localDate(new Date()), 5);
    expect((await admin.post('/api/stock/entries', { productId: pid, qtyMilli: 10000, unitCostCents: 400, expiryDate: exp, updateCost: true })).status).toBe(201);
    alerts = (await admin.get('/api/stock/alerts')).body;
    expect(alerts.lowStock.map((x: any) => x.id)).not.toContain(pid);
    expect(alerts.expiring[0]).toMatchObject({ product_id: pid, expiry_date: exp });
    expect((await admin.get('/api/products')).body[0].cost_cents).toBe(400);
    expect((await admin.post('/api/stock/adjustments', { productId: pid, qtyMilli: -1000, type: 'LOSS', reason: '' })).status).toBe(400);
    expect((await admin.post('/api/stock/adjustments', { productId: pid, qtyMilli: -1000, type: 'LOSS', reason: 'garrafa quebrada' })).status).toBe(201);
    const mov = (await admin.get(`/api/stock/movements?productId=${pid}`)).body;
    expect(mov.map((m: any) => m.type)).toEqual(['LOSS', 'ENTRY', 'ENTRY']);
    expect(mov[0].balance_after_milli).toBe(14000);
  });
});

describe('análise', () => {
  it('resolve períodos', () => {
    expect(resolvePeriod('7d', undefined, undefined, '2026-03-10')).toEqual({ from: '2026-03-04', to: '2026-03-10' });
    expect(resolvePeriod('month', undefined, undefined, '2026-03-10')).toEqual({ from: '2026-03-01', to: '2026-03-10' });
    expect(() => resolvePeriod('custom', '2026-03-10', '2026-03-01')).toThrow();
  });

  it('calcula faturamento, ticket, margem e filtros por categoria e produto', async () => {
    const { admin, op } = await setup();
    const beer = await product(admin); // 600, custo 350
    const cookie = await product(admin, { name: 'Biscoito', category_id: 5, unit: 'PCT', price_cents: 400, cost_cents: null });
    await openCash(op);
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: beer, qtyMilli: 2000 }, { productId: cookie, qtyMilli: 1000 }] });
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: beer, qtyMilli: 1000 }] });
    const a = (await admin.get('/api/analytics?preset=today')).body;
    expect(a.summary).toMatchObject({ productRevenueCents: 2200, salesCount: 2, avgTicketCents: 1100, cogsCents: 1050, costedRevenueCents: 1800, grossProfitCents: 750 });
    expect(a.summary.costCoverage).toBeCloseTo(1800 / 2200);
    expect(a.topByQty[0]).toMatchObject({ productId: beer, qtyMilli: 3000 });
    expect(a.daily).toHaveLength(1);
    const f = (await admin.get('/api/analytics?preset=today&categoryId=5')).body;
    expect(f.summary).toMatchObject({ productRevenueCents: 400, salesCount: 1, grossProfitCents: null });
    const p = (await admin.get(`/api/analytics?preset=7d&productId=${beer}`)).body;
    expect(p.summary.productRevenueCents).toBe(1800);
    expect(p.daily).toHaveLength(7);
    expect(a.notes.netProfit).toMatch(/não é calculado/);
  });

  it('sugestão de reposição explica a estimativa e sinaliza histórico curto', async () => {
    const { admin, op } = await setup();
    const beer = await product(admin, { initial_stock_milli: 4000, min_stock_milli: 2000 });
    await openCash(op);
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: beer, qtyMilli: 3000 }] });
    const r = (await admin.get('/api/restock')).body;
    const it = r.items.find((x: any) => x.productId === beer);
    expect(it.limitedHistory).toBe(true);
    expect(it.needsRestock).toBe(true);
    expect(it.suggestedMilli % 1000).toBe(0);
    expect(it.reasons.join(' ')).toMatch(/Histórico curto/);
    expect(r.assumptions.length).toBeGreaterThan(0);
  });

  it('dashboard responde sem dados', async () => {
    const { admin } = await setup();
    const d = (await admin.get('/api/dashboard')).body;
    expect(d.today.salesCount).toBe(0);
    expect(d.today.avgTicketCents).toBeNull();
    expect(d.openRegisters).toEqual([]);
  });
});

describe('movimentações de estoque com filtros', () => {
  it('filtra por pessoa, tipo, produto e período; aceita desenho pré-cadastrado', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin, { name: 'Cerveja 600ml', image_url: 'art:cerveja-600' });
    await admin.post('/api/stock/adjustments', { productId: pid, qtyMilli: -1000, type: 'LOSS', reason: 'garrafa quebrada' });
    await openCash(op);
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'DINHEIRO', items: [{ productId: pid, qtyMilli: 1000 }] });
    const all = (await admin.get(`/api/stock/movements?productId=${pid}`)).body;
    const me = (await admin.get('/api/auth/me')).body.user.id;
    const byUser = (await admin.get(`/api/stock/movements?userId=${me}&productId=${pid}`)).body;
    expect(byUser.every((m: any) => m.user_id === me)).toBe(true);
    expect(byUser.length).toBeLessThan(all.length);
    expect((await admin.get(`/api/stock/movements?type=LOSS&productId=${pid}`)).body.map((m: any) => m.type)).toEqual(['LOSS']);
    expect((await admin.get('/api/stock/movements?q=600ml&preset=today')).body.length).toBe(all.length);
    expect((await admin.get('/api/stock/movements?preset=custom&from=2000-01-01&to=2000-01-02')).body).toEqual([]);
    expect((await admin.get('/api/products?q=600ml')).body[0].image_url).toBe('art:cerveja-600');
    expect((await admin.post('/api/products', { name: 'X', category_id: 1, unit: 'UN', price_cents: 100, image_url: 'art:../x' })).status).toBe(400);
  });
});
