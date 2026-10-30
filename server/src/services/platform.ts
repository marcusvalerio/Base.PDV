import { DB, now, migrateTenant, withSchema } from '../db.js';
import { hashSecret, verifySecret, newToken, sha256 } from '../security.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { createUser } from './users.js';
import { setSetting } from './settings.js';
import { setModules, MODULES } from './modules.js';
import { newTotpSecret, verifyTotp, otpauthUrl } from '../totp.js';

/**
 * Plataforma: estabelecimentos (cada um com schema próprio), administração central e situação da assinatura.
 * Tudo aqui roda no schema public, com o banco "base".
 */
export interface Tenant {
  contact_name?: string | null; contact_phone?: string | null; signup_source?: string | null;
  id: number; name: string; schema_name: string; status: 'ACTIVE' | 'SUSPENDED'; billing_exempt: number;
  trial_ends_at: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null;
  subscription_status: string | null; current_period_end: string | null; created_at: string;
}

/** Status de assinatura do Stripe que liberam o uso. Qualquer outro (past_due, unpaid, canceled…) bloqueia na hora. */
const PAID = new Set(['active', 'trialing']);

export type Access = { ok: boolean; reason: 'OK' | 'SUSPENDED' | 'NO_SUBSCRIPTION' | 'UNPAID'; trialEndsAt: string | null };

export function access(t: Tenant, at = new Date()): Access {
  const trial = t.trial_ends_at && t.trial_ends_at > at.toISOString() ? t.trial_ends_at : null;
  if (t.status === 'SUSPENDED') return { ok: false, reason: 'SUSPENDED', trialEndsAt: null };
  if (t.billing_exempt || (t.subscription_status && PAID.has(t.subscription_status)) || trial) return { ok: true, reason: 'OK', trialEndsAt: trial };
  return { ok: false, reason: t.subscription_status ? 'UNPAID' : 'NO_SUBSCRIPTION', trialEndsAt: null };
}

export const getTenant = (base: DB, id: number) => base.one<Tenant>('SELECT * FROM tenants WHERE id = ?', [id]);

export async function tenantByUsername(base: DB, username: string) {
  return base.one<Tenant>('SELECT t.* FROM user_directory d JOIN tenants t ON t.id = d.tenant_id WHERE d.username_lower = lower(?)', [username.trim()]);
}

/** Reserva o login no diretório global (logins são únicos entre todos os estabelecimentos). */
export async function reserveUsername(base: DB, username: string, tenantId: number) {
  const r = await base.run('INSERT INTO user_directory (username_lower, tenant_id) VALUES (lower(?), ?) ON CONFLICT DO NOTHING', [username.trim(), tenantId]);
  if (!r.rowCount) throw conflict('Este login já está em uso. Escolha outro (ex.: nome.sobrenome.loja).');
}

export async function releaseUsername(base: DB, username: string) {
  await base.run('DELETE FROM user_directory WHERE username_lower = lower(?)', [username.trim()]);
}

export async function createTenant(base: DB, input: {
  name: string; admin?: { name: string; username: string; password: string };
  trialDays?: number; exempt?: boolean; modules?: Partial<Record<string, boolean>>;
  contact?: { name?: string; phone?: string }; source?: 'central' | 'site';
}, actorId: number | null) {
  const t = await base.one<{ id: number }>(
    "INSERT INTO tenants (name, schema_name, billing_exempt, trial_ends_at, contact_name, contact_phone, signup_source, created_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?) RETURNING id",
    [input.name.trim(), input.exempt ? 1 : 0, input.trialDays ? new Date(Date.now() + input.trialDays * 864e5).toISOString() : null,
      input.contact?.name ?? input.admin?.name ?? null, input.contact?.phone ?? null, input.source ?? 'central', now()],
  );
  const schema = `t_${t!.id}`;
  await base.run('UPDATE tenants SET schema_name = ? WHERE id = ?', [schema, t!.id]);
  try {
    await migrateTenant(base, schema);
    if (input.admin) await reserveUsername(base, input.admin.username, t!.id);
    await withSchema(base, schema, async (db) => {
      await setSetting(db, 'store_name', input.name.trim(), null);
      const mods = input.modules ?? Object.fromEntries(Object.keys(MODULES).map((k) => [k, k !== 'auditoria']));
      await setModules(db, mods, null);
      if (input.admin) await createUser(db, { ...input.admin, role: 'ADMIN' }, null);
    });
  } catch (e) {
    // Desfaz o estabelecimento criado pela metade.
    if (input.admin) await releaseUsername(base, input.admin.username).catch(() => {});
    await base.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await base.run('DELETE FROM tenants WHERE id = ?', [t!.id]).catch(() => {});
    throw e;
  }
  await platformAudit(base, actorId, 'tenant.create', t!.id, { name: input.name, exempt: !!input.exempt, trialDays: input.trialDays ?? null });
  return t!.id;
}

export async function updateTenant(base: DB, id: number, patch: { name?: string; status?: 'ACTIVE' | 'SUSPENDED'; billing_exempt?: boolean; trial_ends_at?: string | null }, actorId: number) {
  const t = await getTenant(base, id);
  if (!t) throw notFound('Estabelecimento não encontrado.');
  await base.run('UPDATE tenants SET name = ?, status = ?, billing_exempt = ?, trial_ends_at = ? WHERE id = ?', [
    patch.name?.trim() ?? t.name, patch.status ?? t.status, patch.billing_exempt === undefined ? t.billing_exempt : patch.billing_exempt ? 1 : 0,
    patch.trial_ends_at === undefined ? t.trial_ends_at : patch.trial_ends_at, id,
  ]);
  if (patch.name) await withSchema(base, t.schema_name, (db) => setSetting(db, 'store_name', patch.name!.trim(), null));
  await platformAudit(base, actorId, 'tenant.update', id, patch);
}

export async function listTenants(base: DB) {
  const rows = await base.all<Tenant>('SELECT * FROM tenants ORDER BY name');
  const out = [];
  for (const t of rows) {
    const stats = await withSchema(base, t.schema_name, async (db) => ({
      users: (await db.one('SELECT COUNT(*)::int AS n FROM users WHERE active = 1')).n as number,
      lastSaleAt: ((await db.one('SELECT MAX(created_at) AS at FROM sales'))?.at ?? null) as string | null,
      salesLast30: (await db.one("SELECT COUNT(*)::int AS n FROM sales WHERE status = 'COMPLETED' AND created_at >= ?", [new Date(Date.now() - 30 * 864e5).toISOString()])).n as number,
    })).catch(() => ({ users: 0, lastSaleAt: null, salesLast30: 0 }));
    out.push({ ...t, access: access(t), ...stats });
  }
  return out;
}

// ---------- Administradores centrais ----------

const SESSION_HOURS = 12;

export async function platformAudit(base: DB, adminId: number | null, action: string, tenantId: number | null, details?: unknown) {
  await base.run('INSERT INTO platform_audit (admin_id, action, tenant_id, details_json, at) VALUES (?,?,?,?,?)',
    [adminId, action, tenantId, details === undefined ? null : JSON.stringify(details), now()]);
}

export async function createPlatformAdmin(base: DB, input: { name: string; username: string; password: string }) {
  if (input.password.length < 8) throw badRequest('A senha deve ter pelo menos 8 caracteres.');
  const r = await base.one<{ id: number }>('INSERT INTO platform_admins (name, username, password_hash, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',
    [input.name.trim(), input.username.trim(), hashSecret(input.password), now()]);
  if (!r) throw conflict('Já existe um administrador central com este login.');
  return r.id;
}

/** Código da verificação em duas etapas: confere e marca como usado (o mesmo código não serve duas vezes). */
async function useTotp(base: DB, a: { id: number; totp_secret: string; totp_last_step: number | null }, code: string) {
  const step = verifyTotp(a.totp_secret, code);
  if (step === null || (a.totp_last_step != null && step <= a.totp_last_step)) return false;
  const r = await base.run('UPDATE platform_admins SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, a.id, step]);
  return r.rowCount > 0;
}

/**
 * Login do painel central. Com a verificação em duas etapas ligada, senha certa sem código devolve "totpRequired"
 * (a tela pede o código do aplicativo); código errado conta como tentativa falha.
 */
export async function platformLogin(base: DB, username: string, password: string, code?: string) {
  const a = await base.one('SELECT * FROM platform_admins WHERE lower(username) = lower(?)', [username.trim()]);
  const ok = verifySecret(password, a?.password_hash ?? 'scrypt$AAAA$AAAA');
  if (!a || !ok || !a.active) { await platformAudit(base, a?.id ?? null, 'central.login_failed', null, { username }); return null; }
  if (a.totp_enabled) {
    if (!code) return { totpRequired: true as const };
    if (!(await useTotp(base, a, code))) { await platformAudit(base, a.id, 'central.totp_failed', null); return null; }
  }
  const token = newToken();
  const t = new Date();
  await base.run('INSERT INTO platform_sessions (token_hash, admin_id, created_at, expires_at) VALUES (?,?,?,?)',
    [sha256(token), a.id, t.toISOString(), new Date(t.getTime() + SESSION_HOURS * 3600e3).toISOString()]);
  await base.run('DELETE FROM platform_sessions WHERE expires_at < ?', [t.toISOString()]);
  await platformAudit(base, a.id, 'central.login', null);
  return { token, admin: { id: a.id as number, name: a.name as string, username: a.username as string } };
}

export async function platformAdminFromToken(base: DB, token: string | undefined) {
  if (!token) return null;
  const a = await base.one(`SELECT a.id, a.name, a.username FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1`, [sha256(token), now()]);
  return a ? { id: a.id as number, name: a.name as string, username: a.username as string } : null;
}

export async function platformLogout(base: DB, token: string) {
  await base.run('DELETE FROM platform_sessions WHERE token_hash = ?', [sha256(token)]);
}

// ---------- Números da plataforma e erros ----------

/** Resumo para o painel central: assinantes, teste, isentos, fora do ar, receita mensal estimada e erros recentes. */
export async function overview(base: DB) {
  const rows = await base.all<Tenant>('SELECT * FROM tenants');
  const price = Number(process.env.MONTHLY_PRICE_CENTS || 8000);
  const c = { total: rows.length, paying: 0, trial: 0, exempt: 0, blocked: 0, suspended: 0 };
  for (const t of rows) {
    const a = access(t);
    if (t.status === 'SUSPENDED') c.suspended++;
    else if (t.billing_exempt) c.exempt++;
    else if (t.subscription_status === 'active') c.paying++;
    else if (a.ok) c.trial++;
    if (!a.ok) c.blocked++;
  }
  const since = new Date(Date.now() - 864e5).toISOString();
  const errors24h = (await base.one('SELECT COUNT(*)::int AS n FROM platform_errors WHERE at >= ?', [since])).n as number;
  return { ...c, monthlyRevenueCents: c.paying * price, priceCents: price, errors24h };
}

export async function logError(base: DB, e: { tenantId?: number | null; method?: string; path?: string; message: string; stack?: string }) {
  await base.run('INSERT INTO platform_errors (tenant_id, method, path, message, stack, at) VALUES (?,?,?,?,?,?)',
    [e.tenantId ?? null, e.method ?? null, e.path?.slice(0, 300) ?? null, e.message.slice(0, 1000), e.stack?.slice(0, 4000) ?? null, now()]);
  // Mantém só os últimos 30 dias.
  await base.run('DELETE FROM platform_errors WHERE at < ?', [new Date(Date.now() - 30 * 864e5).toISOString()]);
}

export const recentErrors = (base: DB) => base.all(
  'SELECT e.id, e.tenant_id, t.name AS tenant_name, e.method, e.path, e.message, e.at FROM platform_errors e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.id DESC LIMIT 100');

// ---------- Limite de tentativas (compartilhado entre instâncias) ----------

/** Está bloqueado? (ex.: muitas senhas erradas). */
export async function isLimited(base: DB, key: string) {
  const r = await base.one<{ blocked_until: string | null }>('SELECT blocked_until FROM rate_limits WHERE key = ?', [key]);
  return !!r?.blocked_until && r.blocked_until > now();
}

/** Conta uma ocorrência na janela; ao chegar em "max", bloqueia por "blockMs". Devolve true se ficou bloqueado. */
export async function hitLimit(base: DB, key: string, max: number, windowMs: number, blockMs: number) {
  const t = Date.now();
  const r = await base.one<{ hits: number }>(`INSERT INTO rate_limits (key, hits, window_start) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.hits + 1 END,
      window_start = CASE WHEN rate_limits.window_start < ? THEN EXCLUDED.window_start ELSE rate_limits.window_start END
    RETURNING hits`, [key, new Date(t).toISOString(), new Date(t - windowMs).toISOString(), new Date(t - windowMs).toISOString()]);
  if (r!.hits < max) return false;
  await base.run('UPDATE rate_limits SET blocked_until = ? WHERE key = ?', [new Date(t + blockMs).toISOString(), key]);
  // Limpeza ocasional de registros antigos.
  if (Math.random() < 0.05) await base.run('DELETE FROM rate_limits WHERE window_start < ? AND (blocked_until IS NULL OR blocked_until < ?)', [new Date(t - 864e5).toISOString(), new Date(t).toISOString()]);
  return true;
}

export async function clearLimit(base: DB, key: string) {
  await base.run('DELETE FROM rate_limits WHERE key = ?', [key]);
}

// ---------- Verificação em duas etapas (opcional) ----------

export async function totpStatus(base: DB, adminId: number) {
  const a = await base.one('SELECT totp_enabled FROM platform_admins WHERE id = ?', [adminId]);
  return { enabled: !!a?.totp_enabled };
}

/** Gera um segredo novo (ainda desligado) e devolve o link para o QR Code do aplicativo. */
export async function totpBegin(base: DB, adminId: number) {
  const a = await base.one('SELECT username, totp_enabled FROM platform_admins WHERE id = ?', [adminId]);
  if (!a) throw notFound('Administrador não encontrado.');
  if (a.totp_enabled) throw conflict('A verificação em duas etapas já está ligada.');
  const secret = newTotpSecret();
  await base.run('UPDATE platform_admins SET totp_secret = ?, totp_last_step = NULL WHERE id = ?', [secret, adminId]);
  return { secret, url: otpauthUrl(secret, a.username) };
}

/** Liga depois de conferir o primeiro código (prova que o aplicativo foi configurado certo). */
export async function totpEnable(base: DB, adminId: number, code: string) {
  const a = await base.one('SELECT id, totp_secret, totp_last_step, totp_enabled FROM platform_admins WHERE id = ?', [adminId]);
  if (!a?.totp_secret || a.totp_enabled) throw badRequest('Comece a configuração de novo.');
  if (!(await useTotp(base, a, code))) throw badRequest('Código incorreto. Confira o horário do celular e tente o código atual.');
  await base.run('UPDATE platform_admins SET totp_enabled = 1 WHERE id = ?', [adminId]);
  await platformAudit(base, adminId, 'central.totp_enabled', null);
}

/** Desligar pede a senha e um código atual. */
export async function totpDisable(base: DB, adminId: number, password: string, code: string) {
  const a = await base.one('SELECT * FROM platform_admins WHERE id = ?', [adminId]);
  if (!a?.totp_enabled) throw badRequest('A verificação em duas etapas já está desligada.');
  if (!verifySecret(password, a.password_hash) || !(await useTotp(base, a, code))) throw badRequest('Senha ou código incorretos.');
  await base.run('UPDATE platform_admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?', [adminId]);
  await platformAudit(base, adminId, 'central.totp_disabled', null);
}

