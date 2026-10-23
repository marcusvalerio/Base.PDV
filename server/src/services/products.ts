import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { Unit } from '../money.js';
import { moveStock } from './stock.js';

export interface ProductInput {
  name: string; internal_code?: string | null; barcode?: string | null; category_id: number; unit: Unit;
  price_cents: number; cost_cents?: number | null; min_stock_milli?: number; track_expiry?: boolean; active?: boolean;
  initial_stock_milli?: number;
}

const TRACKED = ['name', 'internal_code', 'barcode', 'category_id', 'unit', 'price_cents', 'cost_cents', 'min_stock_milli', 'track_expiry', 'active'] as const;

function checkUnique(db: DB, field: 'internal_code' | 'barcode', value: string | null | undefined, exceptId?: number) {
  if (!value) return;
  const r = db.prepare(`SELECT id FROM products WHERE ${field} = ? AND id != ?`).get(value, exceptId ?? -1);
  if (r) throw conflict(field === 'barcode' ? 'Código de barras já cadastrado.' : 'Código interno já cadastrado.');
}

export function createProduct(db: DB, input: ProductInput, userId: number) {
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(input.category_id)) throw badRequest('Categoria inválida.');
  checkUnique(db, 'internal_code', input.internal_code);
  checkUnique(db, 'barcode', input.barcode);
  return tx(db, () => {
    const t = now();
    const r = db.prepare(
      `INSERT INTO products (name, internal_code, barcode, category_id, unit, price_cents, cost_cents, min_stock_milli, track_expiry, active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(input.name.trim(), input.internal_code || null, input.barcode || null, input.category_id, input.unit, input.price_cents,
      input.cost_cents ?? null, input.min_stock_milli ?? 0, input.track_expiry ? 1 : 0, input.active === false ? 0 : 1, t, t);
    const id = Number(r.lastInsertRowid);
    if (input.initial_stock_milli && input.initial_stock_milli > 0) {
      moveStock(db, { productId: id, type: 'ENTRY', qtyMilli: input.initial_stock_milli, userId, reason: 'Estoque inicial', unitCostCents: input.cost_cents });
    }
    audit(db, userId, 'product.create', 'product', id, { name: input.name });
    return id;
  });
}

export function updateProduct(db: DB, id: number, patch: Partial<ProductInput>, userId: number) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
  if (!cur) throw notFound('Produto não encontrado.');
  if (patch.category_id !== undefined && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(patch.category_id)) throw badRequest('Categoria inválida.');
  if (patch.internal_code !== undefined) checkUnique(db, 'internal_code', patch.internal_code, id);
  if (patch.barcode !== undefined) checkUnique(db, 'barcode', patch.barcode, id);
  if (patch.unit && patch.unit !== cur.unit) {
    const used = db.prepare('SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1').get(id);
    if (used) throw badRequest('Não é possível mudar a unidade de um produto com movimentações. Cadastre um novo produto.');
  }
  return tx(db, () => {
    const next: any = { ...cur };
    for (const f of TRACKED) {
      if ((patch as any)[f] === undefined) continue;
      let v = (patch as any)[f];
      if (f === 'track_expiry' || f === 'active') v = v ? 1 : 0;
      if ((f === 'internal_code' || f === 'barcode') && !v) v = null;
      if (f === 'name') v = String(v).trim();
      if (v !== cur[f]) {
        db.prepare('INSERT INTO product_history (product_id, user_id, field, old_value, new_value, at) VALUES (?,?,?,?,?,?)')
          .run(id, userId, f, cur[f] == null ? null : String(cur[f]), v == null ? null : String(v), now());
        next[f] = v;
      }
    }
    db.prepare(
      `UPDATE products SET name=?, internal_code=?, barcode=?, category_id=?, unit=?, price_cents=?, cost_cents=?, min_stock_milli=?, track_expiry=?, active=?, updated_at=? WHERE id=?`,
    ).run(next.name, next.internal_code, next.barcode, next.category_id, next.unit, next.price_cents, next.cost_cents, next.min_stock_milli, next.track_expiry, next.active, now(), id);
    audit(db, userId, 'product.update', 'product', id, patch);
  });
}

export function listProducts(db: DB, opts: { q?: string; includeInactive?: boolean; categoryId?: number } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (!opts.includeInactive) where.push('p.active = 1');
  if (opts.categoryId) { where.push('p.category_id = ?'); args.push(opts.categoryId); }
  if (opts.q) {
    where.push('(p.name LIKE ? OR p.internal_code = ? OR p.barcode = ?)');
    args.push(`%${opts.q}%`, opts.q, opts.q);
  }
  return db.prepare(
    `SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name`,
  ).all(...args);
}

export function productHistory(db: DB, id: number) {
  return db.prepare(
    `SELECT h.*, u.name AS user_name FROM product_history h LEFT JOIN users u ON u.id = h.user_id WHERE product_id = ? ORDER BY h.id DESC`,
  ).all(id);
}

/** Campos visíveis ao operador (sem custo). */
export function publicProduct(p: any) {
  const { cost_cents, ...rest } = p;
  return rest;
}
