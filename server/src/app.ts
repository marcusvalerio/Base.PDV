import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB, audit, tenantAware, tenantStore, withSchema } from './db.js';
import * as platform from './services/platform.js';
import * as stripe from './services/stripe.js';
import { AppError, forbidden, unauthorized, badRequest } from './errors.js';
import { UNITS } from './money.js';
import * as users from './services/users.js';
import * as settings from './services/settings.js';
import * as products from './services/products.js';
import * as stock from './services/stock.js';
import * as sales from './services/sales.js';
import * as customers from './services/customers.js';
import * as cash from './services/cash.js';
import * as tabs from './services/tabs.js';
import * as analytics from './services/analytics.js';
import { rangeToUtc } from './tz.js';
import { hashSecret } from './security.js';
import { timingSafeEqual } from 'node:crypto';
import * as modules from './services/modules.js';
import * as inventory from './services/inventory.js';

declare global {
  namespace Express { interface Request { user?: users.SessionUser; token?: string; tenant?: platform.Tenant; central?: { id: number; name: string; username: string }; rawBody?: Buffer } }
}

export const COOKIE = 'pdv_session';
export const CENTRAL_COOKIE = 'pdv_central';

const id = z.coerce.number().int().positive();
const cents = z.number().int().min(0).max(100_000_000);
const qty = z.number().int().positive().max(1_000_000_000);
const idemKey = z.string().min(8).max(100);
const lines = z.array(z.object({ productId: id, qtyMilli: qty })).min(1).max(200);

const productSchema = z.object({
  name: z.string().trim().min(1).max(120),
  internal_code: z.string().trim().max(40).nullish(),
  barcode: z.string().trim().max(40).nullish(),
  category_id: id,
  unit: z.enum(UNITS as [string, ...string[]]),
  price_cents: cents,
  cost_cents: cents.nullish(),
  min_stock_milli: z.number().int().min(0).optional(),
  track_expiry: z.boolean().optional(),
  active: z.boolean().optional(),
  initial_stock_milli: z.number().int().min(0).optional(),
  pack_label: z.string().trim().max(30).nullish(),
  pack_size_milli: z.number().int().positive().nullish(),
  stock_source_id: id.nullish(),
  stock_source_qty_milli: z.number().int().positive().nullish(),
  image_url: z.union([z.string().trim().regex(/^art:[a-z0-9-]{1,40}$/), z.string().trim().max(500).url('Link da imagem inválido.').refine((u) => /^https:\/\//.test(u), 'Use um link https://')]).nullish().or(z.literal('')),
});

/** Limite simples de tentativas de login por IP+usuário (memória do processo). */
const attempts = new Map<string, { n: number; until: number }>();

export function createApp(base: DB, opts: { cookieSecure?: boolean; staticDir?: string; fetch?: stripe.Fetch } = {}) {
  // "db" usa automaticamente o schema do estabelecimento da requisição; "base" é a plataforma (schema public).
  const db = tenantAware(base);
  const sfetch: stripe.Fetch = opts.fetch ?? fetch;
  const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, secure: !!opts.cookieSecure, maxAge: 12 * 3600e3, path: '/' };
  const app = express();
  app.disable('x-powered-by');
  // Atrás do proxy da Vercel: IP real do cliente (limite de tentativas de login).
  app.set('trust proxy', 1);
  // Webhook do Stripe precisa do corpo bruto para validar a assinatura.
  app.use('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, _res, next) => { req.rawBody = req.body; next(); });
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Proteção CSRF: toda requisição que altera dados precisa do cabeçalho customizado (navegadores não o enviam em formulários de outros sites).
  app.use('/api', (req, _res, next) => {
    if (req.path === '/stripe/webhook') return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'pdv') return next(forbidden('Requisição inválida.'));
    next();
  });

  // Sessão do estabelecimento: cookie "<id do estabelecimento>.<token>". A conexão fica presa ao schema dele até o fim da resposta.
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/central') || req.path === '/stripe/webhook') return next();
    const raw = String(req.cookies?.[COOKIE] ?? '');
    const dot = raw.indexOf('.');
    const tenantId = Number(raw.slice(0, dot));
    if (dot < 1 || !Number.isInteger(tenantId) || tenantId <= 0) return next();
    (async () => {
      const t = await platform.getTenant(base, tenantId);
      if (!t) return next();
      const h = await base.scope!(t.schema_name);
      let released = false;
      const release = () => { if (!released) { released = true; h.release().catch(() => {}); } };
      res.once('finish', release);
      res.once('close', release);
      tenantStore.run({ db: h.db }, () => {
        const token = raw.slice(dot + 1);
        users.userFromToken(h.db, token).then((u) => {
          if (u) { req.user = u; req.token = token; req.tenant = t; }
          next();
        }, (e) => { release(); next(e); });
      });
    })().catch(next);
  });

  // Assinatura: sem pagamento em dia (ou suspenso pelo admin central), o sistema fica fora do ar para o estabelecimento.
  const OPEN_WHEN_BLOCKED = /^\/(auth\/|billing\/|bootstrap$|public\/)/;
  app.use('/api', (req, _res, next) => {
    if (!req.tenant || OPEN_WHEN_BLOCKED.test(req.path)) return next();
    const a = platform.access(req.tenant);
    if (a.ok) return next();
    next(new AppError(402, 'SUBSCRIPTION_INACTIVE', a.reason === 'SUSPENDED'
      ? 'Este estabelecimento está suspenso. Fale com o suporte do Central.PDV.'
      : 'A assinatura do Central.PDV não está em dia. O administrador precisa regularizar o pagamento.'));
  });

  const auth = (req: Request, _res: Response, next: NextFunction) => (req.user ? next() : next(unauthorized()));
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== 'ADMIN') {
      audit(db, req.user.id, 'auth.forbidden', null, null, { path: req.path, method: req.method }).catch(() => {});
      return next(forbidden());
    }
    next();
  };
  /** Bloqueia no servidor rotas de módulos não liberados pelo super administrador. */
  const mod = (k: modules.ModuleKey) => (_req: Request, _res: Response, next: NextFunction) => {
    modules.requireModule(db, k).then(() => next(), next);
  };
  const uid = (req: Request) => req.user!.id;
  const isAdmin = (req: Request) => req.user?.role === 'ADMIN';
  const r = express.Router();
  // Express 4 não captura promessas rejeitadas: encaminha erros de handlers assíncronos.
  for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const orig = (r as any)[m].bind(r);
    (r as any)[m] = (path: string, ...hs: any[]) => orig(path, ...hs.map((h) => (req: Request, res: Response, next: NextFunction) => {
      try { const out = h(req, res, next); if (out && typeof out.then === 'function') out.catch(next); } catch (e) { next(e); }
    }));
  }

  r.use('/tabs', mod('mesas'));
  r.use('/customers', mod('fiado'));
  r.use('/stock', mod('estoque'));
  r.use('/inventory', mod('inventario'));
  r.use('/analytics', mod('analise'));
  r.use('/restock', mod('reposicao'));
  r.use('/audit', mod('auditoria'));

  // Informações públicas (tela de entrada): nome e logo do estabelecimento do último acesso, se houver sessão.
  r.get('/public/info', async (req, res) => res.json(req.tenant ? {
    storeName: await settings.getSetting(db, 'store_name'),
    storeLogo: await settings.getSetting(db, 'store_logo_url'),
  } : { storeName: '', storeLogo: '' }));
  r.get('/setup/status', async (_req, res) => res.json({ needed: false, enabled: false }));

  // ---------- Autenticação (estabelecimento) ----------
  r.post('/auth/login', async (req, res) => {
    const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw new AppError(429, 'TOO_MANY', 'Muitas tentativas. Aguarde alguns minutos.');
    const t = await platform.tenantByUsername(base, body.username);
    const result = t ? await withSchema(base, t.schema_name, (tdb) => users.login(tdb, body.username, body.password)) : null;
    if (!t || !result) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
      throw unauthorized('Usuário ou senha incorretos.');
    }
    attempts.delete(key);
    res.cookie(COOKIE, `${t.id}.${result.token}`, cookieOpts);
    res.json({ user: result.user });
  });
  r.post('/auth/logout', async (req, res) => {
    if (req.token) await users.logout(db, req.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  r.get('/auth/me', auth, async (req, res) => res.json({ user: req.user, access: platform.access(req.tenant!) }));

  // ---------- Assinatura do estabelecimento (administrador) ----------
  r.get('/billing/status', admin, async (req, res) => {
    const t = (await platform.getTenant(base, req.tenant!.id))!;
    res.json({ access: platform.access(t), status: t.subscription_status, currentPeriodEnd: t.current_period_end, exempt: !!t.billing_exempt,
      hasCustomer: !!t.stripe_customer_id, configured: stripe.stripeConfigured(), trialEndsAt: t.trial_ends_at });
  });
  r.post('/billing/checkout', admin, async (req, res) => res.json({ url: await stripe.checkoutUrl(base, sfetch, req.tenant!.id) }));
  r.post('/billing/portal', admin, async (req, res) => res.json({ url: await stripe.portalUrl(base, sfetch, req.tenant!.id) }));

  // ---------- Dados básicos para o PDV ----------
  r.get('/bootstrap', auth, async (_req, res) => {
    const mods = await modules.getModules(db);
    res.json({
      modules: mods,
      paymentMethods: (await db.all('SELECT code, name, kind FROM payment_methods WHERE active = 1 ORDER BY sort')).filter((m) => m.kind !== 'CREDIT' || mods.fiado),
      categories: await db.all('SELECT * FROM categories WHERE active = 1 ORDER BY name'),
      fiadoSurchargeCents: Number(await settings.getSetting(db, 'fiado_surcharge_cents') || 0),
      cardSurcharge: {
        CARTAO_DEBITO: { mode: await settings.getSetting(db, 'card_debit_surcharge_mode'), value: Number(await settings.getSetting(db, 'card_debit_surcharge_value') || 0) },
        CARTAO_CREDITO: { mode: await settings.getSetting(db, 'card_credit_surcharge_mode'), value: Number(await settings.getSetting(db, 'card_credit_surcharge_value') || 0) },
      },
      cashCodeMode: await settings.getSetting(db, 'cash_code_mode'),
      storeName: await settings.getSetting(db, 'store_name'),
      storeLogo: await settings.getSetting(db, 'store_logo_url'),
    });
  });

  // ---------- Produtos e categorias ----------
  r.get('/products/by-code/:code', auth, async (req, res) => {
    const code = String(req.params.code).trim().slice(0, 60);
    const p = await db.one('SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id WHERE p.barcode = ? OR p.internal_code = ?', [code, code]);
    if (!p) throw new AppError(404, 'NOT_FOUND', `Código ${code} não cadastrado.`);
    res.json(isAdmin(req) ? p : products.publicProduct(p));
  });
  r.get('/products', auth, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined;
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
    const list = await products.listProducts(db, { q, categoryId, includeInactive: isAdmin(req) && req.query.all === '1' });
    res.json(isAdmin(req) ? list : list.map(products.publicProduct));
  });
  r.post('/products', admin, async (req, res) => res.status(201).json({ id: await products.createProduct(db, productSchema.parse(req.body) as any, uid(req)) }));
  r.patch('/products/:id', admin, async (req, res) => {
    await products.updateProduct(db, id.parse(req.params.id), productSchema.omit({ initial_stock_milli: true }).partial().parse(req.body) as any, uid(req));
    res.json({ ok: true });
  });
  r.get('/products/:id/history', admin, async (req, res) => res.json(await products.productHistory(db, id.parse(req.params.id))));

  r.get('/categories', auth, async (req, res) => res.json(await db.all(`SELECT * FROM categories ${isAdmin(req) ? '' : 'WHERE active = 1'} ORDER BY name`)));
  r.post('/categories', admin, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    if (await db.one('SELECT 1 FROM categories WHERE lower(name) = lower(?)', [b.name])) throw badRequest('Categoria já existe.');
    const x = { lastInsertRowid: (await db.one('INSERT INTO categories (name) VALUES (?) RETURNING id', [b.name])).id };
    await audit(db, uid(req), 'category.create', 'category', x.lastInsertRowid, b);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/categories/:id', admin, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() }).parse(req.body);
    const cid = id.parse(req.params.id);
    const c = await db.one('SELECT * FROM categories WHERE id = ?', [cid]);
    if (!c) throw badRequest('Categoria não encontrada.');
    await db.run('UPDATE categories SET name = ?, active = ? WHERE id = ?', [b.name ?? c.name, b.active === undefined ? c.active : b.active ? 1 : 0, cid]);
    await audit(db, uid(req), 'category.update', 'category', cid, b);
    res.json({ ok: true });
  });

  // ---------- Vendas ----------
  r.post('/sales', auth, async (req, res) => {
    const b = z.object({
      idempotencyKey: idemKey, paymentMethodCode: z.string().max(20), items: lines,
      customerId: id.nullish(), receivedCents: cents.nullish(),
      // Venda feita sem internet: horário real da venda no aparelho (aceito até 3 dias atrás).
      offlineAt: z.string().datetime().optional(),
    }).parse(req.body);
    if ((await sales.getPaymentMethod(db, b.paymentMethodCode)).kind === 'CREDIT') await modules.requireModule(db, 'fiado');
    const sale = await sales.createSale(db, b, uid(req));
    if (b.offlineAt && !sale.replayed) {
      const at = Date.parse(b.offlineAt);
      if (at > Date.now() - 3 * 864e5 && at < Date.now() + 5 * 60e3) {
        const iso = new Date(at).toISOString();
        await db.run('UPDATE sales SET created_at = ? WHERE id = ?', [iso, sale.id]);
        await db.run("UPDATE stock_movements SET at = ? WHERE ref_type = 'sale' AND type = 'SALE' AND ref_id = ?", [iso, sale.id]);
        sale.created_at = iso;
      }
      await audit(db, uid(req), 'sale.offline_sync', 'sale', sale.id, { offlineAt: b.offlineAt });
    }
    res.status(sale.replayed ? 200 : 201).json(sale);
  });
  r.get('/sales', auth, async (req, res) => {
    const q = z.object({
      registerId: z.coerce.number().int().positive().optional(), userId: z.coerce.number().int().positive().optional(),
      categoryId: z.coerce.number().int().positive().optional(), kind: z.enum(['CASH', 'PIX', 'CARD', 'CREDIT']).optional(),
      origin: z.enum(['BALCAO', 'MESA']).optional(), status: z.enum(['COMPLETED', 'CANCELLED']).optional(),
      customer: z.string().trim().max(60).optional(),
      preset: z.enum(['all', 'today', '7d', '15d', '30d', 'month', 'custom']).default('all'), from: z.string().optional(), to: z.string().optional(),
    }).parse(req.query);
    let range: { start?: string; end?: string } = {};
    if (q.preset !== 'all') { const pr = analytics.resolvePeriod(q.preset, q.from, q.to); range = rangeToUtc(pr.from, pr.to); }
    const f = { ...q, ...range, customer: q.customer || undefined };
    if (isAdmin(req)) return res.json(await sales.listSales(db, { ...f, limit: 500 }));
    // Operador: só as vendas do próprio caixa aberto.
    const reg = await cash.currentRegister(db, uid(req));
    res.json(reg ? await sales.listSales(db, { ...f, userId: undefined, registerId: reg.id, limit: 500 }) : []);
  });
  r.get('/sales/:id', auth, async (req, res) => {
    const s = await sales.getSale(db, id.parse(req.params.id));
    if (!isAdmin(req) && (await cash.currentRegister(db, uid(req)))?.id !== s.register_id) throw forbidden();
    if (!isAdmin(req)) s.items = s.items.map(({ unit_cost_cents, ...x }: any) => x);
    res.json(s);
  });
  r.post('/sales/:id/cancel', auth, async (req, res) => {
    const b = z.object({ reason: z.string().trim().min(3).max(300), code: z.string().max(20) }).parse(req.body);
    const sid = id.parse(req.params.id);
    if (!isAdmin(req) && (await cash.currentRegister(db, uid(req)))?.id !== (await sales.getSale(db, sid)).register_id) throw forbidden('Você só pode cancelar vendas do seu caixa.');
    res.json(await sales.cancelSale(db, sid, b.reason, b.code, uid(req)));
  });

  // ---------- Clientes e fiado ----------
  r.get('/customers', auth, async (req, res) => res.json(await customers.listCustomers(db, {
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined, includeInactive: isAdmin(req) && req.query.all === '1',
  })));
  r.post('/customers', auth, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(30).nullish(), notes: z.string().max(300).nullish() }).parse(req.body);
    res.status(201).json({ id: await customers.createCustomer(db, b, uid(req)) });
  });
  r.patch('/customers/:id', admin, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(100).optional(), phone: z.string().trim().max(30).nullish(), notes: z.string().max(300).nullish(), active: z.boolean().optional() }).parse(req.body);
    await customers.updateCustomer(db, id.parse(req.params.id), b, uid(req));
    res.json({ ok: true });
  });
  r.get('/customers/:id', auth, async (req, res) => res.json(await customers.customerStatement(db, id.parse(req.params.id))));
  r.post('/customers/:id/payments', auth, async (req, res) => {
    const b = z.object({ idempotencyKey: idemKey, amountCents: cents.refine((v) => v > 0), paymentMethodCode: z.string().max(20) }).parse(req.body);
    res.json(await customers.receivePayment(db, { ...b, customerId: id.parse(req.params.id) }, uid(req)));
  });

  // ---------- Caixa ----------
  r.get('/cash/current', auth, async (req, res) => {
    const reg = await cash.currentRegister(db, uid(req));
    res.json(reg ? { ...(await cash.registerSummary(db, reg.id)), openedByName: reg.opened_by_name } : null);
  });
  r.post('/cash/open', auth, async (req, res) => {
    const b = z.object({ code: z.string().max(20), openingFloatCents: cents }).parse(req.body);
    res.status(201).json({ id: await cash.openRegister(db, b, uid(req)) });
  });
  r.post('/cash/movements', auth, async (req, res) => {
    const b = z.object({ type: z.enum(['SUPRIMENTO', 'SANGRIA']), amountCents: cents, reason: z.string().max(200).optional() }).parse(req.body);
    res.status(201).json({ id: await cash.addCashMovement(db, b, uid(req)) });
  });
  r.get('/cash/:id/summary', auth, async (req, res) => {
    const rid = id.parse(req.params.id);
    if (!isAdmin(req) && (await cash.currentRegister(db, uid(req)))?.id !== rid) throw forbidden();
    res.json(await cash.registerSummary(db, rid));
  });
  r.post('/cash/:id/close', auth, async (req, res) => {
    const b = z.object({ code: z.string().max(20), countedCashCents: cents }).parse(req.body);
    res.json(await cash.closeRegister(db, { ...b, registerId: id.parse(req.params.id) }, uid(req)));
  });
  r.get('/cash/active', admin, async (_req, res) => res.json(await cash.openRegisters(db)));
  r.get('/cash', admin, async (req, res) => {
    const q = z.object({
      preset: z.enum(['all', 'today', '7d', '15d', '30d', 'month', 'custom']).default('all'),
      from: z.string().optional(), to: z.string().optional(), userId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    let range: { start?: string; end?: string } = {};
    if (q.preset !== 'all') { const pr = analytics.resolvePeriod(q.preset, q.from, q.to); range = rangeToUtc(pr.from, pr.to); }
    res.json(await cash.listRegisters(db, { ...range, userId: q.userId }));
  });
  r.get('/cash/:id/closing', admin, async (req, res) => {
    const reg = await db.one('SELECT summary_json FROM cash_registers WHERE id = ?', [id.parse(req.params.id)]);
    res.json(reg?.summary_json ? JSON.parse(reg.summary_json) : await cash.registerSummary(db, id.parse(req.params.id)));
  });

  // ---------- Mesas e comandas ----------
  r.get('/tabs', auth, async (_req, res) => res.json(await tabs.listOpenTabs(db)));
  r.post('/tabs', auth, async (req, res) => {
    const b = z.object({ label: z.string().trim().min(1).max(40), people: z.array(z.string().trim().max(60)).max(30).default([]) }).parse(req.body);
    const tid = await tabs.openTab(db, b.label, b.people, uid(req));
    res.status(201).json(await tabs.getTab(db, tid));
  });
  r.get('/tabs/:id', auth, async (req, res) => res.json(await tabs.getTab(db, id.parse(req.params.id))));
  r.post('/tabs/:id/people', auth, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const tid = id.parse(req.params.id);
    await tabs.addPerson(db, tid, b.name, uid(req));
    res.status(201).json(await tabs.getTab(db, tid));
  });
  r.post('/tabs/:id/items', auth, async (req, res) => {
    const b = z.object({ personId: id, items: lines }).parse(req.body);
    res.json(await tabs.addTabItems(db, id.parse(req.params.id), b.personId, b.items, uid(req)));
  });
  r.post('/tabs/:id/items/:itemId/void', auth, async (req, res) => {
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    res.json(await tabs.voidTabItem(db, id.parse(req.params.id), id.parse(req.params.itemId), b.reason, uid(req)));
  });
  r.post('/tabs/:id/close', auth, async (req, res) => {
    const b = z.object({ idempotencyKey: idemKey, personId: id.nullable(), paymentMethodCode: z.string().max(20), customerId: id.nullish(), receivedCents: cents.nullish() }).parse(req.body);
    if ((await sales.getPaymentMethod(db, b.paymentMethodCode)).kind === 'CREDIT') await modules.requireModule(db, 'fiado');
    res.json(await tabs.closeTabBill(db, id.parse(req.params.id), b, uid(req)));
  });
  r.post('/tabs/:id/finish', auth, async (req, res) => res.json(await tabs.finishTab(db, id.parse(req.params.id), uid(req))));

  // ---------- Estoque (administração) ----------
  r.post('/stock/entries', admin, async (req, res) => {
    const b = z.object({ productId: id, qtyMilli: qty, unitCostCents: cents.nullish(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), reason: z.string().max(200).nullish(), updateCost: z.boolean().optional() }).parse(req.body);
    res.status(201).json({ id: await stock.registerEntry(db, b, uid(req)) });
  });
  r.post('/stock/adjustments', admin, async (req, res) => {
    const b = z.object({ productId: id, qtyMilli: z.number().int().refine((v) => v !== 0), type: z.enum(['ADJUST', 'LOSS']), reason: z.string().trim().min(3).max(200) }).parse(req.body);
    res.status(201).json({ id: await stock.registerAdjustment(db, b, uid(req)) });
  });
  r.get('/stock/movements', admin, async (req, res) => {
    const q = z.object({
      productId: z.coerce.number().int().positive().optional(), userId: z.coerce.number().int().positive().optional(),
      categoryId: z.coerce.number().int().positive().optional(), type: z.enum(['SALE', 'SALE_CANCEL', 'ENTRY', 'ADJUST', 'LOSS', 'INVENTORY']).optional(),
      q: z.string().trim().max(60).optional(), preset: z.enum(['all', 'today', '7d', '15d', '30d', 'month', 'custom']).default('all'),
      from: z.string().optional(), to: z.string().optional(),
    }).parse(req.query);
    let range: { start?: string; end?: string } = {};
    if (q.preset !== 'all') { const pr = analytics.resolvePeriod(q.preset, q.from, q.to); range = rangeToUtc(pr.from, pr.to); }
    res.json(await stock.listMovements(db, { ...q, q: q.q || undefined, ...range }));
  });
  r.get('/stock/alerts', admin, async (_req, res) => res.json({ lowStock: await stock.lowStock(db), expiring: await stock.expiringSoon(db) }));

  // ---------- Indicadores ----------
  const analysisQuery = z.object({
    preset: z.enum(['today', '7d', '15d', '30d', 'month', 'custom']).default('7d'),
    from: z.string().optional(), to: z.string().optional(), categoryId: id.optional(), productId: id.optional(),
  });
  r.get('/dashboard', admin, async (_req, res) => res.json(await analytics.dashboard(db)));
  r.get('/analytics', admin, async (req, res) => res.json(await analytics.analysis(db, analysisQuery.parse(req.query) as any)));
  r.get('/restock', admin, async (req, res) => {
    const q = z.object({ windowDays: z.coerce.number().int().optional(), categoryId: id.optional() }).parse(req.query);
    res.json(await analytics.restockSuggestions(db, q));
  });

  // ---------- Usuários e configurações ----------
  const roleSchema = z.enum(['ADMIN', 'OPERADOR']);
  r.get('/users', admin, async (_req, res) => res.json(await users.listUsers(db)));
  r.post('/users', admin, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'Login: use letras, números, ponto, hífen ou _.'), password: z.string().min(8).max(200), role: roleSchema }).parse(req.body);
    await platform.reserveUsername(base, b.username, req.tenant!.id);
    try { res.status(201).json({ id: await users.createUser(db, b, uid(req)) }); }
    catch (e) { await platform.releaseUsername(base, b.username); throw e; }
  });
  r.patch('/users/:id', admin, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), role: roleSchema.optional(), active: z.boolean().optional(), password: z.string().min(8).max(200).optional() }).parse(req.body);
    await users.updateUser(db, id.parse(req.params.id), b, uid(req));
    res.json({ ok: true });
  });
  r.put('/users/:id/cash-code', admin, async (req, res) => {
    const b = z.object({ code: z.string().nullable() }).parse(req.body);
    await users.setUserCashCode(db, id.parse(req.params.id), b.code, uid(req));
    res.json({ ok: true });
  });
  r.get('/settings', admin, async (_req, res) => res.json(await settings.publicSettings(db)));
  r.put('/settings', admin, async (req, res) => {
    const optDays = z.union([z.literal(''), z.coerce.number().int().min(0).max(365).transform(String)]);
    const b = z.object({
      store_name: z.string().trim().max(60).optional(),
      store_logo_url: z.union([z.literal(''), z.string().trim().max(500).url('Link da logo inválido.').refine((u) => /^https:\/\//.test(u), 'Use um link https://')]).optional(),
      fiado_surcharge_cents: z.coerce.number().int().min(0).max(100000).transform(String).optional(),
      cash_code_mode: z.enum(['SHARED', 'INDIVIDUAL']).optional(),
      expiry_alert_days: z.coerce.number().int().min(1).max(365).transform(String).optional(),
      restock_lead_time_days: optDays.optional(),
      restock_safety_days: optDays.optional(),
      allow_negative_stock: z.enum(['true', 'false']).optional(),
      card_debit_surcharge_mode: z.enum(['UNIT', 'PERCENT']).optional(),
      card_credit_surcharge_mode: z.enum(['UNIT', 'PERCENT']).optional(),
      card_debit_surcharge_value: z.coerce.number().int().min(0).max(100000).transform(String).optional(),
      card_credit_surcharge_value: z.coerce.number().int().min(0).max(100000).transform(String).optional(),
      inventory_accuracy_target: z.union([z.literal(''), z.coerce.number().min(0).max(100).transform(String)]).optional(),
    }).parse(req.body);
    for (const [k, v] of Object.entries(b)) if (v !== undefined) await settings.setSetting(db, k, String(v), uid(req));
    res.json(await settings.publicSettings(db));
  });
  r.put('/settings/cash-code', admin, async (req, res) => {
    const b = z.object({ code: z.string().regex(/^\d{4,8}$/, 'O código deve ter de 4 a 8 dígitos.') }).parse(req.body);
    await settings.setSetting(db, 'shared_cash_code_hash', hashSecret(b.code), uid(req));
    res.json({ ok: true });
  });
  r.put('/settings/cancel-code', admin, async (req, res) => {
    const b = z.object({ code: z.string().regex(/^\d{4,8}$/, 'O código deve ter de 4 a 8 dígitos.') }).parse(req.body);
    await settings.setSetting(db, 'cancel_code_hash', hashSecret(b.code), uid(req));
    res.json({ ok: true });
  });
  r.get('/audit', admin, async (_req, res) => res.json(await db.all(
    'SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300',
  )));

  // Módulos liberados para este estabelecimento (só o admin central altera, pelo painel central).
  r.get('/modules', admin, async (_req, res) => res.json({ modules: await modules.getModules(db), labels: modules.MODULES }));

  // ---------- Inventário ----------
  r.get('/inventory', auth, async (_req, res) => res.json(await inventory.listSessions(db)));
  r.get('/inventory-target', auth, async (_req, res) => {
    const v = await settings.getSetting(db, 'inventory_accuracy_target');
    res.json({ targetPct: v === '' ? null : Number(v) });
  });
  r.post('/inventory', admin, async (req, res) => {
    const b = z.object({ name: z.string().max(80).optional(), scope: z.enum(['FULL', 'CATEGORY', 'PARTIAL']), categoryId: id.nullish(), productIds: z.array(id).max(5000).optional(), blind: z.boolean().optional() }).parse(req.body);
    res.status(201).json(await inventory.getSession(db, await inventory.createSession(db, b, uid(req)), { revealSystem: true }));
  });
  r.get('/inventory/:id', auth, async (req, res) => res.json(await inventory.getSession(db, id.parse(req.params.id), { revealSystem: isAdmin(req) })));
  r.post('/inventory/:id/count', auth, async (req, res) => {
    const b = z.object({ productId: id, qtyMilli: z.number().int().min(0).max(1_000_000_000), mode: z.enum(['add', 'set']) }).parse(req.body);
    res.json(await inventory.countItem(db, id.parse(req.params.id), b, uid(req)));
  });
  r.delete('/inventory/:id/count/:productId', auth, async (req, res) => {
    await inventory.clearCount(db, id.parse(req.params.id), id.parse(req.params.productId), uid(req));
    res.json({ ok: true });
  });
  r.post('/inventory/:id/finish', admin, async (req, res) => {
    const b = z.object({ apply: z.boolean() }).parse(req.body);
    res.json(await inventory.finishSession(db, id.parse(req.params.id), b, uid(req)));
  });
  r.post('/inventory/:id/cancel', admin, async (req, res) => { await inventory.cancelSession(db, id.parse(req.params.id), uid(req)); res.json({ ok: true }); });

  // ---------- Painel do administrador central (dono da plataforma) ----------
  const c = express.Router();
  for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const orig = (c as any)[m].bind(c);
    (c as any)[m] = (path: string, ...hs: any[]) => orig(path, ...hs.map((h) => (req: Request, res: Response, next: NextFunction) => {
      try { const out = h(req, res, next); if (out && typeof out.then === 'function') out.catch(next); } catch (e) { next(e); }
    }));
  }
  c.use((req, _res, next) => {
    platform.platformAdminFromToken(base, req.cookies?.[CENTRAL_COOKIE]).then((a) => { if (a) { req.central = a; req.token = req.cookies[CENTRAL_COOKIE]; } next(); }, next);
  });
  const central = (req: Request, _res: Response, next: NextFunction) => (req.central ? next() : next(unauthorized()));
  const loginSchema = z.object({ username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'Login: use letras, números, ponto, hífen ou _.'), password: z.string().min(8).max(200) });

  // Primeiro acesso: cria o administrador central com o SETUP_TOKEN definido no servidor.
  c.get('/setup-status', async (_req, res) => res.json({
    needed: (await base.one('SELECT COUNT(*)::int AS n FROM platform_admins')).n === 0, enabled: !!process.env.SETUP_TOKEN,
  }));
  c.post('/setup', async (req, res) => {
    const b = loginSchema.extend({ token: z.string().min(1).max(200), name: z.string().trim().min(2).max(80) }).parse(req.body);
    const expected = process.env.SETUP_TOKEN;
    if (!expected || b.token.length !== expected.length || !timingSafeEqual(Buffer.from(b.token), Buffer.from(expected))) throw forbidden('Token de configuração inválido.');
    await base.tx(async (t) => {
      await t.exec('SELECT pg_advisory_xact_lock(4242003)');
      if ((await t.one('SELECT COUNT(*)::int AS n FROM platform_admins')).n > 0) throw forbidden('O painel central já foi configurado.');
      await platform.createPlatformAdmin(t, b);
    });
    res.status(201).json({ ok: true });
  });
  c.post('/login', async (req, res) => {
    const b = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const key = `central|${req.ip}|${b.username.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw new AppError(429, 'TOO_MANY', 'Muitas tentativas. Aguarde alguns minutos.');
    const r2 = await platform.platformLogin(base, b.username, b.password);
    if (!r2) { const n = (a?.n ?? 0) + 1; attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 }); throw unauthorized('Usuário ou senha incorretos.'); }
    attempts.delete(key);
    res.cookie(CENTRAL_COOKIE, r2.token, cookieOpts);
    res.json({ admin: r2.admin });
  });
  c.post('/logout', async (req, res) => {
    if (req.central && req.token) await platform.platformLogout(base, req.token);
    res.clearCookie(CENTRAL_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  c.get('/me', central, async (req, res) => res.json({ admin: req.central, stripe: stripe.stripeConfigured() }));

  const tenantId = (req: Request) => id.parse(req.params.id);
  const getT = async (req: Request) => { const t = await platform.getTenant(base, tenantId(req)); if (!t) throw new AppError(404, 'NOT_FOUND', 'Estabelecimento não encontrado.'); return t; };
  c.get('/tenants', central, async (_req, res) => res.json(await platform.listTenants(base)));
  c.post('/tenants', central, async (req, res) => {
    const b = z.object({
      name: z.string().trim().min(2).max(60),
      admin: loginSchema.extend({ name: z.string().trim().min(2).max(80) }),
      trialDays: z.number().int().min(0).max(365).optional(), exempt: z.boolean().optional(),
      modules: z.record(z.boolean()).optional(),
    }).parse(req.body);
    res.status(201).json({ id: await platform.createTenant(base, b, req.central!.id) });
  });
  c.patch('/tenants/:id', central, async (req, res) => {
    const b = z.object({
      name: z.string().trim().min(2).max(60).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      billing_exempt: z.boolean().optional(), trial_ends_at: z.string().datetime().nullable().optional(),
    }).parse(req.body);
    await platform.updateTenant(base, tenantId(req), b, req.central!.id);
    res.json({ ok: true });
  });
  c.get('/tenants/:id/modules', central, async (req, res) => {
    const t = await getT(req);
    res.json({ modules: await withSchema(base, t.schema_name, (tdb) => modules.getModules(tdb)), labels: modules.MODULES });
  });
  c.put('/tenants/:id/modules', central, async (req, res) => {
    const t = await getT(req);
    const b = z.record(z.boolean()).parse(req.body);
    const m = await withSchema(base, t.schema_name, (tdb) => modules.setModules(tdb, b, null));
    await platform.platformAudit(base, req.central!.id, 'tenant.modules', t.id, b);
    res.json({ modules: m, labels: modules.MODULES });
  });
  c.get('/tenants/:id/users', central, async (req, res) => {
    const t = await getT(req);
    res.json(await withSchema(base, t.schema_name, (tdb) => users.listUsers(tdb)));
  });
  // Suporte: redefine a senha de um usuário do estabelecimento (ex.: administrador esqueceu).
  c.put('/tenants/:id/users/:userId/password', central, async (req, res) => {
    const t = await getT(req);
    const b = z.object({ password: z.string().min(8).max(200) }).parse(req.body);
    const userId = id.parse(req.params.userId);
    await withSchema(base, t.schema_name, async (tdb) => {
      const u = await tdb.one('SELECT id FROM users WHERE id = ?', [userId]);
      if (!u) throw new AppError(404, 'NOT_FOUND', 'Usuário não encontrado.');
      await tdb.run('UPDATE users SET password_hash = ?, active = 1, updated_at = ? WHERE id = ?', [hashSecret(b.password), new Date().toISOString(), userId]);
      await tdb.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    });
    await platform.platformAudit(base, req.central!.id, 'tenant.user_password', t.id, { userId });
    res.json({ ok: true });
  });
  app.use('/api/central', c);

  // ---------- Webhook do Stripe ----------
  app.post('/api/stripe/webhook', (req, res, next) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return next(new AppError(503, 'BILLING_OFF', 'Webhook não configurado.'));
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (!stripe.verifyWebhook(raw, req.get('Stripe-Signature'), secret)) return next(new AppError(400, 'BAD_SIGNATURE', 'Assinatura inválida.'));
    let ev: any;
    try { ev = JSON.parse(raw.toString('utf8')); } catch { return next(new AppError(400, 'INVALID_JSON', 'Dados inválidos.')); }
    stripe.handleEvent(base, sfetch, ev).then(() => res.json({ received: true }), next);
  });

  app.use('/api', r);
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Rota não encontrada.')));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    app.get('/conheca', (_req, res) => res.sendFile(join(opts.staticDir!, 'conheca', 'index.html')));
    app.get('*', async (_req, res) => res.sendFile(join(opts.staticDir!, 'index.html')));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: err.issues[0]?.message ?? 'Dados inválidos.', issues: err.issues } });
    }
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Dados inválidos.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Erro interno. Tente novamente.' } });
  });
  return app;
}
