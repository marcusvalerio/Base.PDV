import { describe, it, expect } from 'vitest';
import { setup, key, product, openCash } from './helpers.js';

async function ctx() {
  const s = await setup();
  const pid = await product(s.admin);
  await openCash(s.op);
  const cid = (await s.op.post('/api/customers', { name: 'Cliente Fictício' })).body.id;
  return { ...s, pid, cid };
}

describe('fiado', () => {
  it('exige cliente', async () => {
    const { op, pid } = await ctx();
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(r.body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  it('aplica o acréscimo configurado e lança no saldo do cliente', async () => {
    const { op, pid, cid } = await ctx();
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 2000 }] });
    expect(r.body).toMatchObject({ subtotal_cents: 1200, surcharge_cents: 50, total_cents: 1250 });
    const st = (await op.get(`/api/customers/${cid}`)).body;
    expect(st.balanceCents).toBe(1250);
    expect(st.receivables[0]).toMatchObject({ original_cents: 1200, surcharge_cents: 50, total_cents: 1250, status: 'OPEN' });
  });

  it('alteração da configuração não muda dívidas já registradas', async () => {
    const { admin, op, pid, cid } = await ctx();
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] });
    await admin.put('/api/settings', { fiado_surcharge_cents: 100 });
    const r2 = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] });
    expect(r2.body.surcharge_cents).toBe(100);
    const st = (await op.get(`/api/customers/${cid}`)).body;
    expect(st.receivables.map((r: any) => r.surcharge_cents).sort()).toEqual([100, 50]);
    expect(st.balanceCents).toBe(650 + 700);
  });

  it('recebimento parcial e total atualizam o saldo (sem duplicar)', async () => {
    const { op, pid, cid } = await ctx();
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] }); // 650
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 2000 }] }); // 1250
    const k = key();
    const p1 = await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: k, amountCents: 1000, paymentMethodCode: 'DINHEIRO' });
    expect(p1.body.balanceCents).toBe(900);
    const again = await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: k, amountCents: 1000, paymentMethodCode: 'DINHEIRO' });
    expect(again.body).toMatchObject({ replayed: true, balanceCents: 900 });
    const st = (await op.get(`/api/customers/${cid}`)).body;
    const [newer, older] = st.receivables;
    expect(older).toMatchObject({ status: 'PAID', paid_cents: 650 });
    expect(newer).toMatchObject({ status: 'OPEN', paid_cents: 350 });
    expect((await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: key(), amountCents: 901, paymentMethodCode: 'PIX' })).body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    const p2 = await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: key(), amountCents: 900, paymentMethodCode: 'PIX' });
    expect(p2.body.balanceCents).toBe(0);
  });

  it('uma venda só gera um lançamento de fiado (restrição única)', async () => {
    const { op, pid, cid, db } = await ctx();
    const s = (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] })).body;
    await expect(db.run("INSERT INTO receivables (customer_id, sale_id, original_cents, surcharge_cents, total_cents, status, created_at) VALUES (?,?,1,0,1,'OPEN','x')", [cid, s.id])).rejects.toThrow();
  });
});
