import { DB, now, audit, tx, isUniqueViolation } from '../db.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';
import { assertQty, lineTotal, surchargeUnits, Unit } from '../money.js';
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

/**
 * De qual produto sai o estoque de uma venda. Produtos com "baixa em outro produto" (ex.: copo de chopp)
 * descontam do produto de origem (ex.: barril), na proporção cadastrada; o custo vem da origem.
 */
export async function stockTarget(db: DB, productId: number, qtyMilli: number) {
  const p = await db.one('SELECT p.stock_source_id, p.stock_source_qty_milli, s.cost_cents AS source_cost FROM products p LEFT JOIN products s ON s.id = p.stock_source_id WHERE p.id = ?', [productId]);
  if (!p?.stock_source_id) return { productId, qtyMilli, unitCostCents: undefined as number | null | undefined };
  return {
    productId: p.stock_source_id as number,
    qtyMilli: Math.round((qtyMilli * p.stock_source_qty_milli) / 1000),
    unitCostCents: p.source_cost == null ? null : Math.round((p.source_cost * p.stock_source_qty_milli) / 1000),
  };
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

/**
 * Acréscimo por forma de pagamento, configurado pelo administrador:
 *  - Fiado: valor por unidade vendida.
 *  - Cartão de débito / crédito: valor por unidade ou percentual sobre o total. Sem valor configurado, sem acréscimo.
 */
export async function surchargeFor(db: DB, code: string, subtotalCents: number, units: number): Promise<number> {
  if (code === 'FIADO') return Number((await getSetting(db, 'fiado_surcharge_cents')) || 0) * units;
  const key = code === 'CARTAO_DEBITO' ? 'debit' : code === 'CARTAO_CREDITO' ? 'credit' : null;
  if (!key) return 0;
  const mode = await getSetting(db, `card_${key}_surcharge_mode` as any);
  const value = Number((await getSetting(db, `card_${key}_surcharge_value` as any)) || 0);
  if (value <= 0) return 0;
  return mode === 'UNIT' ? value * units : Math.round((subtotalCents * value) / 10000);
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
  let customerId: number | null = null;
  const units = input.lines.reduce((a, l) => a + surchargeUnits(l.unit, l.qtyMilli), 0);
  let surcharge = await surchargeFor(t, pm.code, subtotal, units);
  if (pm.kind === 'CREDIT') {
    if (!input.customerId) throw badRequest('Selecione o cliente para a venda a prazo.', 'CUSTOMER_REQUIRED');
    const c = await t.one('SELECT id, active FROM customers WHERE id = ?', [input.customerId]);
    if (!c || !c.active) throw badRequest('Cliente inválido ou inativo.');
    customerId = c.id;
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
    const st = await stockTarget(t, l.productId, l.qtyMilli);
    const cost = st.unitCostCents === undefined ? l.unitCostCents : st.unitCostCents;
    await t.run(
      `INSERT INTO sale_items (sale_id, product_id, product_name, category_id, unit, qty_milli, unit_price_cents, unit_cost_cents, total_cents, tab_person_id, stock_product_id, stock_qty_milli)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [saleId, l.productId, l.productName, l.categoryId, l.unit, l.qtyMilli, l.unitPriceCents, cost, l.totalCents, l.tabPersonId ?? null, st.productId, st.qtyMilli],
    );
    if (st.qtyMilli > 0) await moveStock(t, { productId: st.productId, type: 'SALE', qtyMilli: -st.qtyMilli, userId, refType: 'sale', refId: saleId });
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

export interface SalesFilter {
  registerId?: number; limit?: number; start?: string; end?: string; kind?: string; categoryId?: number;
  origin?: 'BALCAO' | 'MESA'; status?: 'COMPLETED' | 'CANCELLED'; userId?: number; customer?: string;
}

/** Vendas com filtros (período, forma, categoria, origem, situação, operador, cliente). Mais recentes primeiro. */
export function listSales(db: DB, f: SalesFilter) {
  const where: string[] = [];
  const args: any[] = [];
  if (f.registerId) { where.push('s.register_id = ?'); args.push(f.registerId); }
  if (f.start) { where.push('s.created_at >= ?'); args.push(f.start); }
  if (f.end) { where.push('s.created_at < ?'); args.push(f.end); }
  if (f.kind) { where.push('pm.kind = ?'); args.push(f.kind); }
  if (f.categoryId) { where.push('EXISTS (SELECT 1 FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = s.id AND p.category_id = ?)'); args.push(f.categoryId); }
  if (f.origin === 'BALCAO') where.push('s.tab_id IS NULL');
  if (f.origin === 'MESA') where.push('s.tab_id IS NOT NULL');
  if (f.status) { where.push('s.status = ?'); args.push(f.status); }
  if (f.userId) { where.push('s.user_id = ?'); args.push(f.userId); }
  if (f.customer) { where.push('c.name ILIKE ?'); args.push(`%${f.customer}%`); }
  args.push(f.limit ?? 100);
  return db.all(
    `SELECT s.id, s.created_at, s.status, s.total_cents, s.surcharge_cents, pm.name AS payment_method, pm.kind AS payment_kind, u.name AS user_name, c.name AS customer_name, t.label AS tab_label
     FROM sales s JOIN payment_methods pm ON pm.id = s.payment_method_id JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN tabs t ON t.id = s.tab_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
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
      const q = it.stock_qty_milli ?? it.qty_milli;
      if (q > 0) await moveStock(t, { productId: it.stock_product_id ?? it.product_id, type: 'SALE_CANCEL', qtyMilli: q, userId, refType: 'sale', refId: id, reason: 'Cancelamento de venda' });
    }
    await audit(t, userId, 'sale.cancel', 'sale', id, { reason, tabId: s.tab_id });
  });
  return getSale(db, id);
}
