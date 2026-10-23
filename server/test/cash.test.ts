import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash, CODE } from './helpers.js';

describe('caixa', () => {
  it('recusa código incorreto e não abre dois caixas', async () => {
    const { op, admin } = await setup();
    expect((await op.post('/api/cash/open', { code: '0000', openingFloatCents: 0 })).status).toBe(403);
    await openCash(op);
    expect((await admin.post('/api/cash/open', { code: CODE, openingFloatCents: 0 })).status).toBe(409);
  });

  it('resumo separa faturamento, fiado e dinheiro esperado; fecha uma única vez', async () => {
    const { admin, op } = await setup();
    const pid = await product(admin);
    const rid = await openCash(op, 5000);
    const cid = (await op.post('/api/customers', { name: 'Cliente X' })).body.id;
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'DINHEIRO', items: [{ productId: pid, qtyMilli: 2000 }], receivedCents: 2000 }); // 1200
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1000 }] }); // 600
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] }); // 650
    await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: key(), amountCents: 300, paymentMethodCode: 'DINHEIRO' });
    await op.post('/api/cash/movements', { type: 'SUPRIMENTO', amountCents: 1000 });
    await op.post('/api/cash/movements', { type: 'SANGRIA', amountCents: 2000, reason: 'depósito' });
    const s = (await op.get(`/api/cash/${rid}/summary`)).body;
    expect(s.salesTotalCents).toBe(2450);
    expect(s.salesByMethod.find((m: any) => m.code === 'FIADO').total_cents).toBe(650);
    expect(s.receiptsTotalCents).toBe(300);
    expect(s.expectedCashCents).toBe(5000 + 1200 + 300 + 1000 - 2000);
    expect((await op.post(`/api/cash/${rid}/close`, { code: '9999', countedCashCents: 0 })).status).toBe(403);
    const c = await op.post(`/api/cash/${rid}/close`, { code: CODE, countedCashCents: 5400 });
    expect(c.status).toBe(200);
    expect(c.body.differenceCents).toBe(-100);
    expect((await op.post(`/api/cash/${rid}/close`, { code: CODE, countedCashCents: 5500 })).body.error.code).toBe('ALREADY_CLOSED');
    const after = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(after.body.error.code).toBe('REGISTER_CLOSED');
  });

  it('modo de código individual', async () => {
    const { admin, op, opId } = await setup();
    await admin.put('/api/settings', { cash_code_mode: 'INDIVIDUAL' });
    expect((await op.post('/api/cash/open', { code: CODE, openingFloatCents: 0 })).status).toBe(403);
    await admin.put(`/api/users/${opId}/cash-code`, { code: '8765' });
    expect((await op.post('/api/cash/open', { code: '8765', openingFloatCents: 0 })).status).toBe(201);
  });
});
