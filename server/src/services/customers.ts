import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireOpenRegister } from './cash.js';
import { getPaymentMethod } from './sales.js';

export function createCustomer(db: DB, input: { name: string; phone?: string | null; notes?: string | null }, userId: number) {
  if (!input.name?.trim()) throw badRequest('Informe o nome do cliente.');
  const r = db.prepare('INSERT INTO customers (name, phone, notes, created_at) VALUES (?,?,?,?)')
    .run(input.name.trim(), input.phone?.trim() || null, input.notes?.trim() || null, now());
  audit(db, userId, 'customer.create', 'customer', r.lastInsertRowid, { name: input.name });
  return Number(r.lastInsertRowid);
}

export function updateCustomer(db: DB, id: number, patch: { name?: string; phone?: string | null; notes?: string | null; active?: boolean }, userId: number) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!c) throw notFound('Cliente não encontrado.');
  db.prepare('UPDATE customers SET name=?, phone=?, notes=?, active=? WHERE id=?').run(
    patch.name?.trim() || c.name, patch.phone === undefined ? c.phone : patch.phone, patch.notes === undefined ? c.notes : patch.notes,
    patch.active === undefined ? c.active : patch.active ? 1 : 0, id,
  );
  audit(db, userId, 'customer.update', 'customer', id, patch);
}

export function listCustomers(db: DB, opts: { q?: string; includeInactive?: boolean } = {}) {
  const where = [];
  const args: any[] = [];
  if (!opts.includeInactive) where.push('c.active = 1');
  if (opts.q) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  return db.prepare(
    `SELECT c.*, COALESCE((SELECT SUM(total_cents - paid_cents) FROM receivables r WHERE r.customer_id = c.id AND r.status = 'OPEN'),0) AS balance_cents
     FROM customers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.name`,
  ).all(...args);
}

export function customerBalance(db: DB, id: number): number {
  return (db.prepare(`SELECT COALESCE(SUM(total_cents - paid_cents),0) AS b FROM receivables WHERE customer_id = ? AND status = 'OPEN'`).get(id) as any).b;
}

export function customerStatement(db: DB, id: number) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!c) throw notFound('Cliente não encontrado.');
  const receivables = db.prepare(
    `SELECT r.*, s.created_at AS sale_at FROM receivables r JOIN sales s ON s.id = r.sale_id WHERE r.customer_id = ? ORDER BY r.id DESC`,
  ).all(id) as any[];
  for (const r of receivables) {
    r.items = db.prepare('SELECT product_name, unit, qty_milli, total_cents FROM sale_items WHERE sale_id = ?').all(r.sale_id);
  }
  const payments = db.prepare(
    `SELECT rp.id, rp.amount_cents, rp.at, pm.name AS payment_method, u.name AS user_name FROM receivable_payments rp
     JOIN payment_methods pm ON pm.id = rp.payment_method_id JOIN users u ON u.id = rp.user_id WHERE rp.customer_id = ? ORDER BY rp.id DESC`,
  ).all(id) as any[];
  for (const p of payments) p.allocations = db.prepare('SELECT receivable_id, amount_cents FROM receivable_allocations WHERE payment_id = ?').all(p.id);
  return { customer: c, balanceCents: customerBalance(db, id), receivables, payments };
}

/**
 * Recebimento de fiado (total ou parcial). Abate as dívidas em aberto da mais antiga para a mais nova.
 * Idempotente pela chave; não aceita valor acima do saldo devedor.
 */
export function receivePayment(db: DB, input: { idempotencyKey: string; customerId: number; amountCents: number; paymentMethodCode: string }, userId: number) {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) throw badRequest('Chave de operação ausente.');
  const prev = db.prepare('SELECT id FROM receivable_payments WHERE idempotency_key = ?').get(input.idempotencyKey) as any;
  if (prev) return { paymentId: prev.id, balanceCents: customerBalance(db, input.customerId), replayed: true };
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('Valor inválido.');
  return tx(db, () => {
    const registerId = requireOpenRegister(db);
    const pm = getPaymentMethod(db, input.paymentMethodCode);
    if (pm.kind === 'CREDIT') throw badRequest('Escolha como o cliente está pagando (dinheiro, Pix ou cartão).');
    const balance = customerBalance(db, input.customerId);
    if (balance <= 0) throw conflict('Este cliente não tem saldo em aberto.');
    if (input.amountCents > balance) throw badRequest('O valor é maior que o saldo devedor do cliente.', 'AMOUNT_EXCEEDS_BALANCE');
    const r = db.prepare(
      'INSERT INTO receivable_payments (idempotency_key, customer_id, register_id, payment_method_id, amount_cents, user_id, at) VALUES (?,?,?,?,?,?,?)',
    ).run(input.idempotencyKey, input.customerId, registerId, pm.id, input.amountCents, userId, now());
    const paymentId = Number(r.lastInsertRowid);
    let remaining = input.amountCents;
    const open = db.prepare(`SELECT * FROM receivables WHERE customer_id = ? AND status = 'OPEN' ORDER BY id`).all(input.customerId) as any[];
    for (const rec of open) {
      if (remaining <= 0) break;
      const due = rec.total_cents - rec.paid_cents;
      const pay = Math.min(due, remaining);
      remaining -= pay;
      db.prepare('INSERT INTO receivable_allocations (payment_id, receivable_id, amount_cents) VALUES (?,?,?)').run(paymentId, rec.id, pay);
      db.prepare(`UPDATE receivables SET paid_cents = paid_cents + ?, status = CASE WHEN paid_cents + ? >= total_cents THEN 'PAID' ELSE 'OPEN' END WHERE id = ?`)
        .run(pay, pay, rec.id);
    }
    audit(db, userId, 'receivable.payment', 'customer', input.customerId, { amount: input.amountCents, method: pm.code });
    return { paymentId, balanceCents: customerBalance(db, input.customerId), replayed: false };
  });
}
