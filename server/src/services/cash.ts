import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { verifySecret } from '../security.js';
import { getSetting } from './settings.js';

/**
 * Verifica o código de caixa no servidor. Modo definido em settings.cash_code_mode:
 *  SHARED: código único da loja; INDIVIDUAL: código do próprio usuário.
 */
export function verifyCashCode(db: DB, userId: number, code: string) {
  const mode = getSetting(db, 'cash_code_mode');
  let hash: string | null;
  if (mode === 'INDIVIDUAL') {
    hash = (db.prepare('SELECT cash_code_hash FROM users WHERE id = ?').get(userId) as any)?.cash_code_hash ?? null;
    if (!hash) throw forbidden('Seu usuário ainda não tem código de caixa. Peça ao administrador.');
  } else {
    hash = getSetting(db, 'shared_cash_code_hash') || null;
    if (!hash) throw forbidden('O código de caixa ainda não foi configurado pelo administrador.');
  }
  if (!verifySecret(String(code ?? ''), hash)) {
    audit(db, userId, 'cash.code_invalid', 'cash_register', null);
    throw forbidden('Código de caixa incorreto.');
  }
}

export function currentRegister(db: DB) {
  return db.prepare(
    `SELECT r.*, u.name AS opened_by_name FROM cash_registers r JOIN users u ON u.id = r.opened_by WHERE r.status = 'OPEN'`,
  ).get() as any | undefined;
}

export function requireOpenRegister(db: DB): number {
  const r = currentRegister(db);
  if (!r) throw conflict('O caixa está fechado. Abra o caixa para registrar operações.', 'REGISTER_CLOSED');
  return r.id;
}

export function openRegister(db: DB, input: { code: string; openingFloatCents: number }, userId: number) {
  verifyCashCode(db, userId, input.code);
  if (!Number.isInteger(input.openingFloatCents) || input.openingFloatCents < 0) throw badRequest('Valor inicial inválido.');
  return tx(db, () => {
    if (currentRegister(db)) throw conflict('Já existe um caixa aberto.');
    const r = db.prepare('INSERT INTO cash_registers (status, opened_by, opened_at, opening_float_cents) VALUES (?,?,?,?)')
      .run('OPEN', userId, now(), input.openingFloatCents);
    audit(db, userId, 'cash.open', 'cash_register', r.lastInsertRowid, { openingFloatCents: input.openingFloatCents });
    return Number(r.lastInsertRowid);
  });
}

export function addCashMovement(db: DB, input: { type: 'SUPRIMENTO' | 'SANGRIA'; amountCents: number; reason?: string }, userId: number) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('Valor inválido.');
  return tx(db, () => {
    const regId = requireOpenRegister(db);
    if (input.type === 'SANGRIA') {
      const s = registerSummary(db, regId);
      if (input.amountCents > s.expectedCashCents) throw badRequest('A retirada é maior que o dinheiro esperado no caixa.');
    }
    const r = db.prepare('INSERT INTO cash_movements (register_id, type, amount_cents, reason, user_id, at) VALUES (?,?,?,?,?,?)')
      .run(regId, input.type, input.amountCents, input.reason ?? null, userId, now());
    audit(db, userId, `cash.${input.type.toLowerCase()}`, 'cash_register', regId, input);
    return Number(r.lastInsertRowid);
  });
}

/**
 * Resumo do caixa. Separa faturamento (vendas) de entradas efetivas de dinheiro:
 *  - vendas a prazo entram no faturamento, mas não no dinheiro esperado;
 *  - recebimentos de fiado entram no dinheiro (se em espécie), mas não no faturamento.
 */
export function registerSummary(db: DB, registerId: number) {
  const reg = db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(registerId) as any;
  if (!reg) throw notFound('Caixa não encontrado.');
  const salesBy = db.prepare(
    `SELECT pm.code, pm.name, pm.kind, COUNT(s.id) AS count, COALESCE(SUM(s.total_cents),0) AS total_cents
     FROM payment_methods pm LEFT JOIN sales s ON s.payment_method_id = pm.id AND s.register_id = ? AND s.status = 'COMPLETED'
     GROUP BY pm.id ORDER BY pm.sort`,
  ).all(registerId) as any[];
  const receiptsBy = db.prepare(
    `SELECT pm.code, pm.name, pm.kind, COUNT(rp.id) AS count, COALESCE(SUM(rp.amount_cents),0) AS total_cents
     FROM payment_methods pm LEFT JOIN receivable_payments rp ON rp.payment_method_id = pm.id AND rp.register_id = ?
     WHERE pm.kind != 'CREDIT' GROUP BY pm.id ORDER BY pm.sort`,
  ).all(registerId) as any[];
  const mov = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='SUPRIMENTO' THEN amount_cents END),0) AS sup,
            COALESCE(SUM(CASE WHEN type='SANGRIA' THEN amount_cents END),0) AS san
     FROM cash_movements WHERE register_id = ?`,
  ).get(registerId) as any;
  const cancelled = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS t FROM sales WHERE register_id = ? AND status = 'CANCELLED'`).get(registerId) as any;
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
    salesTotalCents: salesBy.reduce((a, r) => a + r.total_cents, 0),
    salesCount: salesBy.reduce((a, r) => a + r.count, 0),
    receiptsByMethod: receiptsBy,
    receiptsTotalCents: receiptsBy.reduce((a, r) => a + r.total_cents, 0),
    suprimentosCents: mov.sup as number,
    sangriasCents: mov.san as number,
    cancelledCount: cancelled.n as number,
    cancelledTotalCents: cancelled.t as number,
    expectedCashCents: expected,
    countedCashCents: reg.counted_cash_cents as number | null,
    differenceCents: reg.counted_cash_cents == null ? null : reg.counted_cash_cents - expected,
  };
}

export function closeRegister(db: DB, input: { code: string; countedCashCents: number; registerId: number }, userId: number) {
  verifyCashCode(db, userId, input.code);
  if (!Number.isInteger(input.countedCashCents) || input.countedCashCents < 0) throw badRequest('Valor contado inválido.');
  return tx(db, () => {
    const reg = db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(input.registerId) as any;
    if (!reg) throw notFound('Caixa não encontrado.');
    if (reg.status !== 'OPEN') throw conflict('Este caixa já foi fechado.', 'ALREADY_CLOSED');
    const s = registerSummary(db, reg.id);
    const t = now();
    const summary = { ...s, status: 'CLOSED', closedAt: t, countedCashCents: input.countedCashCents, differenceCents: input.countedCashCents - s.expectedCashCents };
    const r = db.prepare(
      `UPDATE cash_registers SET status='CLOSED', closed_by=?, closed_at=?, expected_cash_cents=?, counted_cash_cents=?, summary_json=? WHERE id=? AND status='OPEN'`,
    ).run(userId, t, s.expectedCashCents, input.countedCashCents, JSON.stringify(summary), reg.id);
    if (r.changes !== 1) throw conflict('Este caixa já foi fechado.', 'ALREADY_CLOSED');
    audit(db, userId, 'cash.close', 'cash_register', reg.id, { expected: s.expectedCashCents, counted: input.countedCashCents });
    return summary;
  });
}

export function listRegisters(db: DB, limit = 60) {
  return db.prepare(
    `SELECT r.id, r.status, r.opened_at, r.closed_at, r.opening_float_cents, r.expected_cash_cents, r.counted_cash_cents,
            uo.name AS opened_by_name, uc.name AS closed_by_name
     FROM cash_registers r JOIN users uo ON uo.id = r.opened_by LEFT JOIN users uc ON uc.id = r.closed_by
     ORDER BY r.id DESC LIMIT ?`,
  ).all(limit);
}
