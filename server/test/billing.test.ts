import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { setup, agent, PASS } from './helpers.js';
import { verifyWebhook } from '../src/services/stripe.js';

const SECRET = 'whsec_teste';
const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
const hook = (app: any, ev: any, sig?: string) => {
  const body = JSON.stringify(ev);
  return request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', sig ?? sign(body)).send(body);
};

/** Stripe falso: registra as chamadas e devolve respostas mínimas. */
function fakeStripe() {
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, body: String(init?.body ?? '') });
    const json = url.endsWith('/customers') ? { id: 'cus_1' }
      : url.endsWith('/checkout/sessions') ? { url: 'https://checkout.stripe.com/c/pay/teste' }
      : url.endsWith('/billing_portal/sessions') ? { url: 'https://billing.stripe.com/p/teste' }
      : url.includes('/subscriptions/') ? { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: {}, current_period_end: 1900000000 }
      : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('assinatura (Stripe)', () => {
  afterEach(() => { for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_SETUP_PRICE_ID', 'STRIPE_WEBHOOK_SECRET']) delete process.env[k]; });

  it('valida a assinatura do webhook', () => {
    const body = Buffer.from('{"a":1}');
    const t = Math.floor(Date.now() / 1000);
    const good = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.`).update(body).digest('hex')}`;
    expect(verifyWebhook(body, good, SECRET)).toBe(true);
    expect(verifyWebhook(body, good, 'outro')).toBe(false);
    expect(verifyWebhook(Buffer.from('{"a":2}'), good, SECRET)).toBe(false);
    expect(verifyWebhook(body, good, SECRET, (t + 600) * 1000)).toBe(false);
    expect(verifyWebhook(body, undefined, SECRET)).toBe(false);
  });

  it('checkout → webhook libera; falha de pagamento bloqueia na hora; evento repetido é ignorado', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_1'; process.env.STRIPE_SETUP_PRICE_ID = 'price_setup'; process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    const stripe = fakeStripe();
    const { app, base } = await setup({ fetch: stripe.f });
    const sup = await agent(app, 'super', true);
    const tid = (await sup.post('/api/central/tenants', { name: 'Loja Paga', admin: { name: 'Dono', username: 'dono.pago', password: PASS } })).body.id;
    const dono = await agent(app, 'dono.pago');
    expect((await dono.get('/api/products')).status).toBe(402);

    const co = await dono.post('/api/billing/checkout');
    expect(co.body.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    const first = stripe.calls.find((c) => c.url.endsWith('/checkout/sessions'))!.body;
    expect(first).toContain(`client_reference_id=${tid}`);
    // 1ª assinatura: mensalidade + instalação.
    expect(decodeURIComponent(first)).toContain('line_items[1][price]=price_setup');

    expect((await hook(app, { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: String(tid) } } }, 't=1,v1=errado')).status).toBe(400);
    expect((await hook(app, { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: String(tid) } } })).status).toBe(200);
    expect((await dono.get('/api/products')).status).toBe(200);

    await hook(app, { id: 'evt_2', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
    expect((await dono.get('/api/products')).status).toBe(402);

    await hook(app, { id: 'evt_3', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { tenant_id: String(tid) } } } });
    expect((await dono.get('/api/products')).status).toBe(200);
    // Reenvio do evento de falha (mesmo id) não bloqueia de novo.
    await hook(app, { id: 'evt_2', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
    expect((await dono.get('/api/products')).status).toBe(200);

    await hook(app, { id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { tenant_id: String(tid) } } } });
    expect((await dono.get('/api/products')).status).toBe(402);
    expect((await base.one('SELECT subscription_status FROM tenants WHERE id = ?', [tid])).subscription_status).toBe('canceled');

    expect((await dono.post('/api/billing/portal')).body.url).toMatch(/^https:\/\/billing\.stripe\.com/);
    // Assinando de novo (após cancelar): só a mensalidade, sem instalação.
    stripe.calls.length = 0;
    await dono.post('/api/billing/checkout');
    expect(decodeURIComponent(stripe.calls.find((c) => c.url.endsWith('/checkout/sessions'))!.body)).not.toContain('price_setup');
  });

  it('operador não mexe na assinatura; sem Stripe configurado avisa', async () => {
    const { op, admin } = await setup();
    expect((await op.post('/api/billing/checkout')).status).toBe(403);
    const r = await admin.post('/api/billing/checkout');
    expect(r.status).toBe(503);
  });
});

describe('cadastro pelo site e painel central', () => {
  it('cria estabelecimento, entra e fica aguardando assinatura; aparece nos números do painel', async () => {
    const { app } = await setup();
    const body = { storeName: 'Bar Novo', name: 'Rafa Lima', phone: '11987654321', username: 'rafa.lima', password: 'senha-rafa-123' };
    const r = await request(app).post('/api/signup').set('X-Requested-With', 'pdv').send(body);
    expect(r.status).toBe(201);
    const cookie = (r.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.role).toBe('ADMIN');
    expect(me.body.access.ok).toBe(false);
    expect((await request(app).get('/api/products').set('Cookie', cookie)).status).toBe(402);
    expect((await request(app).post('/api/signup').set('X-Requested-With', 'pdv').send(body)).status).toBe(409);
    const sup = await agent(app, 'super', true);
    const ov = (await sup.get('/api/central/overview')).body;
    expect(ov.total).toBe(2);
    expect(ov.blocked).toBe(1);
    const t = (await sup.get('/api/central/tenants')).body.find((x: any) => x.name === 'Bar Novo');
    expect(t.contact_phone).toBe('11987654321');
    expect(t.signup_source).toBe('site');
  });
});
