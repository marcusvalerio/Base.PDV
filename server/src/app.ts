import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB, audit } from './db.js';
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
import { hashSecret } from './security.js';
import * as modules from './services/modules.js';
import * as inventory from './services/inventory.js';

declare global {
  namespace Express { interface Request { user?: users.SessionUser; token?: string } }
}

export const COOKIE = 'pdv_session';

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
});

/** Limite simples de tentativas de login por IP+usuário (memória do processo). */
const attempts = new Map<string, { n: number; until: number }>();

export function createApp(db: DB, opts: { cookieSecure?: boolean; staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Proteção CSRF: toda requisição que altera dados precisa do cabeçalho customizado (navegadores não o enviam em formulários de outros sites).
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'pdv') return next(forbidden('Requisição inválida.'));
    next();
  });

  app.use('/api', (req, _res, next) => {
    const token = req.cookies?.[COOKIE];
    users.userFromToken(db, token).then((u) => { if (u) { req.user = u; req.token = token; } next(); }, next);
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
  const sup = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.superAdmin) return next(forbidden('Somente o super administrador pode fazer isso.'));
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

  // ---------- Autenticação ----------
  r.post('/auth/login', async (req, res) => {
    const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw new AppError(429, 'TOO_MANY', 'Muitas tentativas. Aguarde alguns minutos.');
    const result = await users.login(db, body.username, body.password);
    if (!result) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
      throw unauthorized('Usuário ou senha incorretos.');
    }
    attempts.delete(key);
    res.cookie(COOKIE, result.token, { httpOnly: true, sameSite: 'strict', secure: !!opts.cookieSecure, maxAge: 12 * 3600e3, path: '/' });
    res.json({ user: result.user });
  });
  r.post('/auth/logout', async (req, res) => {
    if (req.token) await users.logout(db, req.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  r.get('/auth/me', auth, async (req, res) => res.json({ user: req.user }));

  // ---------- Dados básicos para o PDV ----------
  r.get('/bootstrap', auth, async (_req, res) => {
    const mods = await modules.getModules(db);
    res.json({
      modules: mods,
      paymentMethods: (await db.all('SELECT code, name, kind FROM payment_methods WHERE active = 1 ORDER BY sort')).filter((m) => m.kind !== 'CREDIT' || mods.fiado),
      categories: await db.all('SELECT * FROM categories WHERE active = 1 ORDER BY name'),
      fiadoSurchargeCents: Number(await settings.getSetting(db, 'fiado_surcharge_cents') || 0),
      cashCodeMode: await settings.getSetting(db, 'cash_code_mode'),
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
    }).parse(req.body);
    if ((await sales.getPaymentMethod(db, b.paymentMethodCode)).kind === 'CREDIT') await modules.requireModule(db, 'fiado');
    const sale = await sales.createSale(db, b, uid(req));
    res.status(sale.replayed ? 200 : 201).json(sale);
  });
  r.get('/sales', auth, async (req, res) => {
    if (isAdmin(req)) {
      const registerId = req.query.registerId ? Number(req.query.registerId) : undefined;
      return res.json(await sales.listSales(db, { registerId, limit: 200 }));
    }
    const reg = await cash.currentRegister(db, uid(req));
    res.json(reg ? await sales.listSales(db, { registerId: reg.id, limit: 50 }) : []);
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
  r.get('/cash', admin, async (_req, res) => res.json(await cash.listRegisters(db)));
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
  r.get('/stock/movements', admin, async (req, res) => res.json(await stock.listMovements(db, req.query.productId ? Number(req.query.productId) : undefined)));
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
    const b = z.object({ name: z.string().trim().min(2).max(80), username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/), password: z.string().min(8).max(200), role: roleSchema, superAdmin: z.boolean().optional() }).parse(req.body);
    res.status(201).json({ id: await users.createUser(db, b, uid(req)) });
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
      fiado_surcharge_cents: z.coerce.number().int().min(0).max(100000).transform(String).optional(),
      cash_code_mode: z.enum(['SHARED', 'INDIVIDUAL']).optional(),
      expiry_alert_days: z.coerce.number().int().min(1).max(365).transform(String).optional(),
      restock_lead_time_days: optDays.optional(),
      restock_safety_days: optDays.optional(),
      allow_negative_stock: z.enum(['true', 'false']).optional(),
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

  // ---------- Super administrador: liberação de módulos ----------
  r.get('/modules', admin, async (_req, res) => res.json({ modules: await modules.getModules(db), labels: modules.MODULES }));
  r.put('/modules', sup, async (req, res) => {
    const b = z.record(z.boolean()).parse(req.body);
    res.json({ modules: await modules.setModules(db, b, uid(req)), labels: modules.MODULES });
  });

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

  app.use('/api', r);
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Rota não encontrada.')));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
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
