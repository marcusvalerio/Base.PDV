import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { assertQty, lineTotal, Unit } from '../money.js';
import { moveStock } from './stock.js';
import { requireOpenRegister } from './cash.js';
import { getSetting } from './settings.js';
import { verifySecret } from '../security.js';
import { forbidden } from '../errors.js';

export interface SaleLineInput { productId: number; qtyMilli: number }
export interface CreateSaleInput {
  idempotencyKey: string;
  paymentMethodCode: string;
  items: SaleLineInput[];
  customerId?: number | null;
  receivedCents?: number | null;
}
interface PreparedLine {
  productId: number; productName: string; categoryId: number; unit: Unit; qtyMilli: number;
  unitPriceCents: number; unitCostCents: number | null; totalCents: number; tabPersonId?: number | null; tabItemId?: number;
}

export function getPaymentMethod(db: DB, code: string) {
  const pm = db.prepare('SELECT * FROM payment_methods WHERE code = ? AND active = 1').get(code) as any;
  if (!pm) throw badRequest('Forma de pagamento inválida.');
  return pm as { id: number; code: string; name: string; kind: 'CASH' | 'PIX' | 'CARD' | 'CREDIT' };
}

/** Monta as linhas a partir do cadastro atual (preço definido no servidor, nunca pelo navegador). */
export function prepareLines(db: DB, items: SaleLineInput[]): PreparedLine[] {
  if (!items?.length) throw badRequest('Adicione ao menos um produto.');
  return items.map((it) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.productId) as any;
    if (!p) throw notFound('Produto não encontrado.');
    if (!p.active) throw badRequest(`O produto "${p.name}" está inativo e não pode ser vendido.`, 'PRODUCT_INACTIVE');
    try { assertQty(p.unit, it.qtyMilli); } catch (e: any) { throw badRequest(`${p.name}: ${e.message}`); }
    return {
      productId: p.id, productName: p.name, categoryId: p.category_id, unit: p.unit, qtyMilli: it.qtyMilli,
      unitPriceCents: p.price_cents, unitCostCents: p.cost_cents, totalCents: lineTotal(p.price_cents, it.qtyMilli),
    };
  });
}

function findByKey(db: DB, key: string) {
  return db.prepare('SELECT id FROM sales WHERE idempotency_key = ?').get(key) as { id: number } | undefined;
}

/**
 * Registra uma venda de forma atômica: venda, itens, baixa de estoque e (se fiado) o lançamento na conta do cliente.
 * Idempotente pela idempotencyKey: reenvios devolvem a venda já registrada sem duplicar nada.
 */
export function persistSale(db: DB, input: Omit<CreateSaleInput, 'items'> & { lines: PreparedLine[]; tabId?: number | null }, userId: number) {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) throw badRequest('Chave de operação ausente.');
  const existing = findByKey(db, input.idempotencyKey);
  if (existing) return { ...getSale(db, existing.id), replayed: true };
  return tx(db, () => {
    const again = findByKey(db, input.idempotencyKey);
    if (again) return { ...getSale(db, again.id), replayed: true };
    const registerId = requireOpenRegister(db, userId);
    const pm = getPaymentMethod(db, input.paymentMethodCode);
    const subtotal = input.lines.reduce((a, l) => a + l.totalCents, 0);
    let surcharge = 0;
    let customerId: number | null = null;
    if (pm.kind === 'CREDIT') {
      if (!input.customerId) throw badRequest('Selecione o cliente para a venda a prazo.', 'CUSTOMER_REQUIRED');
      const c = db.prepare('SELECT id, active FROM customers WHERE id = ?').get(input.customerId) as any;
      if (!c || !c.active) throw badRequest('Cliente inválido ou inativo.');
      customerId = c.id;
      surcharge = Number(getSetting(db, 'fiado_surcharge_cents') || 0);
    }
    const total = subtotal + surcharge;
    let received: number | null = null;
    let change: number | null = null;
    if (pm.kind === 'CASH') {
      received = input.receivedCents ?? total;
      if (!Number.isInteger(received) || received < total) throw badRequest('O valor recebido é menor que o total.', 'INSUFFICIENT_CASH');
      change = received - total;
    }
    const t = now();
    const r = db.prepare(
      `INSERT INTO sales (idempotency_key, register_id, user_id, payment_method_id, customer_id, tab_id, status, subtotal_cents, surcharge_cents, total_cents, received_cents, change_cents, created_at)
       VALUES (?,?,?,?,?,?,'COMPLETED',?,?,?,?,?,?)`,
    ).run(input.idempotencyKey, registerId, userId, pm.id, customerId, input.tabId ?? null, subtotal, surcharge, total, received, change, t);
    const saleId = Number(r.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, category_id, unit, qty_milli, unit_price_cents, unit_cost_cents, total_cents, tab_person_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const l of input.lines) {
      ins.run(saleId, l.productId, l.productName, l.categoryId, l.unit, l.qtyMilli, l.unitPriceCents, l.unitCostCents, l.totalCents, l.tabPersonId ?? null);
      moveStock(db, { productId: l.productId, type: 'SALE', qtyMilli: -l.qtyMilli, userId, refType: 'sale', refId: saleId });
    }
    if (customerId) {
      db.prepare(
        `INSERT INTO receivables (customer_id, sale_id, original_cents, surcharge_cents, total_cents, paid_cents, status, created_at)
         VALUES (?,?,?,?,?,0,'OPEN',?)`,
      ).run(customerId, saleId, subtotal, surcharge, total, t);
    }
    audit(db, userId, 'sale.create', 'sale', saleId, { total, method: pm.code });
    return { ...getSale(db, saleId), replayed: false };
  });
}

export function createSale(db: DB, input: CreateSaleInput, userId: number) {
  const existing = input.idempotencyKey ? findByKey(db, input.idempotencyKey) : undefined;
  if (existing) return { ...getSale(db, existing.id), replayed: true };
  return persistSale(db, { ...input, lines: prepareLines(db, input.items) }, userId);
}

export function getSale(db: DB, id: number) {
  const s = db.prepare(
    `SELECT s.*, pm.name AS payment_method, pm.code AS payment_code, u.name AS user_name, c.name AS customer_name
     FROM sales s JOIN payment_methods pm ON pm.id = s.payment_method_id JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
  ).get(id) as any;
  if (!s) throw notFound('Venda não encontrada.');
  s.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
  return s;
}

export function listSales(db: DB, opts: { registerId?: number; from?: string; to?: string; limit?: number }) {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.registerId) { where.push('s.register_id = ?'); args.push(opts.registerId); }
  if (opts.from) { where.push('s.created_at >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('s.created_at < ?'); args.push(opts.to); }
  args.push(opts.limit ?? 100);
  return db.prepare(
    `SELECT s.id, s.created_at, s.status, s.total_cents, s.surcharge_cents, pm.name AS payment_method, u.name AS user_name, c.name AS customer_name, t.label AS tab_label
     FROM sales s JOIN payment_methods pm ON pm.id = s.payment_method_id JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN tabs t ON t.id = s.tab_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ?`,
  ).all(...args);
}

/** Valida o código único de cancelamento definido pelo administrador. */
export function verifyCancelCode(db: DB, userId: number, code: string) {
  const hash = getSetting(db, 'cancel_code_hash');
  if (!hash) throw forbidden('O código de cancelamento ainda não foi configurado pelo administrador.');
  if (!verifySecret(String(code ?? ''), hash)) {
    audit(db, userId, 'sale.cancel_code_invalid', 'sale', null);
    throw forbidden('Código de cancelamento incorreto.');
  }
}

/**
 * Cancelamento autorizado pelo código de cancelamento: a venda fica preservada como CANCELLED,
 * o estoque volta, o fiado é cancelado (se ainda sem pagamentos) e, se a venda veio de uma mesa,
 * os itens voltam a ficar pendentes na mesa (reabrindo-a se necessário) para serem cobrados corretamente.
 */
export function cancelSale(db: DB, id: number, reason: string, code: string, userId: number) {
  if (!reason?.trim()) throw badRequest('Informe o motivo do cancelamento.');
  verifyCancelCode(db, userId, code);
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as any;
    if (!s) throw notFound('Venda não encontrada.');
    if (s.status === 'CANCELLED') throw conflict('Esta venda já foi cancelada.');
    const reg = db.prepare('SELECT status FROM cash_registers WHERE id = ?').get(s.register_id) as any;
    if (reg.status !== 'OPEN') throw conflict('A venda pertence a um caixa já fechado. Fale com o administrador.');
    const rec = db.prepare('SELECT * FROM receivables WHERE sale_id = ?').get(id) as any;
    if (rec && rec.paid_cents > 0) throw conflict('Esta venda a prazo já tem pagamentos registrados.');
    if (rec) db.prepare("UPDATE receivables SET status = 'CANCELLED' WHERE id = ?").run(rec.id);
    if (s.tab_id) {
      const tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(s.tab_id) as any;
      if (tab.status !== 'OPEN') {
        if (db.prepare("SELECT 1 FROM tabs WHERE label = ? AND status = 'OPEN'").get(tab.label)) {
          throw conflict(`Já existe outra "${tab.label}" aberta. Feche-a antes de cancelar esta venda.`);
        }
        db.prepare("UPDATE tabs SET status = 'OPEN', closed_at = NULL WHERE id = ?").run(tab.id);
      }
      db.prepare("UPDATE tab_items SET status = 'PENDING', sale_id = NULL WHERE sale_id = ? AND status = 'PAID'").run(id);
    }
    db.prepare("UPDATE sales SET status='CANCELLED', cancelled_at=?, cancelled_by=?, cancel_reason=? WHERE id=?").run(now(), userId, reason.trim(), id);
    for (const it of db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id) as any[]) {
      moveStock(db, { productId: it.product_id, type: 'SALE_CANCEL', qtyMilli: it.qty_milli, userId, refType: 'sale', refId: id, reason: 'Cancelamento de venda' });
    }
    audit(db, userId, 'sale.cancel', 'sale', id, { reason, tabId: s.tab_id });
    return getSale(db, id);
  });
}
