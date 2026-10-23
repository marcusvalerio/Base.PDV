import { DB, now, audit, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getSetting } from './settings.js';
import { localDate, addDays } from '../tz.js';

export type MovementType = 'SALE' | 'SALE_CANCEL' | 'ENTRY' | 'ADJUST' | 'LOSS' | 'INVENTORY';

/** Única forma de alterar products.stock_milli: sempre gera uma movimentação rastreável. */
export function moveStock(db: DB, m: {
  productId: number; type: MovementType; qtyMilli: number; userId: number;
  reason?: string | null; refType?: string; refId?: number; unitCostCents?: number | null;
}): number {
  if (!Number.isInteger(m.qtyMilli) || m.qtyMilli === 0) throw badRequest('Quantidade de movimentação inválida.');
  const p = db.prepare('SELECT stock_milli FROM products WHERE id = ?').get(m.productId) as { stock_milli: number } | undefined;
  if (!p) throw notFound('Produto não encontrado.');
  const balance = p.stock_milli + m.qtyMilli;
  if (balance < 0 && m.type !== 'SALE' && m.type !== 'INVENTORY') {
    throw badRequest('A movimentação deixaria o estoque negativo.');
  }
  if (balance < 0 && m.type === 'SALE' && getSetting(db, 'allow_negative_stock') !== 'true') {
    throw badRequest('Estoque insuficiente para concluir a venda.', 'INSUFFICIENT_STOCK');
  }
  db.prepare('UPDATE products SET stock_milli = ? WHERE id = ?').run(balance, m.productId);
  const r = db.prepare(
    `INSERT INTO stock_movements (product_id, type, qty_milli, balance_after_milli, unit_cost_cents, reason, ref_type, ref_id, user_id, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(m.productId, m.type, m.qtyMilli, balance, m.unitCostCents ?? null, m.reason ?? null, m.refType ?? null, m.refId ?? null, m.userId, now());
  return Number(r.lastInsertRowid);
}

export function registerEntry(db: DB, input: { productId: number; qtyMilli: number; unitCostCents?: number | null; expiryDate?: string | null; reason?: string | null; updateCost?: boolean }, userId: number) {
  if (input.qtyMilli <= 0) throw badRequest('A quantidade de entrada deve ser positiva.');
  return tx(db, () => {
    const mid = moveStock(db, { productId: input.productId, type: 'ENTRY', qtyMilli: input.qtyMilli, userId, reason: input.reason ?? 'Entrada de mercadoria', unitCostCents: input.unitCostCents });
    if (input.expiryDate) {
      db.prepare('INSERT INTO stock_lots (product_id, expiry_date, qty_milli, movement_id, created_at) VALUES (?,?,?,?,?)')
        .run(input.productId, input.expiryDate, input.qtyMilli, mid, now());
    }
    if (input.updateCost && input.unitCostCents != null) {
      const old = db.prepare('SELECT cost_cents FROM products WHERE id = ?').get(input.productId) as any;
      if (old.cost_cents !== input.unitCostCents) {
        db.prepare('UPDATE products SET cost_cents = ?, updated_at = ? WHERE id = ?').run(input.unitCostCents, now(), input.productId);
        db.prepare('INSERT INTO product_history (product_id, user_id, field, old_value, new_value, at) VALUES (?,?,?,?,?,?)')
          .run(input.productId, userId, 'cost_cents', String(old.cost_cents), String(input.unitCostCents), now());
      }
    }
    audit(db, userId, 'stock.entry', 'product', input.productId, input);
    return mid;
  });
}

export function registerAdjustment(db: DB, input: { productId: number; qtyMilli: number; type: 'ADJUST' | 'LOSS'; reason: string }, userId: number) {
  if (!input.reason?.trim()) throw badRequest('Informe o motivo do ajuste.');
  if (input.type === 'LOSS' && input.qtyMilli >= 0) throw badRequest('Perdas devem reduzir o estoque.');
  return tx(db, () => {
    const id = moveStock(db, { ...input, userId });
    audit(db, userId, `stock.${input.type.toLowerCase()}`, 'product', input.productId, input);
    return id;
  });
}

/** Inventário físico: compara contado × registrado e gera movimentações para as divergências. */
export function applyInventory(db: DB, input: { note?: string; items: { productId: number; countedMilli: number }[] }, userId: number) {
  if (!input.items.length) throw badRequest('Informe ao menos um produto contado.');
  return tx(db, () => {
    const c = db.prepare('INSERT INTO inventory_counts (user_id, note, at) VALUES (?,?,?)').run(userId, input.note ?? null, now());
    const countId = Number(c.lastInsertRowid);
    const results = [];
    for (const it of input.items) {
      if (!Number.isInteger(it.countedMilli) || it.countedMilli < 0) throw badRequest('Quantidade contada inválida.');
      const p = db.prepare('SELECT stock_milli, name FROM products WHERE id = ?').get(it.productId) as any;
      if (!p) throw notFound('Produto não encontrado.');
      const diff = it.countedMilli - p.stock_milli;
      db.prepare('INSERT INTO inventory_count_items (count_id, product_id, system_milli, counted_milli, diff_milli) VALUES (?,?,?,?,?)')
        .run(countId, it.productId, p.stock_milli, it.countedMilli, diff);
      if (diff !== 0) moveStock(db, { productId: it.productId, type: 'INVENTORY', qtyMilli: diff, userId, reason: 'Inventário físico', refType: 'inventory', refId: countId });
      results.push({ productId: it.productId, name: p.name, systemMilli: p.stock_milli, countedMilli: it.countedMilli, diffMilli: diff });
    }
    audit(db, userId, 'stock.inventory', 'inventory', countId, { items: input.items.length });
    return { countId, results };
  });
}

export function lowStock(db: DB) {
  return db.prepare(
    `SELECT p.id, p.name, p.unit, p.stock_milli, p.min_stock_milli, c.name AS category
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 AND p.stock_milli <= p.min_stock_milli AND (p.min_stock_milli > 0 OR p.stock_milli < 0)
     ORDER BY (p.stock_milli - p.min_stock_milli), p.name`,
  ).all();
}

/**
 * Lotes com validade próxima. Limitação documentada: não há controle de saída por lote (FIFO);
 * lotes são exibidos enquanto o produto tiver saldo e a validade estiver na janela de alerta.
 */
export function expiringSoon(db: DB, days?: number) {
  const window = days ?? Number(getSetting(db, 'expiry_alert_days') || 15);
  const today = localDate(new Date());
  return db.prepare(
    `SELECT l.id, l.product_id, p.name, p.unit, l.expiry_date, l.qty_milli, p.stock_milli
     FROM stock_lots l JOIN products p ON p.id = l.product_id
     WHERE p.active = 1 AND p.stock_milli > 0 AND l.expiry_date <= ? AND l.expiry_date >= ?
     ORDER BY l.expiry_date`,
  ).all(addDays(today, window), addDays(today, -30)).map((r: any) => ({ ...r, expired: r.expiry_date < today }));
}

export function listMovements(db: DB, productId?: number, limit = 200) {
  return db.prepare(
    `SELECT m.*, p.name AS product_name, p.unit, u.name AS user_name FROM stock_movements m
     JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.user_id
     ${productId ? 'WHERE m.product_id = ?' : ''} ORDER BY m.id DESC LIMIT ?`,
  ).all(...(productId ? [productId, limit] : [limit]));
}
