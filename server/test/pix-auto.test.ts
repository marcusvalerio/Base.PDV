import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { setup, agent, product, openCash, key, PASS } from './helpers.js';
import { createTenant } from '../src/services/platform.js';
import { makeState, readState, seal, unseal } from '../src/services/mercadopago.js';

/** Mercado Pago falso: guarda as cobranças criadas e deixa o teste decidir quando cada uma é paga. */
function fakeMP() {
  const pays = new Map<string, any>();
  const calls: { method: string; url: string; body: any; auth?: string }[] = [];
  let n = 9000;
  const f = (async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? 'GET', url, body, auth: init?.headers?.Authorization });
    const ok = (j: any, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/oauth/token')) return ok({ access_token: 'APP_USR-segredo-do-bar', refresh_token: 'TG-refresh', user_id: 123, expires_in: 15552000 });
    if (url.endsWith('/v1/payments') && init?.method === 'POST') {
      const id = String(++n);
      const p = { id, status: 'pending', transaction_amount: body.transaction_amount, external_reference: body.external_reference, point_of_interaction: { transaction_data: { qr_code: `00020101PIX${id}` } } };
      pays.set(id, p); return ok(p, 201);
    }
    const m = url.match(/\/v1\/payments\/(\d+)$/);
    if (m) {
      const p = pays.get(m[1]); if (!p) return ok({ message: 'not found' }, 404);
      if (init?.method === 'PUT') p.status = body.status;
      return ok(p);
    }
    return ok({}, 404);
  }) as unknown as typeof fetch;
  return { f, pays, calls };
}

async function proTenant() {
  process.env.MP_CLIENT_ID = 'app-123'; process.env.MP_CLIENT_SECRET = 'segredo-do-app-de-teste'; process.env.APP_URL = 'https://centralpdv.test';
  const mpx = fakeMP();
  const s = await setup({ fetch: mpx.f });
  const sup = await agent(s.app, 'super', true);
  await sup.patch(`/api/central/tenants/${s.tenantId}`, { plan: 'pro' });
  const r = await s.admin.post('/api/mp/connect');
  expect(r.status).toBe(200);
  const state = new URL(r.body.url).searchParams.get('state')!;
  const cb = await request(s.app).get(`/api/mp/callback?code=TG-code&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(302);
  expect(cb.headers.location).toBe('/app/admin/config?mp=ok');
  return { ...s, mpx, sup };
}

describe('Pix automático (plano Pro, Mercado Pago)', () => {
  afterEach(() => { for (const k of ['MP_CLIENT_ID', 'MP_CLIENT_SECRET', 'APP_URL']) delete process.env[k]; });

  it('state do OAuth é assinado e vence; tokens ficam criptografados', () => {
    process.env.MP_CLIENT_SECRET = 'x'.repeat(20);
    const st = makeState(7, 3);
    expect(readState(st)).toEqual({ tenantId: 7, userId: 3 });
    expect(readState(st.replace(/^7\./, '8.'))).toBeNull();
    expect(readState(st, Date.now() + 11 * 60e3)).toBeNull();
    const box = seal('APP_USR-abc');
    expect(box).not.toContain('APP_USR');
    expect(unseal(box)).toBe('APP_USR-abc');
  });

  it('plano Essencial não conecta nem cria cobrança', async () => {
    process.env.MP_CLIENT_ID = 'app-123'; process.env.MP_CLIENT_SECRET = 'segredo-do-app-de-teste';
    const { admin, op } = await setup({ fetch: fakeMP().f });
    expect((await admin.post('/api/mp/connect')).status).toBe(403);
    expect((await op.post('/api/pix/charges', { amountCents: 600, idempotencyKey: key() })).status).toBe(403);
    expect((await admin.get('/api/bootstrap')).body.pixAuto).toBe(false);
  });

  it('conecta a conta (token guardado criptografado) e libera o Pix automático', async () => {
    const { base, admin, tenantId } = await proTenant();
    const row = await base.one('SELECT * FROM mp_accounts WHERE tenant_id = ?', [tenantId]);
    expect(row.mp_user_id).toBe('123');
    expect(row.access_token).not.toContain('APP_USR');
    expect((await admin.get('/api/bootstrap')).body.pixAuto).toBe(true);
    expect((await admin.get('/api/mp/status')).body).toMatchObject({ connected: true, plan: 'pro' });
  });

  it('callback com state adulterado não conecta nada', async () => {
    process.env.MP_CLIENT_ID = 'app-123'; process.env.MP_CLIENT_SECRET = 'segredo-do-app-de-teste';
    const { app, base } = await setup({ fetch: fakeMP().f });
    const cb = await request(app).get('/api/mp/callback?code=x&state=1.1.9999999999999.ab.forjado');
    expect(cb.headers.location).toBe('/app/admin/config?mp=erro');
    expect((await base.one('SELECT COUNT(*)::int AS n FROM mp_accounts')).n).toBe(0);
  });

  it('venda só fecha com a cobrança aprovada, do mesmo valor, usada uma vez', async () => {
    const { admin, op, mpx } = await proTenant();
    const pid = await product(admin, { price_cents: 600 });
    await openCash(op);
    const items = [{ productId: pid, qtyMilli: 2000 }];
    const c = await op.post('/api/pix/charges', { amountCents: 1200, idempotencyKey: key() });
    expect(c.status).toBe(201);
    expect(c.body.qrCode).toMatch(/^00020101PIX/);
    const created = mpx.calls.find((x) => x.url.endsWith('/v1/payments'))!;
    expect(created.auth).toBe('Bearer APP_USR-segredo-do-bar');   // cobra na conta DO BAR
    expect(created.body.transaction_amount).toBe(12);

    // Ainda não pago: a venda é recusada.
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items, pixChargeId: c.body.id })).status).toBe(409);
    // Pago no Mercado Pago: o servidor confere lá (não confia no navegador).
    [...mpx.pays.values()][0].status = 'approved';
    expect((await op.get(`/api/pix/charges/${c.body.id}`)).body.status).toBe('APPROVED');
    // Valor diferente do pago: recusa.
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items: [{ productId: pid, qtyMilli: 3000 }], pixChargeId: c.body.id })).status).toBe(409);
    // Outra forma de pagamento com a cobrança: recusa.
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'DINHEIRO', items, receivedCents: 1200, pixChargeId: c.body.id })).status).toBe(400);
    const ok = await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items, pixChargeId: c.body.id });
    expect(ok.status).toBe(201);
    // A mesma cobrança não paga uma segunda venda.
    expect((await op.post('/api/sales', { idempotencyKey: key(), paymentMethodCode: 'PIX', items, pixChargeId: c.body.id })).status).toBe(409);
  });

  it('pagamento com valor ou referência diferentes no Mercado Pago não aprova', async () => {
    const { op, mpx } = await proTenant();
    const c = await op.post('/api/pix/charges', { amountCents: 1000, idempotencyKey: key() });
    const p = [...mpx.pays.values()][0];
    p.status = 'approved'; p.transaction_amount = 1;
    expect((await op.get(`/api/pix/charges/${c.body.id}`)).body.status).toBe('FAILED');
  });

  it('cancelar a cobrança pendente; cobrança de um bar não é vista por outro', async () => {
    const { op, app, base, sup } = await proTenant();
    const c = await op.post('/api/pix/charges', { amountCents: 500, idempotencyKey: key() });
    expect((await op.post(`/api/pix/charges/${c.body.id}/cancel`)).body.status).toBe('CANCELLED');
    const tidB = await createTenant(base, { name: 'Loja B', admin: { name: 'Dono B', username: 'dono.pixb', password: PASS }, exempt: true }, null);
    await sup.patch(`/api/central/tenants/${tidB}`, { plan: 'pro' });
    const b = await agent(app, 'dono.pixb');
    expect((await b.get(`/api/pix/charges/${c.body.id}`)).status).toBe(404);
    expect((await b.post('/api/pix/charges', { amountCents: 500, idempotencyKey: key() })).status).toBe(403); // B não conectou conta
  });
});
