import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DB, now } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { Tenant } from './platform.js';
import type { Fetch } from './stripe.js';

/**
 * Pix com confirmação automática (plano Pro) via Mercado Pago.
 * - Cada estabelecimento conecta a PRÓPRIA conta (OAuth): o dinheiro cai na conta dele, nunca na da plataforma.
 * - A plataforma só guarda os tokens (criptografados) para criar cobranças e consultar se foram pagas.
 * - Uma venda Pix automática só é registrada com uma cobrança APROVADA, do mesmo valor, ainda não usada.
 * Variáveis: MP_CLIENT_ID, MP_CLIENT_SECRET (do aplicativo do Central.PDV no Mercado Pago) e APP_URL.
 */
const API = 'https://api.mercadopago.com';
const AUTH = 'https://auth.mercadopago.com/authorization';
const CHARGE_MINUTES = 15;

export const mpConfigured = () => !!(process.env.MP_CLIENT_ID && process.env.MP_CLIENT_SECRET);
const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
export const redirectUri = () => `${appUrl()}/api/mp/callback`;

function secret() {
  const s = process.env.MP_CLIENT_SECRET;
  if (!s) throw new AppError(503, 'MP_OFF', 'O Pix automático ainda não foi configurado. Fale com o suporte do Central.PDV.');
  return s;
}
const key = (label: string) => createHash('sha256').update(`central-pdv|${label}|`).update(secret()).digest();

/** Criptografia dos tokens guardados (AES-256-GCM). Trocar o MP_CLIENT_SECRET exige reconectar as contas. */
export function seal(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key('tokens'), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
export function unseal(box: string) {
  const [v, iv, tag, enc] = box.split('.');
  if (v !== 'v1') throw new Error('token inválido');
  const d = createDecipheriv('aes-256-gcm', key('tokens'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

/** "state" do OAuth: diz de qual estabelecimento é a conexão, assinado e com validade de 10 minutos. */
export function makeState(tenantId: number, userId: number, at = Date.now()) {
  const body = `${tenantId}.${userId}.${at + 10 * 60e3}.${randomBytes(8).toString('hex')}`;
  return `${body}.${createHmac('sha256', key('state')).update(body).digest('base64url')}`;
}
export function readState(state: string, at = Date.now()) {
  const i = state.lastIndexOf('.');
  if (i < 0) return null;
  const body = state.slice(0, i), sig = state.slice(i + 1);
  const exp = createHmac('sha256', key('state')).update(body).digest('base64url');
  if (sig.length !== exp.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const [t, u, until] = body.split('.').map(Number);
  if (!t || !u || !until || until < at) return null;
  return { tenantId: t, userId: u };
}

export function connectUrl(tenantId: number, userId: number) {
  if (!mpConfigured()) throw new AppError(503, 'MP_OFF', 'O Pix automático ainda não foi configurado. Fale com o suporte do Central.PDV.');
  const q = new URLSearchParams({ client_id: process.env.MP_CLIENT_ID!, response_type: 'code', platform_id: 'mp', state: makeState(tenantId, userId), redirect_uri: redirectUri() });
  return `${AUTH}?${q}`;
}

async function mpApi(f: Fetch, method: string, path: string, token: string | null, body?: unknown, idem?: string) {
  const res = await f(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idem ? { 'X-Idempotency-Key': idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('MercadoPago', method, path.replace(/\d{6,}/g, '…'), res.status, json?.message);
    if (res.status === 401) throw new AppError(409, 'MP_RECONNECT', 'A conexão com o Mercado Pago expirou. O administrador precisa conectar a conta de novo em Configurações.');
    throw new AppError(502, 'MP', 'Não foi possível falar com o Mercado Pago. Tente de novo ou use o Pix pela chave.');
  }
  return json;
}

function saveTokens(base: DB, tenantId: number, tok: any, userId: number | null) {
  const exp = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null;
  return base.run(`INSERT INTO mp_accounts (tenant_id, mp_user_id, access_token, refresh_token, expires_at, connected_by, connected_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (tenant_id) DO UPDATE SET mp_user_id = EXCLUDED.mp_user_id, access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at, connected_by = COALESCE(EXCLUDED.connected_by, mp_accounts.connected_by), connected_at = mp_accounts.connected_at`,
  [tenantId, tok.user_id != null ? String(tok.user_id) : null, seal(tok.access_token), tok.refresh_token ? seal(tok.refresh_token) : null, exp, userId, now()]);
}

/** Volta do Mercado Pago: troca o código pelos tokens da conta do estabelecimento. */
export async function finishConnect(base: DB, f: Fetch, code: string, state: string) {
  const s = readState(state);
  if (!s) throw badRequest('Link de conexão inválido ou vencido. Tente conectar de novo.');
  const tok = await mpApi(f, 'POST', '/oauth/token', null, {
    client_id: process.env.MP_CLIENT_ID, client_secret: secret(), grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
  });
  if (!tok?.access_token) throw new AppError(502, 'MP', 'O Mercado Pago não confirmou a conexão. Tente de novo.');
  await saveTokens(base, s.tenantId, tok, s.userId);
  return s;
}

export async function disconnect(base: DB, tenantId: number) {
  await base.run('DELETE FROM mp_accounts WHERE tenant_id = ?', [tenantId]);
}

export async function status(base: DB, t: Tenant) {
  const a = await base.one('SELECT mp_user_id, connected_at FROM mp_accounts WHERE tenant_id = ?', [t.id]);
  return { available: mpConfigured(), plan: t.plan, connected: !!a, connectedAt: a?.connected_at ?? null };
}

/** Token de acesso do estabelecimento, renovado quando estiver perto de vencer. */
async function accessToken(base: DB, f: Fetch, tenantId: number) {
  const a = await base.one('SELECT * FROM mp_accounts WHERE tenant_id = ?', [tenantId]);
  if (!a) throw new AppError(409, 'MP_NOT_CONNECTED', 'Conecte a conta do Mercado Pago em Administração › Configurações › Pix.');
  const soon = a.expires_at && new Date(a.expires_at).getTime() - Date.now() < 7 * 864e5;
  if (soon && a.refresh_token) {
    try {
      const tok = await mpApi(f, 'POST', '/oauth/token', null, { client_id: process.env.MP_CLIENT_ID, client_secret: secret(), grant_type: 'refresh_token', refresh_token: unseal(a.refresh_token) });
      if (tok?.access_token) { await saveTokens(base, tenantId, tok, null); return tok.access_token as string; }
    } catch { /* usa o token atual enquanto ainda vale */ }
  }
  return unseal(a.access_token);
}

/** Pix automático disponível para este estabelecimento agora? (plano Pro + conta conectada + plataforma configurada) */
export async function enabled(base: DB, t: Tenant) {
  return mpConfigured() && t.plan === 'pro' && !!(await base.one('SELECT 1 FROM mp_accounts WHERE tenant_id = ?', [t.id]));
}

const mapStatus = (s: string) => (s === 'approved' ? 'APPROVED' : s === 'cancelled' ? 'CANCELLED' : s === 'rejected' ? 'FAILED' : s === 'expired' ? 'EXPIRED' : 'PENDING');

/** Cria a cobrança Pix no Mercado Pago (na conta do estabelecimento) e devolve o código "copia e cola". */
export async function createCharge(base: DB, tdb: DB, f: Fetch, t: Tenant, userId: number, amountCents: number, idem: string) {
  if (!(await enabled(base, t))) throw forbidden('O Pix automático é do plano Pro, com a conta do Mercado Pago conectada.');
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 10_000_000) throw badRequest('Valor inválido.');
  const token = await accessToken(base, f, t.id);
  const expires = new Date(Date.now() + CHARGE_MINUTES * 60e3).toISOString();
  const row = await tdb.one<{ id: number }>("INSERT INTO pix_charges (amount_cents, status, expires_at, created_by, created_at) VALUES (?, 'PENDING', ?, ?, ?) RETURNING id",
    [amountCents, expires, userId, now()]);
  const pay = await mpApi(f, 'POST', '/v1/payments', token, {
    transaction_amount: amountCents / 100,
    description: `${t.name} — venda no caixa`.slice(0, 120),
    payment_method_id: 'pix',
    payer: { email: process.env.MP_PAYER_EMAIL || 'cliente@centralpdv.com.br' },
    external_reference: `t${t.id}-c${row!.id}`,
    date_of_expiration: expires.replace('Z', '-00:00'),
  }, `pdv-${t.id}-${idem}`).catch(async (e) => { await tdb.run("UPDATE pix_charges SET status = 'FAILED' WHERE id = ?", [row!.id]); throw e; });
  const qr = pay?.point_of_interaction?.transaction_data?.qr_code;
  if (!pay?.id || !qr) {
    await tdb.run("UPDATE pix_charges SET status = 'FAILED' WHERE id = ?", [row!.id]);
    throw new AppError(502, 'MP', 'O Mercado Pago não gerou o QR Code. Use o Pix pela chave.');
  }
  await tdb.run('UPDATE pix_charges SET provider_id = ?, qr_code = ? WHERE id = ?', [String(pay.id), qr, row!.id]);
  return { id: row!.id, qrCode: qr as string, amountCents, expiresAt: expires, status: 'PENDING' as const };
}

/** Consulta no Mercado Pago (fonte da verdade) e atualiza a cobrança. Nunca confia no navegador. */
export async function refreshCharge(base: DB, tdb: DB, f: Fetch, t: Tenant, chargeId: number) {
  const c = await tdb.one('SELECT * FROM pix_charges WHERE id = ?', [chargeId]);
  if (!c) throw notFound('Cobrança não encontrada.');
  if (c.status !== 'PENDING' || !c.provider_id) return publicCharge(c);
  const pay = await mpApi(f, 'GET', `/v1/payments/${encodeURIComponent(c.provider_id)}`, await accessToken(base, f, t.id));
  let st = mapStatus(String(pay?.status));
  // Confere valor e referência: só aprova o que foi criado para esta cobrança, deste estabelecimento.
  if (st === 'APPROVED' && (Math.round(Number(pay.transaction_amount) * 100) !== c.amount_cents || pay.external_reference !== `t${t.id}-c${c.id}`)) st = 'FAILED';
  if (st === 'PENDING' && c.expires_at < new Date().toISOString()) st = 'EXPIRED';
  if (st !== c.status) {
    await tdb.run("UPDATE pix_charges SET status = ?, paid_at = CASE WHEN ? = 'APPROVED' THEN ? ELSE paid_at END WHERE id = ? AND status = 'PENDING'", [st, st, now(), c.id]);
  }
  return publicCharge({ ...c, status: st });
}

/** Cancela uma cobrança ainda não paga (o caixa desistiu ou trocou a forma de pagamento). */
export async function cancelCharge(base: DB, tdb: DB, f: Fetch, t: Tenant, chargeId: number) {
  const c = await refreshCharge(base, tdb, f, t, chargeId);
  if (c.status === 'APPROVED') throw conflict('Este Pix já foi pago. Confirme a venda.');
  if (c.status !== 'PENDING') return c;
  const row = await tdb.one('SELECT provider_id FROM pix_charges WHERE id = ?', [chargeId]);
  await mpApi(f, 'PUT', `/v1/payments/${encodeURIComponent(row.provider_id)}`, await accessToken(base, f, t.id), { status: 'cancelled' }).catch(() => {});
  await tdb.run("UPDATE pix_charges SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'", [chargeId]);
  return { ...c, status: 'CANCELLED' };
}

const publicCharge = (c: any) => ({ id: c.id, amountCents: c.amount_cents, status: c.status as string, qrCode: c.qr_code as string | null, expiresAt: c.expires_at, saleId: c.sale_id ?? null });

/** Dentro da transação da venda: amarra a cobrança aprovada à venda (uma cobrança paga = uma venda). */
export async function claimCharge(tx: DB, chargeId: number, totalCents: number) {
  const c = await tx.one('SELECT * FROM pix_charges WHERE id = ? FOR UPDATE', [chargeId]);
  if (!c) throw notFound('Cobrança Pix não encontrada.');
  if (c.status !== 'APPROVED') throw conflict('O Pix ainda não foi confirmado pelo Mercado Pago.');
  if (c.sale_id) throw conflict('Este Pix já foi usado em outra venda.');
  if (c.amount_cents !== totalCents) throw conflict('O valor do pedido mudou depois do Pix. Gere um novo Pix.');
  return c;
}
export const linkCharge = (tx: DB, chargeId: number, saleId: number) => tx.run('UPDATE pix_charges SET sale_id = ? WHERE id = ?', [saleId, chargeId]);
