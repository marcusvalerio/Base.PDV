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

  it('aplica o acréscimo por unidade vendida e lança no saldo do cliente', async () => {
    const { op, pid, cid } = await ctx();
    const r = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 2000 }] });
    expect(r.body).toMatchObject({ subtotal_cents: 1200, surcharge_cents: 100, total_cents: 1300 });
    const st = (await op.get(`/api/customers/${cid}`)).body;
    expect(st.balanceCents).toBe(1300);
    expect(st.receivables[0]).toMatchObject({ original_cents: 1200, surcharge_cents: 100, total_cents: 1300, status: 'OPEN' });
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
    await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 2000 }] }); // 1200 + 2 × 50 = 1300
    const k = key();
    const p1 = await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: k, amountCents: 1000, paymentMethodCode: 'DINHEIRO' });
    expect(p1.body.balanceCents).toBe(950);
    const again = await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: k, amountCents: 1000, paymentMethodCode: 'DINHEIRO' });
    expect(again.body).toMatchObject({ replayed: true, balanceCents: 950 });
    const st = (await op.get(`/api/customers/${cid}`)).body;
    const [newer, older] = st.receivables;
    expect(older).toMatchObject({ status: 'PAID', paid_cents: 650 });
    expect(newer).toMatchObject({ status: 'OPEN', paid_cents: 350 });
    expect((await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: key(), amountCents: 951, paymentMethodCode: 'PIX' })).body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    const p2 = await op.post(`/api/customers/${cid}/payments`, { idempotencyKey: key(), amountCents: 950, paymentMethodCode: 'PIX' });
    expect(p2.body.balanceCents).toBe(0);
  });

  it('uma venda só gera um lançamento de fiado (restrição única)', async () => {
    const { op, pid, cid, db } = await ctx();
    const s = (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: pid, qtyMilli: 1000 }] })).body;
    await expect(db.run("INSERT INTO receivables (customer_id, sale_id, original_cents, surcharge_cents, total_cents, status, created_at) VALUES (?,?,1,0,1,'OPEN','x')", [cid, s.id])).rejects.toThrow();
  });
});

describe('acréscimo do fiado por unidade', () => {
  it('3 cervejas + 1 salgadinho = 4 × R$ 0,50; chopp conta 1 por item', async () => {
    const { admin, op } = await setup();
    const cerveja = await product(admin);
    const salg = await product(admin, { name: 'Salgadinho', category_id: 6, unit: 'PCT', price_cents: 700 });
    const chopp = await product(admin, { name: 'Chopp', category_id: 3, unit: 'L', price_cents: 2400, initial_stock_milli: 30000 });
    await openCash(op);
    const cid = (await op.post('/api/customers', { name: 'Cliente Teste' })).body.id;
    const a = (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: cerveja, qtyMilli: 3000 }, { productId: salg, qtyMilli: 1000 }] })).body;
    expect(a).toMatchObject({ subtotal_cents: 2500, surcharge_cents: 200, total_cents: 2700 });
    const b = (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'FIADO', customerId: cid, items: [{ productId: chopp, qtyMilli: 1500 }] })).body;
    expect(b).toMatchObject({ subtotal_cents: 3600, surcharge_cents: 50 });
  });
});

describe('cartão de débito e crédito', () => {
  it('sem acréscimo configurado, não cobra nada; com acréscimo, aplica por % ou por unidade', async () => {
    const { admin, op, db } = await setup();
    const cerveja = await product(admin); // R$ 6,00
    await openCash(op);
    const boot = (await op.get('/api/bootstrap')).body;
    expect(boot.paymentMethods.map((m: any) => m.code)).toEqual(['DINHEIRO', 'PIX', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'FIADO']);
    const sell = async (code: string, q = 3000) => (await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: code, items: [{ productId: cerveja, qtyMilli: q }] })).body;
    expect((await sell('CARTAO_DEBITO')).surcharge_cents).toBe(0);
    expect((await sell('CARTAO_CREDITO')).surcharge_cents).toBe(0);
    await admin.put('/api/settings', { card_credit_surcharge_mode: 'PERCENT', card_credit_surcharge_value: 350, card_debit_surcharge_mode: 'UNIT', card_debit_surcharge_value: 20 });
    expect(await sell('CARTAO_CREDITO')).toMatchObject({ subtotal_cents: 1800, surcharge_cents: 63, total_cents: 1863 }); // 3,5%
    expect(await sell('CARTAO_DEBITO')).toMatchObject({ subtotal_cents: 1800, surcharge_cents: 60, total_cents: 1860 }); // 3 × R$ 0,20
    expect((await sell('PIX')).surcharge_cents).toBe(0);
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'CARTAO', items: [{ productId: cerveja, qtyMilli: 1000 }] })).status).toBe(400);
    const s = (await op.get('/api/cash/current')).body;
    expect(s.salesByMethod.map((m: any) => m.code)).not.toContain('CARTAO');
    void db;
  });
});
