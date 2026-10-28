import { createHmac, timingSafeEqual } from 'node:crypto';
import { DB, now } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { Tenant, getTenant, platformAudit } from './platform.js';

/**
 * Assinatura via Stripe (Checkout + Portal do cliente + webhook).
 * Variáveis: STRIPE_SECRET_KEY, STRIPE_PRICE_ID (mensalidade), STRIPE_SETUP_PRICE_ID (instalação, opcional),
 * STRIPE_WEBHOOK_SECRET e APP_URL (ex.: https://basepdv.vercel.app).
 * O acesso do estabelecimento depende só do status salvo pelo webhook (ver platform.access).
 */
export type Fetch = typeof fetch;

export const stripeConfigured = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

function form(obj: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) p.append(k, String(v));
  return p;
}

async function stripeApi(f: Fetch, method: 'GET' | 'POST', path: string, body?: URLSearchParams) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new AppError(503, 'BILLING_OFF', 'Pagamento ainda não configurado. Fale com o suporte do Central.PDV.');
  const res = await f(`https://api.stripe.com/v1${path}`, {
    method, body,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe', res.status, json?.error?.message);
    throw new AppError(502, 'STRIPE', 'Não foi possível falar com o sistema de pagamento. Tente de novo em instantes.');
  }
  return json;
}

const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

async function ensureCustomer(base: DB, f: Fetch, t: Tenant, email?: string) {
  if (t.stripe_customer_id) return t.stripe_customer_id;
  const c = await stripeApi(f, 'POST', '/customers', form({ name: t.name, email, 'metadata[tenant_id]': t.id }));
  await base.run('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?', [c.id, t.id]);
  return c.id as string;
}

/** Link do Checkout para assinar (ou o Portal, se já houver assinatura válida). */
export async function checkoutUrl(base: DB, f: Fetch, tenantId: number) {
  const t = await getTenant(base, tenantId);
  if (!t) throw badRequest('Estabelecimento não encontrado.');
  const customer = await ensureCustomer(base, f, t);
  // Taxa de instalação: cobrada uma única vez, junto com a 1ª mensalidade, só na primeira assinatura.
  const setup = process.env.STRIPE_SETUP_PRICE_ID && !t.stripe_subscription_id ? process.env.STRIPE_SETUP_PRICE_ID : undefined;
  const s = await stripeApi(f, 'POST', '/checkout/sessions', form({
    mode: 'subscription', customer, client_reference_id: t.id,
    'line_items[0][price]': process.env.STRIPE_PRICE_ID, 'line_items[0][quantity]': 1,
    'line_items[1][price]': setup, 'line_items[1][quantity]': setup ? 1 : undefined,
    'subscription_data[metadata][tenant_id]': t.id, 'metadata[tenant_id]': t.id,
    success_url: `${appUrl()}/app/admin/assinatura?ok=1`, cancel_url: `${appUrl()}/app/admin/assinatura`,
    locale: 'pt-BR', allow_promotion_codes: 'true',
  }));
  return s.url as string;
}

/** Portal do Stripe: trocar cartão, ver faturas, cancelar. */
export async function portalUrl(base: DB, f: Fetch, tenantId: number) {
  const t = await getTenant(base, tenantId);
  if (!t?.stripe_customer_id) throw badRequest('Ainda não há assinatura para gerenciar.');
  const s = await stripeApi(f, 'POST', '/billing_portal/sessions', form({ customer: t.stripe_customer_id, return_url: `${appUrl()}/app/admin/assinatura` }));
  return s.url as string;
}

/** Valida o cabeçalho Stripe-Signature (HMAC-SHA256 do "timestamp.corpo"), com tolerância de 5 minutos. */
export function verifyWebhook(raw: Buffer, header: string | undefined, secret: string, at = Date.now()) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((x) => x.length === 2));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  if (!t || !sigs.length || Math.abs(at / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

async function applySubscription(base: DB, sub: any, tenantHint?: number) {
  const tenantId = Number(sub.metadata?.tenant_id) || tenantHint
    || (await base.one('SELECT id FROM tenants WHERE stripe_subscription_id = ? OR stripe_customer_id = ?', [sub.id, sub.customer]))?.id;
  if (!tenantId) return;
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  await base.run('UPDATE tenants SET stripe_subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), subscription_status = ?, current_period_end = ? WHERE id = ?',
    [sub.id, sub.customer, sub.status, end ? new Date(end * 1000).toISOString() : null, tenantId]);
  await platformAudit(base, null, 'billing.subscription', tenantId, { status: sub.status });
}

/** Processa um evento já validado. Idempotente (o Stripe pode reenviar). */
export async function handleEvent(base: DB, f: Fetch, ev: any) {
  const fresh = await base.run('INSERT INTO stripe_events (id, type, received_at) VALUES (?,?,?) ON CONFLICT DO NOTHING', [ev.id, ev.type, now()]);
  if (!fresh.rowCount) return { duplicate: true };
  const o = ev.data?.object ?? {};
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription' && o.subscription) {
    const sub = await stripeApi(f, 'GET', `/subscriptions/${o.subscription}`);
    await applySubscription(base, sub, Number(o.client_reference_id) || undefined);
  } else if (ev.type.startsWith('customer.subscription.')) {
    await applySubscription(base, o);
  } else if (ev.type === 'invoice.payment_failed' && o.subscription) {
    // A atualização da assinatura (past_due) também chega; aqui garantimos o bloqueio imediato.
    await base.run("UPDATE tenants SET subscription_status = 'past_due' WHERE stripe_subscription_id = ?", [o.subscription]);
  }
  return { duplicate: false };
}
