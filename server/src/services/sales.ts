import { DB, now, audit, tx, isUniqueViolation } from '../db.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';
import { assertQty, lineTotal, Unit } from '../money.js';
import { moveStock } from './stock.js';
import { requireOpenRegister } from './cash.js';
import { getSetting } from './settings.js';
import { verifySecret } from '../security.js';

export interface SaleLineInput { productId: number; qtyMilli: number }
export interface CreateSaleInput {
  idempotencyKey: string;
  paymentMethodCode: string;
  items: SaleLineInput[];
  customerId?: number | null;
  receivedCents?: number | null;
}
export interface PreparedLine {
  productId: number; productName: string; categoryId: number; unit: Unit; qtyMilli: number;
  unitPriceCents: number; unitCostCents: number | null; totalCents: number; tabPersonId?: number | null;
}

export async function getPaymentMethod(db: DB, code: string) {
  const pm = await db.one('SELECT * FROM payment_methods WHERE code = ? AND active = 1', [code]);
  if (!pm) throw badRequest('Forma de pagamento inválida.');
  return pm as { id: number; code: string; name: string; kind: 'CASH' | 'PIX' | 'CARD' | 'CREDIT' };
}

/** Monta as linhas a partir do cadastro atual (preço definido no servidor, nunca pelo navegador). */
export async function prepareLines(db: DB, items: SaleLineInput[]): Promise<PreparedLine[]> {
  if (!items?.length) throw badRequest('Adicione ao menos um produto.');
  const out: PreparedLine[] = [];
  for (const it of items) {
    const p = await db.one('SELECT * FROM products WHERE id = ?', [it.productId]);
    if (!p) throw notFound('Produto não encontrado.');
    if (!p.active) throw badRequest(`O produto "${p.name}" está inativo e não pode ser vendido.`, 'PRODUCT_INACTIVE');
    try { assertQty(p.unit, it.qtyMilli); } catch (e: any) { throw badRequest(`${p.name}: ${e.message}`); }
    out.push({
      productId: p.id, productName: p.name, categoryId: p.category_id, unit: p.unit, qtyMilli: it.qtyMilli,
      unitPriceCents: p.price_cents, unitCostCents: p.cost_cents, totalCents: lineTotal(p.price_cents, it.qtyMilli),
    });
  }
  return out;
}

async function findByKey(db: DB, key: string) {
  return db.one<{ id: number }>('SELECT id FROM sales WHERE idempotency_key = ?', [key]);
}

/**
 * Registra uma venda de forma atômica: venda, itens, baixa de estoque e (se fiado) o lançamento na conta do cliente.
 * Deve rodar dentro de uma transação. Idempotente pela chave (restrição UNIQUE no banco).
 */
export async function persistSaleTx(t: DB, input: Omit<CreateSaleInput, 'items'> & { lines: PreparedLine[]; tabId?: number | null }, userId: number) {
  const registerId = await requireOpenRegister(t, userId);
  const pm = await getPaymentMethod(t, input.paymentMethodCode);
  const subtotal = input.lines.reduce((a, l) => a + l.totalCents, 0);
  let surcharge = 0;
  let customerId: number | null = null;
  if (pm.kind === 'CREDIT') {
    if (!input.customerId) throw badRequest('Selecione o cliente para a venda a prazo.', 'CUSTOMER_REQUIRED');
    const c = await t.one('SELECT id, active FROM customers WHERE id = ?', [input.customerId]);
    if (!c || !c.active) throw badRequest('Cliente inválido ou inativo.');
    customerId = c.id;
    surcharge = Number((await getSetting(t, 'fiado_surcharge_cents')) || 0);
  }
  const total = subtotal + surcharge;
  let received: number | null = null;
  let change: number | null = null;
  if (pm.kind === 'CASH') {
    received = input.receivedCents ?? total;
    if (!Number.isInteger(received) || received < total) throw badRequest('O valor recebido é menor que o total.', 'INSUFFICIENT_CASH');
    change = received - total;
  }
  const ts = now();
  const r = await t.one<{ id: number }>(
    `INSERT INTO sales (idempotency_key, register_id, user_id, payment_method_id, customer_id, tab_id, status, subtotal_cents, surcharge_cents, total_cents, received_cents, change_cents, created_at)
     VALUES (?,?,?,?,?,?,'COMPLETED',?,?,?,?,?,?) RETURNING id`,
    [input.idempotencyKey, registerId, userId, pm.id, customerId, input.tabId ?? null, subtotal, surcharge, total, received, change, ts],
  );
  const saleId = r!.id;
  for (const l of input.lines) {
    await t.run(
      `INSERT INTO sale_items (sale_id, product_id, product_name, category_id, unit, qty_milli, unit_price_cents, unit_cost_cents, total_cents, tab_person_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [saleId, l.productId, l.productName, l.categoryId, l.unit, l.qtyMilli, l.unitPriceCents, l.unitCostCents, l.totalCents, l.tabPersonId ?? null],
    );
    await moveStock(t, { productId: l.productId, type: 'SALE', qtyMilli: -l.qtyMilli, userId, refType: 'sale', refId: saleId });
  }
  if (customerId) {
    await t.run(
      `INSERT INTO receivables (customer_id, sale_id, original_cents, surcharge_cents, total_cents, paid_cents, status, created_at)
       VALUES (?,?,?,?,?,0,'OPEN',?)`,
      [customerId, saleId, subtotal, surcharge, total, ts],
    );
  }
  await audit(t, userId, 'sale.create', 'sale', saleId, { total, method: pm.code });
  return saleId;
}

/** Executa fn em transação; se outra requisição com a mesma chave venceu a corrida, devolve a venda dela. */
export async function idempotentSale<T>(db: DB, key: string, fn: () => Promise<T>, replay: (saleId: number) => Promise<T>): Promise<T> {
  if (!key || key.length < 8) throw badRequest('Chave de operação ausente.');
  const existing = await findByKey(db, key);
  if (existing) return replay(existing.id);
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e, 'idempotency_key')) {
      const won = await findByKey(db, key);
      if (won) return replay(won.id);
    }
    throw e;
  }
}

export async function createSale(db: DB, input: CreateSaleInput, userId: number) {
  return idempotentSale(db, input.idempotencyKey,
    async () => {
      const lines = await prepareLines(db, input.items);
      const id = await tx(db, (t) => persistSaleTx(t, { ...input, lines }, userId));
      return { ...(await getSale(db, id)), replayed: false };
    },
    async (id) => ({ ...(await getSale(db, id)), replayed: true }));
}

export async function getSale(db: DB, id: number) {
  const s = await db.one(
    `SELECT s.*, pm.name AS payment_method, pm.code AS payment_code, u.name AS user_name, c.name AS customer_name
     FROM sales s JOIN payment_methods pm ON pm.id = s.payment_method_id JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
    [id],
  );
  if (!s) throw notFound('Venda não encontrada.');
  s.items = await db.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', [id]);
  return s;
}

export function listSales(db: DB, opts: { registerId?: number; limit?: number }) {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.registerId) { where.push('s.register_id = ?'); args.push(opts.registerId); }
  args.push(opts.limit ?? 100);
  return db.all(
    `SELECT s.id, s.created_at, s.status, s.total_cents, s.surcharge_cents, pm.name AS payment_method, u.name AS user_name, c.name AS customer_name, t.label AS tab_label
     FROM sales s JOIN payment_methods pm ON pm.id = s.payment_method_id JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN tabs t ON t.id = s.tab_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ?`,
    args,
  );
}

/** Valida o código único de cancelamento definido pelo administrador. */
export async function verifyCancelCode(db: DB, userId: number, code: string) {
  const hash = await getSetting(db, 'cancel_code_hash');
  if (!hash) throw forbidden('O código de cancelamento ainda não foi configurado pelo administrador.');
  if (!verifySecret(String(code ?? ''), hash)) {
    await audit(db, userId, 'sale.cancel_code_invalid', 'sale', null);
    throw forbidden('Código de cancelamento incorreto.');
  }
}

/**
 * Cancelamento autorizado pelo código de cancelamento: a venda fica preservada como CANCELLED,
 * o estoque volta, o fiado é cancelado (se ainda sem pagamentos) e, se a venda veio de uma mesa,
 * os itens voltam a ficar pendentes na mesa (reabrindo-a se necessário) para serem cobrados corretamente.
 */
export async function cancelSale(db: DB, id: number, reason: string, code: string, userId: number) {
  if (!reason?.trim()) throw badRequest('Informe o motivo do cancelamento.');
  await verifyCancelCode(db, userId, code);
  await tx(db, async (t) => {
    const s = await t.one('SELECT * FROM sales WHERE id = ? FOR UPDATE', [id]);
    if (!s) throw notFound('Venda não encontrada.');
    if (s.status === 'CANCELLED') throw conflict('Esta venda já foi cancelada.');
    const reg = await t.one('SELECT status FROM cash_registers WHERE id = ?', [s.register_id]);
    if (reg.status !== 'OPEN') throw conflict('A venda pertence a um caixa já fechado. Fale com o administrador.');
    const rec = await t.one('SELECT * FROM receivables WHERE sale_id = ? FOR UPDATE', [id]);
    if (rec && rec.paid_cents > 0) throw conflict('Esta venda a prazo já tem pagamentos registrados.');
    if (rec) await t.run("UPDATE receivables SET status = 'CANCELLED' WHERE id = ?", [rec.id]);
    if (s.tab_id) {
      const tab = await t.one('SELECT * FROM tabs WHERE id = ? FOR UPDATE', [s.tab_id]);
      if (tab.status !== 'OPEN') {
        if (await t.one("SELECT 1 FROM tabs WHERE label = ? AND status = 'OPEN'", [tab.label])) {
          throw conflict(`Já existe outra "${tab.label}" aberta. Feche-a antes de cancelar esta venda.`);
        }
        await t.run("UPDATE tabs SET status = 'OPEN', closed_at = NULL WHERE id = ?", [tab.id]);
      }
      await t.run("UPDATE tab_items SET status = 'PENDING', sale_id = NULL WHERE sale_id = ? AND status = 'PAID'", [id]);
    }
    await t.run("UPDATE sales SET status='CANCELLED', cancelled_at=?, cancelled_by=?, cancel_reason=? WHERE id=?", [now(), userId, reason.trim(), id]);
    for (const it of await t.all('SELECT * FROM sale_items WHERE sale_id = ?', [id])) {
      await moveStock(t, { productId: it.product_id, type: 'SALE_CANCEL', qtyMilli: it.qty_milli, userId, refType: 'sale', refId: id, reason: 'Cancelamento de venda' });
    }
    await audit(t, userId, 'sale.cancel', 'sale', id, { reason, tabId: s.tab_id });
  });
  return getSale(db, id);
}
