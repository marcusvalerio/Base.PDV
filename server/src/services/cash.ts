import { DB, now, audit, tx, isUniqueViolation } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { verifySecret } from '../security.js';
import { getSetting } from './settings.js';

/**
 * Verifica o código de caixa no servidor. Modo definido em settings.cash_code_mode:
 *  SHARED: código único da loja; INDIVIDUAL: código do próprio usuário.
 */
export async function verifyCashCode(db: DB, userId: number, code: string) {
  const mode = await getSetting(db, 'cash_code_mode');
  let hash: string | null;
  if (mode === 'INDIVIDUAL') {
    hash = (await db.one('SELECT cash_code_hash FROM users WHERE id = ?', [userId]))?.cash_code_hash ?? null;
    if (!hash) throw forbidden('Seu usuário ainda não tem código de caixa. Peça ao administrador.');
  } else {
    hash = (await getSetting(db, 'shared_cash_code_hash')) || null;
    if (!hash) throw forbidden('O código de caixa ainda não foi configurado pelo administrador.');
  }
  if (!verifySecret(String(code ?? ''), hash)) {
    await audit(db, userId, 'cash.code_invalid', 'cash_register', null);
    throw forbidden('Código de caixa incorreto.');
  }
}

/** Caixa aberto do usuário (cada pessoa opera o seu próprio caixa). */
export function currentRegister(db: DB, userId: number) {
  return db.one(
    `SELECT r.*, u.name AS opened_by_name FROM cash_registers r JOIN users u ON u.id = r.opened_by WHERE r.status = 'OPEN' AND r.opened_by = ?`,
    [userId],
  );
}

/** Todos os caixas abertos agora, para acompanhamento do administrador. */
export async function openRegisters(db: DB) {
  const rows = await db.all(
    `SELECT r.id, r.opened_at, u.name AS opened_by_name FROM cash_registers r JOIN users u ON u.id = r.opened_by WHERE r.status = 'OPEN' ORDER BY r.opened_at`,
  );
  const out = [];
  for (const r of rows) {
    const s = await registerSummary(db, r.id);
    out.push({ id: r.id, openedAt: r.opened_at, openedByName: r.opened_by_name, salesCount: s.salesCount, salesTotalCents: s.salesTotalCents, receiptsTotalCents: s.receiptsTotalCents, expectedCashCents: s.expectedCashCents });
  }
  return out;
}

/** Caixa aberto do usuário, travado (FOR UPDATE) para a transação corrente. */
export async function requireOpenRegister(db: DB, userId: number): Promise<number> {
  const r = await db.one(`SELECT id FROM cash_registers WHERE status = 'OPEN' AND opened_by = ? FOR UPDATE`, [userId]);
  if (!r) throw conflict('O caixa está fechado. Abra o caixa para registrar operações.', 'REGISTER_CLOSED');
  return r.id;
}

export async function openRegister(db: DB, input: { code: string; openingFloatCents: number }, userId: number) {
  await verifyCashCode(db, userId, input.code);
  if (!Number.isInteger(input.openingFloatCents) || input.openingFloatCents < 0) throw badRequest('Valor inicial inválido.');
  try {
    return await tx(db, async (t) => {
      const r = await t.one<{ id: number }>('INSERT INTO cash_registers (status, opened_by, opened_at, opening_float_cents) VALUES (?,?,?,?) RETURNING id',
        ['OPEN', userId, now(), input.openingFloatCents]);
      await audit(t, userId, 'cash.open', 'cash_register', r!.id, { openingFloatCents: input.openingFloatCents });
      return r!.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Você já tem um caixa aberto.');
    throw e;
  }
}

export async function addCashMovement(db: DB, input: { type: 'SUPRIMENTO' | 'SANGRIA'; amountCents: number; reason?: string }, userId: number) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('Valor inválido.');
  return tx(db, async (t) => {
    const regId = await requireOpenRegister(t, userId);
    if (input.type === 'SANGRIA') {
      const s = await registerSummary(t, regId);
      if (input.amountCents > s.expectedCashCents) throw badRequest('A retirada é maior que o dinheiro esperado no caixa.');
    }
    const r = await t.one<{ id: number }>('INSERT INTO cash_movements (register_id, type, amount_cents, reason, user_id, at) VALUES (?,?,?,?,?,?) RETURNING id',
      [regId, input.type, input.amountCents, input.reason ?? null, userId, now()]);
    await audit(t, userId, `cash.${input.type.toLowerCase()}`, 'cash_register', regId, input);
    return r!.id;
  });
}

/**
 * Resumo do caixa. Separa faturamento (vendas) de entradas efetivas de dinheiro:
 *  - vendas a prazo entram no faturamento, mas não no dinheiro esperado;
 *  - recebimentos de fiado entram no dinheiro (se em espécie), mas não no faturamento.
 */
export async function registerSummary(db: DB, registerId: number) {
  const reg = await db.one('SELECT * FROM cash_registers WHERE id = ?', [registerId]);
  if (!reg) throw notFound('Caixa não encontrado.');
  const salesBy = await db.all(
    `SELECT pm.code, pm.name, pm.kind, COUNT(s.id)::int AS count, COALESCE(SUM(s.total_cents),0)::bigint AS total_cents
     FROM payment_methods pm LEFT JOIN sales s ON s.payment_method_id = pm.id AND s.register_id = ? AND s.status = 'COMPLETED'
     GROUP BY pm.id ORDER BY pm.sort`,
    [registerId],
  );
  const receiptsBy = await db.all(
    `SELECT pm.code, pm.name, pm.kind, COUNT(rp.id)::int AS count, COALESCE(SUM(rp.amount_cents),0)::bigint AS total_cents
     FROM payment_methods pm LEFT JOIN receivable_payments rp ON rp.payment_method_id = pm.id AND rp.register_id = ?
     WHERE pm.kind != 'CREDIT' GROUP BY pm.id ORDER BY pm.sort`,
    [registerId],
  );
  const mov = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN type='SUPRIMENTO' THEN amount_cents END),0)::bigint AS sup,
            COALESCE(SUM(CASE WHEN type='SANGRIA' THEN amount_cents END),0)::bigint AS san
     FROM cash_movements WHERE register_id = ?`,
    [registerId],
  );
  const cancelled = await db.one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_cents),0)::bigint AS t FROM sales WHERE register_id = ? AND status = 'CANCELLED'`, [registerId]);
  const cashSales = salesBy.filter((r) => r.kind === 'CASH').reduce((a, r) => a + r.total_cents, 0);
  const cashReceipts = receiptsBy.filter((r) => r.kind === 'CASH').reduce((a, r) => a + r.total_cents, 0);
  const expected = reg.opening_float_cents + cashSales + cashReceipts + mov.sup - mov.san;
  return {
    registerId,
    status: reg.status as string,
    openedAt: reg.opened_at as string,
    closedAt: reg.closed_at as string | null,
    openingFloatCents: reg.opening_float_cents as number,
    salesByMethod: salesBy,
    salesTotalCents: salesBy.reduce((a, r) => a + r.total_cents, 0) as number,
    salesCount: salesBy.reduce((a, r) => a + r.count, 0) as number,
    receiptsByMethod: receiptsBy,
    receiptsTotalCents: receiptsBy.reduce((a, r) => a + r.total_cents, 0) as number,
    suprimentosCents: mov.sup as number,
    sangriasCents: mov.san as number,
    cancelledCount: cancelled.n as number,
    cancelledTotalCents: cancelled.t as number,
    expectedCashCents: expected as number,
    countedCashCents: reg.counted_cash_cents as number | null,
    differenceCents: reg.counted_cash_cents == null ? null : reg.counted_cash_cents - expected,
  };
}

export async function closeRegister(db: DB, input: { code: string; countedCashCents: number; registerId: number }, userId: number) {
  await verifyCashCode(db, userId, input.code);
  if (!Number.isInteger(input.countedCashCents) || input.countedCashCents < 0) throw badRequest('Valor contado inválido.');
  return tx(db, async (t) => {
    const reg = await t.one('SELECT * FROM cash_registers WHERE id = ? FOR UPDATE', [input.registerId]);
    if (!reg) throw notFound('Caixa não encontrado.');
    if (reg.status !== 'OPEN') throw conflict('Este caixa já foi fechado.', 'ALREADY_CLOSED');
    const role = (await t.one('SELECT role FROM users WHERE id = ?', [userId]))?.role;
    if (reg.opened_by !== userId && role !== 'ADMIN') throw forbidden('Só quem abriu o caixa (ou um administrador) pode fechá-lo.');
    const s = await registerSummary(t, reg.id);
    const ts = now();
    const summary = { ...s, status: 'CLOSED', closedAt: ts, countedCashCents: input.countedCashCents, differenceCents: input.countedCashCents - s.expectedCashCents };
    const r = await t.run(
      `UPDATE cash_registers SET status='CLOSED', closed_by=?, closed_at=?, expected_cash_cents=?, counted_cash_cents=?, summary_json=? WHERE id=? AND status='OPEN'`,
      [userId, ts, s.expectedCashCents, input.countedCashCents, JSON.stringify(summary), reg.id],
    );
    if (r.rowCount !== 1) throw conflict('Este caixa já foi fechado.', 'ALREADY_CLOSED');
    await audit(t, userId, 'cash.close', 'cash_register', reg.id, { expected: s.expectedCashCents, counted: input.countedCashCents });
    return summary;
  });
}

export function listRegisters(db: DB, limit = 60) {
  return db.all(
    `SELECT r.id, r.status, r.opened_at, r.closed_at, r.opening_float_cents, r.expected_cash_cents, r.counted_cash_cents,
            uo.name AS opened_by_name, uc.name AS closed_by_name
     FROM cash_registers r JOIN users uo ON uo.id = r.opened_by LEFT JOIN users uc ON uc.id = r.closed_by
     ORDER BY r.id DESC LIMIT ?`,
    [limit],
  );
}
