import { DB, now, audit, tx, isUniqueViolation } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireOpenRegister } from './cash.js';
import { getPaymentMethod } from './sales.js';

export async function createCustomer(db: DB, input: { name: string; phone?: string | null; notes?: string | null }, userId: number) {
  if (!input.name?.trim()) throw badRequest('Informe o nome do cliente.');
  const r = await db.one<{ id: number }>('INSERT INTO customers (name, phone, notes, created_at) VALUES (?,?,?,?) RETURNING id',
    [input.name.trim(), input.phone?.trim() || null, input.notes?.trim() || null, now()]);
  await audit(db, userId, 'customer.create', 'customer', r!.id, { name: input.name });
  return r!.id;
}

export async function updateCustomer(db: DB, id: number, patch: { name?: string; phone?: string | null; notes?: string | null; active?: boolean }, userId: number) {
  const c = await db.one('SELECT * FROM customers WHERE id = ?', [id]);
  if (!c) throw notFound('Cliente não encontrado.');
  await db.run('UPDATE customers SET name=?, phone=?, notes=?, active=? WHERE id=?', [
    patch.name?.trim() || c.name, patch.phone === undefined ? c.phone : patch.phone, patch.notes === undefined ? c.notes : patch.notes,
    patch.active === undefined ? c.active : patch.active ? 1 : 0, id,
  ]);
  await audit(db, userId, 'customer.update', 'customer', id, patch);
}

export function listCustomers(db: DB, opts: { q?: string; includeInactive?: boolean } = {}) {
  const where = [];
  const args: any[] = [];
  if (!opts.includeInactive) where.push('c.active = 1');
  if (opts.q) { where.push('(c.name ILIKE ? OR c.phone ILIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  return db.all(
    `SELECT c.*, COALESCE((SELECT SUM(total_cents - paid_cents) FROM receivables r WHERE r.customer_id = c.id AND r.status = 'OPEN'),0)::bigint AS balance_cents
     FROM customers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.name`,
    args,
  );
}

export async function customerBalance(db: DB, id: number): Promise<number> {
  return (await db.one(`SELECT COALESCE(SUM(total_cents - paid_cents),0)::bigint AS b FROM receivables WHERE customer_id = ? AND status = 'OPEN'`, [id])).b;
}

export async function customerStatement(db: DB, id: number) {
  const c = await db.one('SELECT * FROM customers WHERE id = ?', [id]);
  if (!c) throw notFound('Cliente não encontrado.');
  const receivables = await db.all(
    `SELECT r.*, s.created_at AS sale_at FROM receivables r JOIN sales s ON s.id = r.sale_id WHERE r.customer_id = ? ORDER BY r.id DESC`, [id]);
  for (const r of receivables) {
    r.items = await db.all('SELECT product_name, unit, qty_milli, total_cents FROM sale_items WHERE sale_id = ?', [r.sale_id]);
  }
  const payments = await db.all(
    `SELECT rp.id, rp.amount_cents, rp.at, pm.name AS payment_method, u.name AS user_name FROM receivable_payments rp
     JOIN payment_methods pm ON pm.id = rp.payment_method_id JOIN users u ON u.id = rp.user_id WHERE rp.customer_id = ? ORDER BY rp.id DESC`, [id]);
  for (const p of payments) p.allocations = await db.all('SELECT receivable_id, amount_cents FROM receivable_allocations WHERE payment_id = ?', [p.id]);
  return { customer: c, balanceCents: await customerBalance(db, id), receivables, payments };
}

/**
 * Recebimento de fiado (total ou parcial). Abate as dívidas em aberto da mais antiga para a mais nova.
 * Idempotente pela chave; trava o cliente para não aceitar valor acima do saldo em pagamentos simultâneos.
 */
export async function receivePayment(db: DB, input: { idempotencyKey: string; customerId: number; amountCents: number; paymentMethodCode: string }, userId: number) {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) throw badRequest('Chave de operação ausente.');
  const replay = async () => {
    const prev = await db.one('SELECT id FROM receivable_payments WHERE idempotency_key = ?', [input.idempotencyKey]);
    return prev ? { paymentId: prev.id, balanceCents: await customerBalance(db, input.customerId), replayed: true } : null;
  };
  const prev = await replay();
  if (prev) return prev;
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('Valor inválido.');
  try {
    return await tx(db, async (t) => {
      if (!(await t.one('SELECT id FROM customers WHERE id = ? FOR UPDATE', [input.customerId]))) throw notFound('Cliente não encontrado.');
      const registerId = await requireOpenRegister(t, userId);
      const pm = await getPaymentMethod(t, input.paymentMethodCode);
      if (pm.kind === 'CREDIT') throw badRequest('Escolha como o cliente está pagando (dinheiro, Pix ou cartão).');
      const balance = await customerBalance(t, input.customerId);
      if (balance <= 0) throw conflict('Este cliente não tem saldo em aberto.');
      if (input.amountCents > balance) throw badRequest('O valor é maior que o saldo devedor do cliente.', 'AMOUNT_EXCEEDS_BALANCE');
      const r = await t.one<{ id: number }>(
        'INSERT INTO receivable_payments (idempotency_key, customer_id, register_id, payment_method_id, amount_cents, user_id, at) VALUES (?,?,?,?,?,?,?) RETURNING id',
        [input.idempotencyKey, input.customerId, registerId, pm.id, input.amountCents, userId, now()],
      );
      const paymentId = r!.id;
      let remaining = input.amountCents;
      for (const rec of await t.all(`SELECT * FROM receivables WHERE customer_id = ? AND status = 'OPEN' ORDER BY id`, [input.customerId])) {
        if (remaining <= 0) break;
        const pay = Math.min(rec.total_cents - rec.paid_cents, remaining);
        remaining -= pay;
        await t.run('INSERT INTO receivable_allocations (payment_id, receivable_id, amount_cents) VALUES (?,?,?)', [paymentId, rec.id, pay]);
        await t.run(`UPDATE receivables SET paid_cents = paid_cents + ?, status = CASE WHEN paid_cents + ? >= total_cents THEN 'PAID' ELSE 'OPEN' END WHERE id = ?`,
          [pay, pay, rec.id]);
      }
      await audit(t, userId, 'receivable.payment', 'customer', input.customerId, { amount: input.amountCents, method: pm.code });
      return { paymentId, balanceCents: await customerBalance(t, input.customerId), replayed: false };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'idempotency_key')) { const won = await replay(); if (won) return won; }
    throw e;
  }
}
