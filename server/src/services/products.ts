import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { Unit } from '../money.js';
import { moveStock } from './stock.js';

export interface ProductInput {
  name: string; internal_code?: string | null; barcode?: string | null; category_id: number; unit: Unit;
  price_cents: number; cost_cents?: number | null; min_stock_milli?: number; track_expiry?: boolean; active?: boolean; image_url?: string | null;
  pack_label?: string | null; pack_size_milli?: number | null; stock_source_id?: number | null; stock_source_qty_milli?: number | null;
  initial_stock_milli?: number;
}

const TRACKED = ['name', 'internal_code', 'barcode', 'category_id', 'unit', 'price_cents', 'cost_cents', 'min_stock_milli', 'track_expiry', 'active', 'image_url', 'pack_label', 'pack_size_milli', 'stock_source_id', 'stock_source_qty_milli'] as const;

async function checkUnique(db: DB, field: 'internal_code' | 'barcode', value: string | null | undefined, exceptId?: number) {
  if (!value) return;
  const r = await db.one(`SELECT id FROM products WHERE ${field} = ? AND id != ?`, [value, exceptId ?? -1]);
  if (r) throw conflict(field === 'barcode' ? 'Código de barras já cadastrado.' : 'Código interno já cadastrado.');
}

/** Regras de embalagem e de baixa em outro produto (ex.: copo de chopp → barril). */
async function validateLinks(db: DB, v: { id?: number; pack_label?: string | null; pack_size_milli?: number | null; stock_source_id?: number | null; stock_source_qty_milli?: number | null; unit?: string }) {
  if ((v.pack_size_milli == null) !== !v.pack_label?.trim()) throw badRequest('Informe o nome da embalagem e quanto vem dentro (ou deixe os dois em branco).');
  if ((v.stock_source_id == null) !== (v.stock_source_qty_milli == null)) throw badRequest('Informe o produto de origem e quanto sai dele por unidade vendida.');
  if (v.stock_source_id == null) return;
  if (v.stock_source_id === v.id) throw badRequest('Um produto não pode dar baixa nele mesmo.');
  const src = await db.one('SELECT id, stock_source_id FROM products WHERE id = ?', [v.stock_source_id]);
  if (!src) throw badRequest('Produto de origem não encontrado.');
  if (src.stock_source_id) throw badRequest('O produto de origem não pode, ele mesmo, dar baixa em outro produto.');
  if (v.id && (await db.one('SELECT 1 FROM products WHERE stock_source_id = ?', [v.id]))) throw badRequest('Outros produtos já dão baixa neste; ele não pode dar baixa em outro.');
  if (v.unit && v.unit !== 'UN') throw badRequest('Produtos que dão baixa em outro devem ser vendidos por unidade (ex.: copo, dose, jarra).');
  if (v.pack_size_milli != null) throw badRequest('Produto que dá baixa em outro não tem estoque nem embalagem própria.');
}

export async function createProduct(db: DB, input: ProductInput, userId: number) {
  await validateLinks(db, input);
  if (input.stock_source_id && input.initial_stock_milli) throw badRequest('Produto que dá baixa em outro não tem estoque próprio.');
  if (!(await db.one('SELECT 1 FROM categories WHERE id = ?', [input.category_id]))) throw badRequest('Categoria inválida.');
  await checkUnique(db, 'internal_code', input.internal_code);
  await checkUnique(db, 'barcode', input.barcode);
  return tx(db, async (t) => {
    const ts = now();
    const r = await t.one<{ id: number }>(
      `INSERT INTO products (name, internal_code, barcode, category_id, unit, price_cents, cost_cents, min_stock_milli, track_expiry, active, image_url, pack_label, pack_size_milli, stock_source_id, stock_source_qty_milli, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [input.name.trim(), input.internal_code || null, input.barcode || null, input.category_id, input.unit, input.price_cents,
        input.cost_cents ?? null, input.min_stock_milli ?? 0, input.track_expiry ? 1 : 0, input.active === false ? 0 : 1, input.image_url || null,
        input.pack_label?.trim() || null, input.pack_size_milli ?? null, input.stock_source_id ?? null, input.stock_source_qty_milli ?? null, ts, ts],
    );
    const id = r!.id;
    if (input.initial_stock_milli && input.initial_stock_milli > 0) {
      await moveStock(t, { productId: id, type: 'ENTRY', qtyMilli: input.initial_stock_milli, userId, reason: 'Estoque inicial', unitCostCents: input.cost_cents });
    }
    await audit(t, userId, 'product.create', 'product', id, { name: input.name });
    return id;
  });
}

export async function updateProduct(db: DB, id: number, patch: Partial<ProductInput>, userId: number) {
  const cur = await db.one('SELECT * FROM products WHERE id = ?', [id]);
  if (!cur) throw notFound('Produto não encontrado.');
  if (patch.category_id !== undefined && !(await db.one('SELECT 1 FROM categories WHERE id = ?', [patch.category_id]))) throw badRequest('Categoria inválida.');
  if (patch.internal_code !== undefined) await checkUnique(db, 'internal_code', patch.internal_code, id);
  if (patch.barcode !== undefined) await checkUnique(db, 'barcode', patch.barcode, id);
  if (patch.unit && patch.unit !== cur.unit) {
    if (await db.one('SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1', [id])) {
      throw badRequest('Não é possível mudar a unidade de um produto com movimentações. Cadastre um novo produto.');
    }
  }
  const merged = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), id };
  await validateLinks(db, merged);
  if (merged.stock_source_id && !cur.stock_source_id && cur.stock_milli !== 0) throw badRequest('Zere o estoque deste produto antes de fazê-lo dar baixa em outro.');
  return tx(db, async (t) => {
    const next: any = { ...cur };
    for (const f of TRACKED) {
      if ((patch as any)[f] === undefined) continue;
      let v = (patch as any)[f];
      if (f === 'track_expiry' || f === 'active') v = v ? 1 : 0;
      if ((f === 'internal_code' || f === 'barcode' || f === 'image_url' || f === 'pack_label') && !v) v = null;
      if (f === 'name') v = String(v).trim();
      if (v !== cur[f]) {
        await t.run('INSERT INTO product_history (product_id, user_id, field, old_value, new_value, at) VALUES (?,?,?,?,?,?)',
          [id, userId, f, cur[f] == null ? null : String(cur[f]), v == null ? null : String(v), now()]);
        next[f] = v;
      }
    }
    await t.run(
      `UPDATE products SET name=?, internal_code=?, barcode=?, category_id=?, unit=?, price_cents=?, cost_cents=?, min_stock_milli=?, track_expiry=?, active=?, image_url=?, pack_label=?, pack_size_milli=?, stock_source_id=?, stock_source_qty_milli=?, updated_at=? WHERE id=?`,
      [next.name, next.internal_code, next.barcode, next.category_id, next.unit, next.price_cents, next.cost_cents, next.min_stock_milli, next.track_expiry, next.active, next.image_url, next.pack_label, next.pack_size_milli, next.stock_source_id, next.stock_source_qty_milli, now(), id],
    );
    await audit(t, userId, 'product.update', 'product', id, patch);
  });
}

export function listProducts(db: DB, opts: { q?: string; includeInactive?: boolean; categoryId?: number } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (!opts.includeInactive) where.push('p.active = 1');
  if (opts.categoryId) { where.push('p.category_id = ?'); args.push(opts.categoryId); }
  if (opts.q) {
    where.push('(p.name ILIKE ? OR p.internal_code = ? OR p.barcode = ?)');
    args.push(`%${opts.q}%`, opts.q, opts.q);
  }
  return db.all(
    `SELECT p.*, c.name AS category, src.name AS stock_source_name, src.unit AS stock_source_unit,
       -- Para produtos que dão baixa em outro: quantas unidades ainda dá para vender com o estoque da origem.
       CASE WHEN p.stock_source_id IS NOT NULL THEN GREATEST(0, FLOOR(src.stock_milli::numeric / p.stock_source_qty_milli))::bigint * 1000 ELSE p.stock_milli END AS stock_milli,
       p.stock_milli AS own_stock_milli
     FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN products src ON src.id = p.stock_source_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name`,
    args,
  );
}

export function productHistory(db: DB, id: number) {
  return db.all(
    `SELECT h.*, u.name AS user_name FROM product_history h LEFT JOIN users u ON u.id = h.user_id WHERE product_id = ? ORDER BY h.id DESC`,
    [id],
  );
}

/** Campos visíveis ao operador (sem custo). */
export function publicProduct(p: any) {
  const { cost_cents, ...rest } = p;
  return rest;
}
