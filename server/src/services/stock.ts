import { DB, now, audit, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getSetting } from './settings.js';
import { localDate, addDays } from '../tz.js';

export type MovementType = 'SALE' | 'SALE_CANCEL' | 'ENTRY' | 'ADJUST' | 'LOSS' | 'INVENTORY';

/** Única forma de alterar products.stock_milli: atualização atômica + movimentação rastreável. */
export async function moveStock(db: DB, m: {
  productId: number; type: MovementType; qtyMilli: number; userId: number;
  reason?: string | null; refType?: string; refId?: number; unitCostCents?: number | null;
}): Promise<number> {
  if (!Number.isInteger(m.qtyMilli) || m.qtyMilli === 0) throw badRequest('Quantidade de movimentação inválida.');
  const upd = await db.one<{ stock_milli: number }>('UPDATE products SET stock_milli = stock_milli + ? WHERE id = ? RETURNING stock_milli', [m.qtyMilli, m.productId]);
  if (!upd) throw notFound('Produto não encontrado.');
  const balance = upd.stock_milli;
  if (balance < 0 && m.type !== 'SALE' && m.type !== 'INVENTORY') throw badRequest('A movimentação deixaria o estoque negativo.');
  if (balance < 0 && m.type === 'SALE' && (await getSetting(db, 'allow_negative_stock')) !== 'true') {
    throw badRequest('Estoque insuficiente para concluir a venda.', 'INSUFFICIENT_STOCK');
  }
  const r = await db.one<{ id: number }>(
    `INSERT INTO stock_movements (product_id, type, qty_milli, balance_after_milli, unit_cost_cents, reason, ref_type, ref_id, user_id, at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [m.productId, m.type, m.qtyMilli, balance, m.unitCostCents ?? null, m.reason ?? null, m.refType ?? null, m.refId ?? null, m.userId, now()],
  );
  return r!.id;
}

export async function registerEntry(db: DB, input: { productId: number; qtyMilli: number; unitCostCents?: number | null; expiryDate?: string | null; reason?: string | null; updateCost?: boolean }, userId: number) {
  if (input.qtyMilli <= 0) throw badRequest('A quantidade de entrada deve ser positiva.');
  return tx(db, async (t) => {
    const mid = await moveStock(t, { productId: input.productId, type: 'ENTRY', qtyMilli: input.qtyMilli, userId, reason: input.reason ?? 'Entrada de mercadoria', unitCostCents: input.unitCostCents });
    if (input.expiryDate) {
      await t.run('INSERT INTO stock_lots (product_id, expiry_date, qty_milli, movement_id, created_at) VALUES (?,?,?,?,?)',
        [input.productId, input.expiryDate, input.qtyMilli, mid, now()]);
    }
    if (input.updateCost && input.unitCostCents != null) {
      const old = await t.one('SELECT cost_cents FROM products WHERE id = ?', [input.productId]);
      if (old.cost_cents !== input.unitCostCents) {
        await t.run('UPDATE products SET cost_cents = ?, updated_at = ? WHERE id = ?', [input.unitCostCents, now(), input.productId]);
        await t.run('INSERT INTO product_history (product_id, user_id, field, old_value, new_value, at) VALUES (?,?,?,?,?,?)',
          [input.productId, userId, 'cost_cents', String(old.cost_cents), String(input.unitCostCents), now()]);
      }
    }
    await audit(t, userId, 'stock.entry', 'product', input.productId, input);
    return mid;
  });
}

export async function registerAdjustment(db: DB, input: { productId: number; qtyMilli: number; type: 'ADJUST' | 'LOSS'; reason: string }, userId: number) {
  if (!input.reason?.trim()) throw badRequest('Informe o motivo do ajuste.');
  if (input.type === 'LOSS' && input.qtyMilli >= 0) throw badRequest('Perdas devem reduzir o estoque.');
  return tx(db, async (t) => {
    const id = await moveStock(t, { ...input, userId });
    await audit(t, userId, `stock.${input.type.toLowerCase()}`, 'product', input.productId, input);
    return id;
  });
}

export function lowStock(db: DB) {
  return db.all(
    `SELECT p.id, p.name, p.unit, p.stock_milli, p.min_stock_milli, c.name AS category
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 AND p.stock_milli <= p.min_stock_milli AND (p.min_stock_milli > 0 OR p.stock_milli < 0)
     ORDER BY (p.stock_milli - p.min_stock_milli), p.name`,
  );
}

/**
 * Lotes com validade próxima. Limitação documentada: não há controle de saída por lote (FIFO);
 * lotes são exibidos enquanto o produto tiver saldo e a validade estiver na janela de alerta.
 */
export async function expiringSoon(db: DB, days?: number) {
  const window = days ?? Number((await getSetting(db, 'expiry_alert_days')) || 15);
  const today = localDate(new Date());
  const rows = await db.all(
    `SELECT l.id, l.product_id, p.name, p.unit, l.expiry_date, l.qty_milli, p.stock_milli
     FROM stock_lots l JOIN products p ON p.id = l.product_id
     WHERE p.active = 1 AND p.stock_milli > 0 AND l.expiry_date <= ? AND l.expiry_date >= ?
     ORDER BY l.expiry_date`,
    [addDays(today, window), addDays(today, -30)],
  );
  return rows.map((r) => ({ ...r, expired: r.expiry_date < today }));
}

export function listMovements(db: DB, productId?: number, limit = 200) {
  return db.all(
    `SELECT m.*, p.name AS product_name, p.unit, u.name AS user_name FROM stock_movements m
     JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.user_id
     ${productId ? 'WHERE m.product_id = ?' : ''} ORDER BY m.id DESC LIMIT ?`,
    productId ? [productId, limit] : [limit],
  );
}
