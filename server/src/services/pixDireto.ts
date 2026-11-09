import { DB, now } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { Tenant, getTenant, platformAudit } from './platform.js';

/**
 * Mensalidade por Pix direto na chave do dono da plataforma.
 * - O estabelecimento vê o QR com o valor (1ª cobrança ou mensalidade) e toca em "Já paguei".
 * - Enquanto o dono confere no banco, o sistema fica liberado por 3 dias (carência).
 * - Confirmado no painel central, libera 30 dias (somados ao que ainda faltava).
 * A chave fica no banco (platform_settings), nunca no código.
 */
export const GRACE_DAYS = 3;
export const PERIOD_DAYS = 30;
const DEF = { pix_key: '', pix_name: '', pix_city: '', first_cents: '25000', monthly_cents: '8000' };
export type PixSettings = { pix_key: string; pix_name: string; pix_city: string; first_cents: number; monthly_cents: number };

export async function getSettings(base: DB): Promise<PixSettings> {
  const rows = await base.all<{ key: string; value: string }>("SELECT key, value FROM platform_settings WHERE key IN ('pix_key','pix_name','pix_city','first_cents','monthly_cents')");
  const m: Record<string, string> = { ...DEF, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return { pix_key: m.pix_key, pix_name: m.pix_name, pix_city: m.pix_city, first_cents: Number(m.first_cents), monthly_cents: Number(m.monthly_cents) };
}

export async function saveSettings(base: DB, s: PixSettings, adminId: number) {
  const ts = now();
  for (const [k, v] of Object.entries(s)) {
    await base.run('INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at', [k, String(v), ts]);
  }
  await platformAudit(base, adminId, 'pix.settings', null, { pix_name: s.pix_name, pix_city: s.pix_city, first_cents: s.first_cents, monthly_cents: s.monthly_cents, key_set: !!s.pix_key });
}

/** Já pagou alguma vez (Pix confirmado ou assinatura do Stripe)? Define se a cobrança é a 1ª (com instalação) ou a mensalidade. */
async function paidBefore(base: DB, t: Tenant) {
  return !!t.stripe_subscription_id || !!(await base.one("SELECT 1 FROM pix_payments WHERE tenant_id = ? AND status = 'CONFIRMED'", [t.id]));
}

/** O que o estabelecimento vê na tela de Assinatura. */
export async function statusFor(base: DB, t: Tenant) {
  const s = await getSettings(base);
  const first = !(await paidBefore(base, t));
  const pending = await base.one("SELECT id, amount_cents, reported_at FROM pix_payments WHERE tenant_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1", [t.id]);
  return {
    available: !!(s.pix_key && s.pix_name && s.pix_city),
    pix: s.pix_key ? { key: s.pix_key, name: s.pix_name, city: s.pix_city } : null,
    kind: first ? 'first' : 'monthly', amountCents: first ? s.first_cents : s.monthly_cents,
    paidUntil: t.paid_until, graceUntil: t.pix_grace_until, pending: pending ?? null,
  };
}

/** "Já paguei": registra para conferência e libera o sistema por 3 dias. */
export async function report(base: DB, t: Tenant, userId: number) {
  const st = await statusFor(base, t);
  if (!st.available) throw badRequest('O pagamento por Pix ainda não está disponível. Fale com o suporte.');
  if (st.pending) throw conflict('Seu Pix já foi avisado e está em conferência.');
  const at = now();
  const grace = new Date(Date.now() + GRACE_DAYS * 864e5).toISOString();
  await base.run("INSERT INTO pix_payments (tenant_id, amount_cents, kind, status, reported_by, reported_at) VALUES (?,?,?,'PENDING',?,?)", [t.id, st.amountCents, st.kind, userId, at]);
  await base.run('UPDATE tenants SET pix_grace_until = ? WHERE id = ?', [grace, t.id]);
  await platformAudit(base, null, 'pix.reported', t.id, { amount: st.amountCents, kind: st.kind });
  return { ok: true, graceUntil: grace };
}

export async function pendingList(base: DB) {
  return base.all(`SELECT p.id, p.tenant_id, t.name AS tenant_name, t.contact_name, t.contact_phone, p.amount_cents, p.kind, p.reported_at
    FROM pix_payments p JOIN tenants t ON t.id = p.tenant_id WHERE p.status = 'PENDING' ORDER BY p.reported_at`);
}

/** Confirmado no banco: libera 30 dias a partir do que ainda faltava (ou de hoje). Recusado: tira a carência. */
export async function decide(base: DB, id: number, ok: boolean, adminId: number) {
  return base.tx(async (tx) => {
    const p = await tx.one("SELECT * FROM pix_payments WHERE id = ? FOR UPDATE", [id]);
    if (!p) throw notFound('Pagamento não encontrado.');
    if (p.status !== 'PENDING') throw conflict('Este pagamento já foi decidido.');
    const t = (await getTenant(tx, p.tenant_id))!;
    await tx.run('UPDATE pix_payments SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [ok ? 'CONFIRMED' : 'REJECTED', adminId, now(), id]);
    let paidUntil = t.paid_until;
    if (ok) {
      const from = Math.max(Date.now(), t.paid_until ? Date.parse(t.paid_until) : 0);
      paidUntil = new Date(from + PERIOD_DAYS * 864e5).toISOString();
      await tx.run('UPDATE tenants SET paid_until = ?, pix_grace_until = NULL WHERE id = ?', [paidUntil, t.id]);
    } else {
      await tx.run('UPDATE tenants SET pix_grace_until = NULL WHERE id = ?', [t.id]);
    }
    await platformAudit(tx, adminId, ok ? 'pix.confirmed' : 'pix.rejected', t.id, { amount: p.amount_cents, paidUntil });
    return { ok: true, paidUntil };
  });
}
