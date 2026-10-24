import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash, CODE, agent, PASS } from './helpers.js';
import { createUser } from '../src/services/users.js';

describe('caixa', () => {
  it('recusa código incorreto e não abre dois caixas para a mesma pessoa', async () => {
    const { op } = await setup();
    expect((await op.post('/api/cash/open', { code: '0000', openingFloatCents: 0 })).status).toBe(403);
    await openCash(op);
    expect((await op.post('/api/cash/open', { code: CODE, openingFloatCents: 0 })).status).toBe(409);
  });

  it('vários caixas abertos ao mesmo tempo, separados, somando no mesmo relatório', async () => {
    const { app, admin, db, adminId } = await setup();
    const pid = await product(admin);
    const ops = [];
    for (let i = 1; i <= 5; i++) {
      await createUser(db, { name: `Op ${i}`, username: `op${i}`, password: PASS, role: 'OPERADOR' }, adminId);
      const c = await agent(app, `op${i}`);
      await openCash(c, 1000 * i);
      await c.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'DINHEIRO', items: [{ productId: pid, qtyMilli: i * 1000 }] });
      ops.push(c);
    }
    const active = (await admin.get('/api/cash/active')).body;
    expect(active).toHaveLength(5);
    expect(active.map((r: any) => r.openedByName)).toEqual(['Op 1', 'Op 2', 'Op 3', 'Op 4', 'Op 5']);
    const s3 = (await ops[2].get('/api/cash/current')).body;
    expect(s3.salesTotalCents).toBe(1800);
    expect(s3.expectedCashCents).toBe(3000 + 1800);
    expect((await ops[2].get('/api/sales')).body).toHaveLength(1);
    expect((await ops[0].get(`/api/cash/${s3.registerId}/summary`)).status).toBe(403);
    expect((await ops[0].post(`/api/cash/${s3.registerId}/close`, { code: CODE, countedCashCents: 0 })).status).toBe(403);
    expect((await admin.get('/api/analytics?preset=today')).body.summary.productRevenueCents).toBe(600 * 15);
    expect((await admin.get('/api/dashboard')).body.openRegisters).toHaveLength(5);
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
