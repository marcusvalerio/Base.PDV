import { describe, it, expect } from 'vitest';
import { setup, product, openCash, key, CANCEL } from './helpers.js';

describe('preço por item na venda', () => {
  it('muda o preço só daquela venda, com código e motivo; registra na auditoria; cadastro não muda', async () => {
    const { admin, op, db } = await setup();
    const pid = await product(admin, { price_cents: 1200 });
    await openCash(op);
    const items = [{ productId: pid, qtyMilli: 2000, unitPriceCents: 1000 }];
    // sem autorização: recusa
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items })).status).toBe(403);
    // código errado: recusa
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items, priceAuth: { code: '0000', reason: 'cliente fiel' } })).status).toBe(403);
    // sem motivo: recusa
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items, priceAuth: { code: CANCEL, reason: '' } })).status).toBe(400);
    const ok = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items, priceAuth: { code: CANCEL, reason: 'cliente fiel' } });
    expect(ok.status).toBe(201);
    expect(ok.body.total_cents).toBe(2000);
    expect(ok.body.price_note).toBe('cliente fiel');
    expect(ok.body.items[0]).toMatchObject({ unit_price_cents: 1000, list_price_cents: 1200 });
    expect((await db.one('SELECT price_cents FROM products WHERE id = ?', [pid])).price_cents).toBe(1200);
    const aud = await db.one("SELECT details_json FROM audit_log WHERE action = 'sale.price_change'");
    expect(JSON.parse(aud.details_json)).toMatchObject({ reason: 'cliente fiel', items: [{ de: 1200, para: 1000 }] });
    // mesmo preço do cadastro não exige código
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1000, unitPriceCents: 1200 }] })).status).toBe(201);
  });

  it('conferência do código na tela tem limite de tentativas', async () => {
    const { op } = await setup();
    expect((await op.post('/api/sales/price-auth', { code: CANCEL })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await op.post('/api/sales/price-auth', { code: '1' + i })).status).toBe(403);
    expect((await op.post('/api/sales/price-auth', { code: CANCEL })).status).toBe(429);
  });
});
