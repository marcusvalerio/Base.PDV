import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash, CANCEL } from './helpers.js';

async function ctx() {
  const s = await setup();
  const beer = await product(s.admin);
  const chopp = await product(s.admin, { name: 'Chopp', category_id: 3, unit: 'L', price_cents: 2400, cost_cents: 1000, initial_stock_milli: 30000 });
  await openCash(s.op);
  const tab = (await s.op.post('/api/tabs', { label: 'Mesa 04', people: ['Paula', 'Rodrigo', 'Bruno'] })).body;
  const [paula, rodrigo, bruno] = tab.people.map((p: any) => p.id);
  await s.op.post(`/api/tabs/${tab.id}/items`, { personId: paula, items: [{ productId: beer, qtyMilli: 2000 }] });
  await s.op.post(`/api/tabs/${tab.id}/items`, { personId: rodrigo, items: [{ productId: chopp, qtyMilli: 500 }] });
  const t = (await s.op.post(`/api/tabs/${tab.id}/items`, { personId: bruno, items: [{ productId: beer, qtyMilli: 1000 }] })).body;
  return { ...s, beer, chopp, tabId: tab.id, paula, rodrigo, bruno, tab: t };
}

describe('mesas e comandas', () => {
  it('registra consumo por pessoa sem gerar venda nem baixar estoque', async () => {
    const { tab, db, chopp } = await ctx();
    expect(tab.people.map((p: any) => p.pending_cents)).toEqual([1200, 1200, 600]);
    expect(tab.pending_cents).toBe(3000);
    expect((db.prepare('SELECT COUNT(*) n FROM sales').get() as any).n).toBe(0);
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(chopp) as any).s).toBe(30000);
  });

  it('não permite abrir a mesma mesa duas vezes', async () => {
    const { op } = await ctx();
    expect((await op.post('/api/tabs', { label: 'Mesa 04' })).status).toBe(409);
  });

  it('fecha conta individual e depois o restante da mesa, sem cobrar itens duas vezes', async () => {
    const { op, tabId, paula, db, chopp } = await ctx();
    const k = key();
    const r1 = await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: k, personId: paula, paymentMethodCode: 'PIX' });
    expect(r1.body.sale.total_cents).toBe(1200);
    expect(r1.body.tab.status).toBe('OPEN');
    expect(r1.body.tab.pending_cents).toBe(1800);
    const dup = await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: k, personId: paula, paymentMethodCode: 'PIX' });
    expect(dup.body.replayed).toBe(true);
    expect((await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: key(), personId: paula, paymentMethodCode: 'PIX' })).status).toBe(400);
    const r2 = await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: key(), personId: null, paymentMethodCode: 'DINHEIRO', receivedCents: 2000 });
    expect(r2.body.sale.total_cents).toBe(1800);
    expect(r2.body.sale.change_cents).toBe(200);
    expect(r2.body.tab.status).toBe('CLOSED');
    expect(r2.body.sale.items.every((i: any) => i.tab_person_id)).toBe(true);
    expect((db.prepare("SELECT SUM(total_cents) t FROM sales WHERE status='COMPLETED'").get() as any).t).toBe(3000);
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(chopp) as any).s).toBe(29500);
  });

  it('corrige lançamento indevido preservando histórico', async () => {
    const { op, tabId, tab } = await ctx();
    const item = tab.people[2].items[0];
    expect((await op.post(`/api/tabs/${tabId}/items/${item.id}/void`, { reason: 'x' })).status).toBe(400);
    const t = (await op.post(`/api/tabs/${tabId}/items/${item.id}/void`, { reason: 'lançado na pessoa errada' })).body;
    expect(t.pending_cents).toBe(2400);
    expect(t.people[2].items[0]).toMatchObject({ status: 'VOIDED', void_reason: 'lançado na pessoa errada' });
  });

  it('fechar comanda no fiado gera dívida apenas no fechamento', async () => {
    const { op, tabId, rodrigo } = await ctx();
    const cid = (await op.post('/api/customers', { name: 'Rodrigo Fictício' })).body.id;
    expect((await op.get(`/api/customers/${cid}`)).body.balanceCents).toBe(0);
    await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: key(), personId: rodrigo, paymentMethodCode: 'FIADO', customerId: cid });
    expect((await op.get(`/api/customers/${cid}`)).body.balanceCents).toBe(1250);
  });

  it('cancelar a venda de uma mesa devolve os itens para a mesa (reabrindo-a)', async () => {
    const { op, tabId, db, chopp } = await ctx();
    const r = (await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: key(), personId: null, paymentMethodCode: 'PIX' })).body;
    expect(r.tab.status).toBe('CLOSED');
    const c = await op.post(`/api/sales/${r.sale.id}/cancel`, { reason: 'fechou a mesa errada', code: CANCEL });
    expect(c.status).toBe(200);
    const t = (await op.get(`/api/tabs/${tabId}`)).body;
    expect(t.status).toBe('OPEN');
    expect(t.pending_cents).toBe(3000);
    expect((db.prepare('SELECT stock_milli s FROM products WHERE id = ?').get(chopp) as any).s).toBe(30000);
    const again = (await op.post(`/api/tabs/${tabId}/close`, { idempotencyKey: key(), personId: null, paymentMethodCode: 'CARTAO' })).body;
    expect(again.sale.total_cents).toBe(3000);
  });
});
