import { DB, now, withSchema } from '../db.js';
import { notFound } from '../errors.js';
import { Tenant, access, getTenant, platformAudit } from './platform.js';
import { stripeConfigured, stripeList, Fetch } from './stripe.js';

/**
 * Ferramentas do painel central: avisos aos estabelecimentos, saúde de cada cliente, notas internas,
 * histórico de ações, crescimento e financeiro (Stripe).
 */

// ---------- Avisos ----------

export type NoticeKind = 'info' | 'maintenance' | 'billing' | 'news';
export interface Notice { id: number | string; tenant_id: number | null; kind: NoticeKind; title: string; message: string; starts_at: string; ends_at: string }

export async function createNotice(base: DB, n: Omit<Notice, 'id'>, adminId: number) {
  if (n.tenant_id && !(await getTenant(base, n.tenant_id))) throw notFound('Estabelecimento não encontrado.');
  const r = await base.one<{ id: number }>('INSERT INTO platform_notices (tenant_id, kind, title, message, starts_at, ends_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
    [n.tenant_id, n.kind, n.title.trim(), n.message.trim(), n.starts_at, n.ends_at, adminId, now()]);
  await platformAudit(base, adminId, 'notice.create', n.tenant_id, { title: n.title, kind: n.kind });
  return r!.id;
}

export const listNotices = (base: DB) => base.all(
  `SELECT n.*, t.name AS tenant_name FROM platform_notices n LEFT JOIN tenants t ON t.id = n.tenant_id
   WHERE n.ends_at > ? ORDER BY n.starts_at DESC LIMIT 200`, [new Date(Date.now() - 30 * 864e5).toISOString()]);

export async function endNotice(base: DB, id: number, adminId: number) {
  const r = await base.run('UPDATE platform_notices SET ends_at = ? WHERE id = ? AND ends_at > ?', [now(), id, now()]);
  if (!r.rowCount) throw notFound('Aviso não encontrado ou já encerrado.');
  await platformAudit(base, adminId, 'notice.end', null, { id });
}

const days = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 864e5);
const plural = (n: number) => (n === 1 ? '1 dia' : `${n} dias`);

/** Avisos que o estabelecimento vê agora: os criados no painel central e os automáticos de vencimento. */
export async function activeNoticesFor(base: DB, t: Tenant): Promise<Notice[]> {
  const at = now();
  const out: Notice[] = await base.all('SELECT id, tenant_id, kind, title, message, starts_at, ends_at FROM platform_notices WHERE (tenant_id IS NULL OR tenant_id = ?) AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC',
    [t.id, at, at]);
  if (!t.billing_exempt && t.status === 'ACTIVE') {
    const a = access(t);
    if (a.trialEndsAt && !(t.subscription_status === 'active') && days(a.trialEndsAt) <= 5) {
      const d = Math.max(1, days(a.trialEndsAt));
      out.push({ id: `auto-trial-${a.trialEndsAt.slice(0, 10)}`, tenant_id: t.id, kind: 'billing', title: `Seu teste grátis termina em ${plural(d)}`,
        message: 'Assine em Administração › Assinatura para continuar usando sem interrupção.', starts_at: at, ends_at: a.trialEndsAt });
    } else if (t.subscription_status === 'active' && t.current_period_end && days(t.current_period_end) <= 3 && days(t.current_period_end) >= 0) {
      const d = Math.max(1, days(t.current_period_end));
      out.push({ id: `auto-renew-${t.current_period_end.slice(0, 10)}`, tenant_id: t.id, kind: 'billing', title: `Sua assinatura renova em ${plural(d)}`,
        message: 'Confira se o cartão cadastrado está em dia para não ter interrupção.', starts_at: at, ends_at: t.current_period_end });
    }
  }
  return out;
}

// ---------- Notas internas ----------

export const listNotes = (base: DB, tenantId: number) => base.all(
  'SELECT n.id, n.text, n.at, a.name AS admin_name FROM tenant_notes n LEFT JOIN platform_admins a ON a.id = n.admin_id WHERE n.tenant_id = ? ORDER BY n.id DESC LIMIT 200', [tenantId]);

export async function addNote(base: DB, tenantId: number, text: string, adminId: number) {
  if (!(await getTenant(base, tenantId))) throw notFound('Estabelecimento não encontrado.');
  await base.run('INSERT INTO tenant_notes (tenant_id, admin_id, text, at) VALUES (?,?,?,?)', [tenantId, adminId, text.trim(), now()]);
}

export async function deleteNote(base: DB, tenantId: number, noteId: number) {
  const r = await base.run('DELETE FROM tenant_notes WHERE id = ? AND tenant_id = ?', [noteId, tenantId]);
  if (!r.rowCount) throw notFound('Nota não encontrada.');
}

// ---------- Saúde de cada cliente: primeiros passos e risco de cancelar ----------

export interface Health {
  products: number; users: number; cashOpened: boolean; firstSaleAt: string | null; lastSaleAt: string | null; salesLast30: number;
  steps: { key: string; label: string; done: boolean }[]; risk: 'ok' | 'attention' | 'risk'; reasons: string[];
}

export async function tenantHealth(base: DB, t: Tenant): Promise<Health> {
  const s = await withSchema(base, t.schema_name, async (db) => ({
    products: (await db.one('SELECT COUNT(*)::int AS n FROM products WHERE active = 1')).n as number,
    users: (await db.one('SELECT COUNT(*)::int AS n FROM users WHERE active = 1')).n as number,
    cashOpened: !!(await db.one('SELECT 1 AS x FROM cash_registers LIMIT 1')),
    firstSaleAt: ((await db.one('SELECT MIN(created_at) AS at FROM sales'))?.at ?? null) as string | null,
    lastSaleAt: ((await db.one('SELECT MAX(created_at) AS at FROM sales'))?.at ?? null) as string | null,
    salesLast30: (await db.one("SELECT COUNT(*)::int AS n FROM sales WHERE status = 'COMPLETED' AND created_at >= ?", [new Date(Date.now() - 30 * 864e5).toISOString()])).n as number,
  })).catch(() => ({ products: 0, users: 0, cashOpened: false, firstSaleAt: null, lastSaleAt: null, salesLast30: 0 }));
  const steps = [
    { key: 'products', label: 'Cadastrou produtos', done: s.products >= 5 },
    { key: 'team', label: 'Criou a equipe', done: s.users >= 2 },
    { key: 'cash', label: 'Abriu o caixa', done: s.cashOpened },
    { key: 'sale', label: 'Fez a primeira venda', done: !!s.firstSaleAt },
    { key: 'paid', label: 'Assinatura em dia', done: !!t.billing_exempt || t.subscription_status === 'active' },
  ];
  const reasons: string[] = [];
  const ageDays = (Date.now() - Date.parse(t.created_at)) / 864e5;
  const idle = s.lastSaleAt ? (Date.now() - Date.parse(s.lastSaleAt)) / 864e5 : null;
  if (!access(t).ok) reasons.push('Fora do ar');
  if (idle !== null && idle >= 7) reasons.push(`Sem vender há ${Math.floor(idle)} dias`);
  if (!s.firstSaleAt && ageDays >= 3) reasons.push('Ainda não fez nenhuma venda');
  if (s.products < 5 && ageDays >= 2) reasons.push('Poucos produtos cadastrados');
  if (t.subscription_status === 'past_due' || t.subscription_status === 'unpaid') reasons.push('Pagamento recusado');
  const risk = reasons.some((r) => /Fora do ar|Pagamento|Sem vender/.test(r)) ? 'risk' : reasons.length ? 'attention' : 'ok';
  return { ...s, steps, risk, reasons };
}

// ---------- Histórico de ações do painel ----------

export const auditLog = (base: DB, limit = 200) => base.all(
  `SELECT p.id, p.action, p.tenant_id, t.name AS tenant_name, a.name AS admin_name, p.details_json, p.at
   FROM platform_audit p LEFT JOIN platform_admins a ON a.id = p.admin_id LEFT JOIN tenants t ON t.id = p.tenant_id
   ORDER BY p.id DESC LIMIT ?`, [limit]);

// ---------- Crescimento (últimos 12 meses) ----------

export async function growth(base: DB) {
  const rows = await base.all<{ created_at: string; signup_source: string | null; canceled_at: string | null }>('SELECT created_at, signup_source, canceled_at FROM tenants');
  const months: { month: string; site: number; central: number; canceled: number }[] = [];
  const d = new Date();
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    months.push({ month: m, site: 0, central: 0, canceled: 0 });
  }
  const idx = new Map(months.map((m, i) => [m.month, i]));
  for (const r of rows) {
    const i = idx.get(r.created_at.slice(0, 7));
    if (i !== undefined) months[i][r.signup_source === 'site' ? 'site' : 'central']++;
    const c = r.canceled_at ? idx.get(r.canceled_at.slice(0, 7)) : undefined;
    if (c !== undefined) months[c].canceled++;
  }
  return { months, total: rows.length };
}

// ---------- Financeiro (Stripe) ----------

export async function finance(base: DB, f: Fetch) {
  if (!stripeConfigured()) return { configured: false as const };
  const nowS = Math.floor(Date.now() / 1000);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [paid, active, pastDue] = await Promise.all([
    stripeList(f, '/invoices', { status: 'paid', 'created[gte]': Math.floor(monthStart.getTime() / 1000) }),
    stripeList(f, '/subscriptions', { status: 'active' }),
    stripeList(f, '/subscriptions', { status: 'past_due' }),
  ]);
  const tenants = await base.all<{ id: number; name: string; stripe_customer_id: string | null; contact_phone: string | null; canceled_at: string | null }>(
    'SELECT id, name, stripe_customer_id, contact_phone, canceled_at FROM tenants');
  const byCustomer = new Map(tenants.filter((t) => t.stripe_customer_id).map((t) => [t.stripe_customer_id!, t]));
  const who = (customer: string) => byCustomer.get(customer) ?? null;
  const periodEnd = (s: any) => s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;
  const subValue = (s: any) => (s.items?.data ?? []).reduce((a: number, it: any) => a + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
  return {
    configured: true as const,
    receivedThisMonthCents: paid.reduce((a: number, i: any) => a + (i.amount_paid ?? 0), 0),
    invoicesThisMonth: paid.length,
    mrrCents: active.reduce((a: number, s: any) => a + subValue(s), 0),
    activeCount: active.length,
    pastDue: pastDue.map((s: any) => ({ tenant: who(s.customer), amountCents: subValue(s), since: periodEnd(s) ? new Date(periodEnd(s) * 1000).toISOString() : null })),
    upcoming: active.filter((s: any) => periodEnd(s) && periodEnd(s) - nowS < 7 * 86400)
      .map((s: any) => ({ tenant: who(s.customer), amountCents: subValue(s), at: new Date(periodEnd(s) * 1000).toISOString(), cancelAtPeriodEnd: !!s.cancel_at_period_end }))
      .sort((a: any, b: any) => a.at.localeCompare(b.at)),
    canceledThisMonth: tenants.filter((t) => t.canceled_at && t.canceled_at >= monthStart.toISOString()).length,
  };
}
