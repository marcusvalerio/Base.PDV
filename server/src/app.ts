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
    const u = users.userFromToken(db, token);
    if (u) { req.user = u; req.token = token; }
    next();
  });

  const auth = (req: Request, _res: Response, next: NextFunction) => (req.user ? next() : next(unauthorized()));
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== 'ADMIN') {
      audit(db, req.user.id, 'auth.forbidden', null as any, null, { path: req.path, method: req.method });
      return next(forbidden());
    }
    next();
  };
  const uid = (req: Request) => req.user!.id;
  const isAdmin = (req: Request) => req.user?.role === 'ADMIN';
  const r = express.Router();

  // ---------- Autenticação ----------
  r.post('/auth/login', (req, res) => {
    const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw new AppError(429, 'TOO_MANY', 'Muitas tentativas. Aguarde alguns minutos.');
    const result = users.login(db, body.username, body.password);
    if (!result) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
      throw unauthorized('Usuário ou senha incorretos.');
    }
    attempts.delete(key);
    res.cookie(COOKIE, result.token, { httpOnly: true, sameSite: 'strict', secure: !!opts.cookieSecure, maxAge: 12 * 3600e3, path: '/' });
    res.json({ user: result.user });
  });
  r.post('/auth/logout', (req, res) => {
    if (req.token) users.logout(db, req.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  r.get('/auth/me', auth, (req, res) => res.json({ user: req.user }));

  // ---------- Dados básicos para o PDV ----------
  r.get('/bootstrap', auth, (_req, res) => {
    res.json({
      paymentMethods: db.prepare('SELECT code, name, kind FROM payment_methods WHERE active = 1 ORDER BY sort').all(),
      categories: db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all(),
      fiadoSurchargeCents: Number(settings.getSetting(db, 'fiado_surcharge_cents') || 0),
      cashCodeMode: settings.getSetting(db, 'cash_code_mode'),
    });
  });

  // ---------- Produtos e categorias ----------
  r.get('/products', auth, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined;
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
    const list = products.listProducts(db, { q, categoryId, includeInactive: isAdmin(req) && req.query.all === '1' });
    res.json(isAdmin(req) ? list : list.map(products.publicProduct));
  });
  r.post('/products', admin, (req, res) => res.status(201).json({ id: products.createProduct(db, productSchema.parse(req.body) as any, uid(req)) }));
  r.patch('/products/:id', admin, (req, res) => {
    products.updateProduct(db, id.parse(req.params.id), productSchema.omit({ initial_stock_milli: true }).partial().parse(req.body) as any, uid(req));
    res.json({ ok: true });
  });
  r.get('/products/:id/history', admin, (req, res) => res.json(products.productHistory(db, id.parse(req.params.id))));

  r.get('/categories', auth, (req, res) => res.json(db.prepare(`SELECT * FROM categories ${isAdmin(req) ? '' : 'WHERE active = 1'} ORDER BY name`).all()));
  r.post('/categories', admin, (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(b.name)) throw badRequest('Categoria já existe.');
    const x = db.prepare('INSERT INTO categories (name) VALUES (?)').run(b.name);
    audit(db, uid(req), 'category.create', 'category', x.lastInsertRowid, b);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/categories/:id', admin, (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() }).parse(req.body);
    const cid = id.parse(req.params.id);
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(cid) as any;
    if (!c) throw badRequest('Categoria não encontrada.');
    db.prepare('UPDATE categories SET name = ?, active = ? WHERE id = ?').run(b.name ?? c.name, b.active === undefined ? c.active : b.active ? 1 : 0, cid);
    audit(db, uid(req), 'category.update', 'category', cid, b);
    res.json({ ok: true });
  });

  // ---------- Vendas ----------
  r.post('/sales', auth, (req, res) => {
    const b = z.object({
      idempotencyKey: idemKey, paymentMethodCode: z.string().max(20), items: lines,
      customerId: id.nullish(), receivedCents: cents.nullish(),
    }).parse(req.body);
    const sale = sales.createSale(db, b, uid(req));
    res.status(sale.replayed ? 200 : 201).json(sale);
  });
  r.get('/sales', auth, (req, res) => {
    if (isAdmin(req)) {
      const registerId = req.query.registerId ? Number(req.query.registerId) : undefined;
      return res.json(sales.listSales(db, { registerId, limit: 200 }));
    }
    const reg = cash.currentRegister(db, uid(req));
    res.json(reg ? sales.listSales(db, { registerId: reg.id, limit: 50 }) : []);
  });
  r.get('/sales/:id', auth, (req, res) => {
    const s = sales.getSale(db, id.parse(req.params.id));
    if (!isAdmin(req) && cash.currentRegister(db, uid(req))?.id !== s.register_id) throw forbidden();
    if (!isAdmin(req)) s.items = s.items.map(({ unit_cost_cents, ...x }: any) => x);
    res.json(s);
  });
  r.post('/sales/:id/cancel', auth, (req, res) => {
    const b = z.object({ reason: z.string().trim().min(3).max(300), code: z.string().max(20) }).parse(req.body);
    const sid = id.parse(req.params.id);
    if (!isAdmin(req) && cash.currentRegister(db, uid(req))?.id !== sales.getSale(db, sid).register_id) throw forbidden('Você só pode cancelar vendas do seu caixa.');
    res.json(sales.cancelSale(db, sid, b.reason, b.code, uid(req)));
  });

  // ---------- Clientes e fiado ----------
  r.get('/customers', auth, (req, res) => res.json(customers.listCustomers(db, {
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined, includeInactive: isAdmin(req) && req.query.all === '1',
  })));
  r.post('/customers', auth, (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(30).nullish(), notes: z.string().max(300).nullish() }).parse(req.body);
    res.status(201).json({ id: customers.createCustomer(db, b, uid(req)) });
  });
  r.patch('/customers/:id', admin, (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(100).optional(), phone: z.string().trim().max(30).nullish(), notes: z.string().max(300).nullish(), active: z.boolean().optional() }).parse(req.body);
    customers.updateCustomer(db, id.parse(req.params.id), b, uid(req));
    res.json({ ok: true });
  });
  r.get('/customers/:id', auth, (req, res) => res.json(customers.customerStatement(db, id.parse(req.params.id))));
  r.post('/customers/:id/payments', auth, (req, res) => {
    const b = z.object({ idempotencyKey: idemKey, amountCents: cents.refine((v) => v > 0), paymentMethodCode: z.string().max(20) }).parse(req.body);
    res.json(customers.receivePayment(db, { ...b, customerId: id.parse(req.params.id) }, uid(req)));
  });

  // ---------- Caixa ----------
  r.get('/cash/current', auth, (req, res) => {
    const reg = cash.currentRegister(db, uid(req));
    res.json(reg ? { ...cash.registerSummary(db, reg.id), openedByName: reg.opened_by_name } : null);
  });
  r.post('/cash/open', auth, (req, res) => {
    const b = z.object({ code: z.string().max(20), openingFloatCents: cents }).parse(req.body);
    res.status(201).json({ id: cash.openRegister(db, b, uid(req)) });
  });
  r.post('/cash/movements', auth, (req, res) => {
    const b = z.object({ type: z.enum(['SUPRIMENTO', 'SANGRIA']), amountCents: cents, reason: z.string().max(200).optional() }).parse(req.body);
    res.status(201).json({ id: cash.addCashMovement(db, b, uid(req)) });
  });
  r.get('/cash/:id/summary', auth, (req, res) => {
    const rid = id.parse(req.params.id);
    if (!isAdmin(req) && cash.currentRegister(db, uid(req))?.id !== rid) throw forbidden();
    res.json(cash.registerSummary(db, rid));
  });
  r.post('/cash/:id/close', auth, (req, res) => {
    const b = z.object({ code: z.string().max(20), countedCashCents: cents }).parse(req.body);
    res.json(cash.closeRegister(db, { ...b, registerId: id.parse(req.params.id) }, uid(req)));
  });
  r.get('/cash/active', admin, (_req, res) => res.json(cash.openRegisters(db)));
  r.get('/cash', admin, (_req, res) => res.json(cash.listRegisters(db)));
  r.get('/cash/:id/closing', admin, (req, res) => {
    const reg = db.prepare('SELECT summary_json FROM cash_registers WHERE id = ?').get(id.parse(req.params.id)) as any;
    res.json(reg?.summary_json ? JSON.parse(reg.summary_json) : cash.registerSummary(db, id.parse(req.params.id)));
  });

  // ---------- Mesas e comandas ----------
  r.get('/tabs', auth, (_req, res) => res.json(tabs.listOpenTabs(db)));
  r.post('/tabs', auth, (req, res) => {
    const b = z.object({ label: z.string().trim().min(1).max(40), people: z.array(z.string().trim().max(60)).max(30).default([]) }).parse(req.body);
    const tid = tabs.openTab(db, b.label, b.people, uid(req));
    res.status(201).json(tabs.getTab(db, tid));
  });
  r.get('/tabs/:id', auth, (req, res) => res.json(tabs.getTab(db, id.parse(req.params.id))));
  r.post('/tabs/:id/people', auth, (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const tid = id.parse(req.params.id);
    tabs.addPerson(db, tid, b.name, uid(req));
    res.status(201).json(tabs.getTab(db, tid));
  });
  r.post('/tabs/:id/items', auth, (req, res) => {
    const b = z.object({ personId: id, items: lines }).parse(req.body);
    res.json(tabs.addTabItems(db, id.parse(req.params.id), b.personId, b.items, uid(req)));
  });
  r.post('/tabs/:id/items/:itemId/void', auth, (req, res) => {
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    res.json(tabs.voidTabItem(db, id.parse(req.params.id), id.parse(req.params.itemId), b.reason, uid(req)));
  });
  r.post('/tabs/:id/close', auth, (req, res) => {
    const b = z.object({ idempotencyKey: idemKey, personId: id.nullable(), paymentMethodCode: z.string().max(20), customerId: id.nullish(), receivedCents: cents.nullish() }).parse(req.body);
    res.json(tabs.closeTabBill(db, id.parse(req.params.id), b, uid(req)));
  });
  r.post('/tabs/:id/finish', auth, (req, res) => res.json(tabs.finishTab(db, id.parse(req.params.id), uid(req))));

  // ---------- Estoque (administração) ----------
  r.post('/stock/entries', admin, (req, res) => {
    const b = z.object({ productId: id, qtyMilli: qty, unitCostCents: cents.nullish(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), reason: z.string().max(200).nullish(), updateCost: z.boolean().optional() }).parse(req.body);
    res.status(201).json({ id: stock.registerEntry(db, b, uid(req)) });
  });
  r.post('/stock/adjustments', admin, (req, res) => {
    const b = z.object({ productId: id, qtyMilli: z.number().int().refine((v) => v !== 0), type: z.enum(['ADJUST', 'LOSS']), reason: z.string().trim().min(3).max(200) }).parse(req.body);
    res.status(201).json({ id: stock.registerAdjustment(db, b, uid(req)) });
  });
  r.post('/stock/inventory', admin, (req, res) => {
    const b = z.object({ note: z.string().max(200).optional(), items: z.array(z.object({ productId: id, countedMilli: z.number().int().min(0) })).min(1).max(2000) }).parse(req.body);
    res.status(201).json(stock.applyInventory(db, b, uid(req)));
  });
  r.get('/stock/movements', admin, (req, res) => res.json(stock.listMovements(db, req.query.productId ? Number(req.query.productId) : undefined)));
  r.get('/stock/alerts', admin, (_req, res) => res.json({ lowStock: stock.lowStock(db), expiring: stock.expiringSoon(db) }));
  r.get('/stock/inventories', admin, (_req, res) => res.json(db.prepare(
    `SELECT ic.id, ic.at, ic.note, u.name AS user_name, COUNT(i.product_id) AS items, SUM(CASE WHEN i.diff_milli != 0 THEN 1 ELSE 0 END) AS divergences
     FROM inventory_counts ic JOIN users u ON u.id = ic.user_id LEFT JOIN inventory_count_items i ON i.count_id = ic.id GROUP BY ic.id ORDER BY ic.id DESC LIMIT 50`,
  ).all()));

  // ---------- Indicadores ----------
  const analysisQuery = z.object({
    preset: z.enum(['today', '7d', '15d', '30d', 'month', 'custom']).default('7d'),
    from: z.string().optional(), to: z.string().optional(), categoryId: id.optional(), productId: id.optional(),
  });
  r.get('/dashboard', admin, (_req, res) => res.json(analytics.dashboard(db)));
  r.get('/analytics', admin, (req, res) => res.json(analytics.analysis(db, analysisQuery.parse(req.query) as any)));
  r.get('/restock', admin, (req, res) => {
    const q = z.object({ windowDays: z.coerce.number().int().optional(), categoryId: id.optional() }).parse(req.query);
    res.json(analytics.restockSuggestions(db, q));
  });

  // ---------- Usuários e configurações ----------
  const roleSchema = z.enum(['ADMIN', 'OPERADOR']);
  r.get('/users', admin, (_req, res) => res.json(users.listUsers(db)));
  r.post('/users', admin, (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/), password: z.string().min(8).max(200), role: roleSchema }).parse(req.body);
    res.status(201).json({ id: users.createUser(db, b, uid(req)) });
  });
  r.patch('/users/:id', admin, (req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), role: roleSchema.optional(), active: z.boolean().optional(), password: z.string().min(8).max(200).optional() }).parse(req.body);
    users.updateUser(db, id.parse(req.params.id), b, uid(req));
    res.json({ ok: true });
  });
  r.put('/users/:id/cash-code', admin, (req, res) => {
    const b = z.object({ code: z.string().nullable() }).parse(req.body);
    users.setUserCashCode(db, id.parse(req.params.id), b.code, uid(req));
    res.json({ ok: true });
  });
  r.get('/settings', admin, (_req, res) => res.json(settings.publicSettings(db)));
  r.put('/settings', admin, (req, res) => {
    const optDays = z.union([z.literal(''), z.coerce.number().int().min(0).max(365).transform(String)]);
    const b = z.object({
      fiado_surcharge_cents: z.coerce.number().int().min(0).max(100000).transform(String).optional(),
      cash_code_mode: z.enum(['SHARED', 'INDIVIDUAL']).optional(),
      expiry_alert_days: z.coerce.number().int().min(1).max(365).transform(String).optional(),
      restock_lead_time_days: optDays.optional(),
      restock_safety_days: optDays.optional(),
      allow_negative_stock: z.enum(['true', 'false']).optional(),
    }).parse(req.body);
    for (const [k, v] of Object.entries(b)) if (v !== undefined) settings.setSetting(db, k, String(v), uid(req));
    res.json(settings.publicSettings(db));
  });
  r.put('/settings/cash-code', admin, (req, res) => {
    const b = z.object({ code: z.string().regex(/^\d{4,8}$/, 'O código deve ter de 4 a 8 dígitos.') }).parse(req.body);
    settings.setSetting(db, 'shared_cash_code_hash', hashSecret(b.code), uid(req));
    res.json({ ok: true });
  });
  r.put('/settings/cancel-code', admin, (req, res) => {
    const b = z.object({ code: z.string().regex(/^\d{4,8}$/, 'O código deve ter de 4 a 8 dígitos.') }).parse(req.body);
    settings.setSetting(db, 'cancel_code_hash', hashSecret(b.code), uid(req));
    res.json({ ok: true });
  });
  r.get('/audit', admin, (_req, res) => res.json(db.prepare(
    'SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300',
  ).all()));

  app.use('/api', r);
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Rota não encontrada.')));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(join(opts.staticDir!, 'index.html')));
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
