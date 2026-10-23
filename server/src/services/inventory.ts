import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { moveStock } from './stock.js';
import { assertQty } from '../money.js';

/**
 * Inventário por sessões de contagem.
 *  - Escopo: FULL (todos os ativos), CATEGORY (uma categoria) ou PARTIAL (produtos escolhidos / lidos).
 *  - Contagem cega (padrão): quem conta não vê o saldo do sistema.
 *  - Para cada item guardamos o saldo do sistema no momento da contagem; a divergência é contado − esse saldo,
 *    então vendas feitas depois da contagem não viram falsa divergência.
 *  - Acuracidade: % de itens contados sem divergência e acuracidade em valor (custo).
 */
export function createSession(db: DB, input: { name?: string; scope: 'FULL' | 'CATEGORY' | 'PARTIAL'; categoryId?: number | null; productIds?: number[]; blind?: boolean }, userId: number) {
  if (input.scope === 'CATEGORY' && !input.categoryId) throw badRequest('Escolha a categoria.');
  return tx(db, () => {
    const name = input.name?.trim() || `Inventário ${new Date().toLocaleDateString('pt-BR')}`;
    const r = db.prepare("INSERT INTO inventory_sessions (name, scope, category_id, blind, status, created_by, created_at) VALUES (?,?,?,?, 'OPEN', ?, ?)")
      .run(name, input.scope, input.scope === 'CATEGORY' ? input.categoryId! : null, input.blind === false ? 0 : 1, userId, now());
    const id = Number(r.lastInsertRowid);
    let ids: number[] = [];
    if (input.scope === 'FULL') ids = (db.prepare('SELECT id FROM products WHERE active = 1').all() as any[]).map((x) => x.id);
    if (input.scope === 'CATEGORY') ids = (db.prepare('SELECT id FROM products WHERE active = 1 AND category_id = ?').all(input.categoryId!) as any[]).map((x) => x.id);
    if (input.scope === 'PARTIAL') ids = input.productIds ?? [];
    const ins = db.prepare('INSERT OR IGNORE INTO inventory_session_items (session_id, product_id) VALUES (?,?)');
    for (const pid of ids) ins.run(id, pid);
    audit(db, userId, 'inventory.create', 'inventory_session', id, { scope: input.scope, items: ids.length });
    return id;
  });
}

function openSession(db: DB, id: number) {
  const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(id) as any;
  if (!s) throw notFound('Inventário não encontrado.');
  if (s.status !== 'OPEN') throw conflict('Este inventário já foi encerrado.');
  return s;
}

/** Registra contagem: mode "add" soma (leitura item a item), "set" substitui (recontagem / quantidade digitada). */
export function countItem(db: DB, sessionId: number, input: { productId: number; qtyMilli: number; mode: 'add' | 'set' }, userId: number) {
  return tx(db, () => {
    const s = openSession(db, sessionId);
    const p = db.prepare('SELECT id, name, unit, stock_milli, cost_cents, category_id FROM products WHERE id = ?').get(input.productId) as any;
    if (!p) throw notFound('Produto não encontrado.');
    if (input.qtyMilli < 0 || (input.qtyMilli === 0 && input.mode === 'add')) throw badRequest('Quantidade inválida.');
    if (input.qtyMilli > 0) { try { assertQty(p.unit, input.qtyMilli); } catch (e: any) { throw badRequest(e.message); } }
    let item = db.prepare('SELECT * FROM inventory_session_items WHERE session_id = ? AND product_id = ?').get(sessionId, p.id) as any;
    if (!item) {
      if (s.scope === 'CATEGORY' && p.category_id !== s.category_id) throw badRequest(`"${p.name}" não pertence à categoria deste inventário.`);
      db.prepare('INSERT INTO inventory_session_items (session_id, product_id) VALUES (?,?)').run(sessionId, p.id);
      item = { counted_milli: null };
    }
    const counted = input.mode === 'add' ? (item.counted_milli ?? 0) + input.qtyMilli : input.qtyMilli;
    db.prepare('UPDATE inventory_session_items SET counted_milli = ?, system_at_count_milli = ?, unit_cost_cents = ?, counted_by = ?, counted_at = ? WHERE session_id = ? AND product_id = ?')
      .run(counted, p.stock_milli, p.cost_cents, userId, now(), sessionId, p.id);
    return { productId: p.id, name: p.name, unit: p.unit, countedMilli: counted };
  });
}

export function clearCount(db: DB, sessionId: number, productId: number, userId: number) {
  openSession(db, sessionId);
  db.prepare('UPDATE inventory_session_items SET counted_milli = NULL, system_at_count_milli = NULL, counted_by = NULL, counted_at = NULL WHERE session_id = ? AND product_id = ?').run(sessionId, productId);
  audit(db, userId, 'inventory.clear_item', 'inventory_session', sessionId, { productId });
}

export function computeAccuracy(items: { countedMilli: number | null; systemMilli: number | null; unitCostCents: number | null }[]) {
  const counted = items.filter((i) => i.countedMilli != null);
  const matched = counted.filter((i) => i.countedMilli === i.systemMilli).length;
  const costed = counted.filter((i) => i.unitCostCents != null);
  const systemValue = costed.reduce((a, i) => a + Math.max(0, i.systemMilli!) * i.unitCostCents! / 1000, 0);
  const diffAbs = costed.reduce((a, i) => a + Math.abs(i.countedMilli! - i.systemMilli!) * i.unitCostCents! / 1000, 0);
  const diffNet = costed.reduce((a, i) => a + (i.countedMilli! - i.systemMilli!) * i.unitCostCents! / 1000, 0);
  return {
    countedItems: counted.length,
    matchedItems: matched,
    divergentItems: counted.length - matched,
    itemAccuracy: counted.length ? matched / counted.length : null,
    systemValueCents: Math.round(systemValue),
    divergenceAbsCents: Math.round(diffAbs),
    divergenceNetCents: Math.round(diffNet),
    /** 1 − |divergências em valor| / valor do sistema (só itens com custo). */
    valueAccuracy: systemValue > 0 ? Math.max(0, 1 - diffAbs / systemValue) : null,
  };
}

export function getSession(db: DB, id: number, opts: { revealSystem: boolean }) {
  const s = db.prepare(
    `SELECT s.*, c.name AS category, u.name AS created_by_name, f.name AS finished_by_name FROM inventory_sessions s
     JOIN users u ON u.id = s.created_by LEFT JOIN users f ON f.id = s.finished_by LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = ?`,
  ).get(id) as any;
  if (!s) throw notFound('Inventário não encontrado.');
  const rows = db.prepare(
    `SELECT i.*, p.name, p.unit, p.barcode, p.internal_code, p.stock_milli, c.name AS category, u.name AS counted_by_name
     FROM inventory_session_items i JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
     LEFT JOIN users u ON u.id = i.counted_by WHERE i.session_id = ? ORDER BY c.name, p.name`,
  ).all(id) as any[];
  const reveal = opts.revealSystem || !s.blind || s.status !== 'OPEN';
  const items = rows.map((r) => ({
    productId: r.product_id, name: r.name, unit: r.unit, category: r.category, barcode: r.barcode, internalCode: r.internal_code,
    countedMilli: r.counted_milli, countedByName: r.counted_by_name, countedAt: r.counted_at,
    ...(reveal ? {
      systemMilli: r.counted_milli != null ? r.system_at_count_milli : r.stock_milli,
      diffMilli: r.counted_milli != null ? r.counted_milli - r.system_at_count_milli : null,
      unitCostCents: r.unit_cost_cents ?? null,
      diffValueCents: r.counted_milli != null && r.unit_cost_cents != null ? Math.round((r.counted_milli - r.system_at_count_milli) * r.unit_cost_cents / 1000) : null,
    } : {}),
  }));
  const accuracy = reveal ? computeAccuracy(rows.map((r) => ({ countedMilli: r.counted_milli, systemMilli: r.system_at_count_milli, unitCostCents: r.unit_cost_cents }))) : null;
  return { ...s, blind: !!s.blind, applied: !!s.applied, summary_json: undefined, revealed: reveal, totalItems: rows.length, countedItems: rows.filter((r) => r.counted_milli != null).length, items, accuracy };
}

/** Encerra a contagem. Com apply=true, gera movimentações de inventário corrigindo o estoque pelas divergências. */
export function finishSession(db: DB, id: number, input: { apply: boolean }, userId: number) {
  return tx(db, () => {
    openSession(db, id);
    const rows = db.prepare('SELECT * FROM inventory_session_items WHERE session_id = ? AND counted_milli IS NOT NULL').all(id) as any[];
    if (!rows.length) throw badRequest('Nenhum produto foi contado.');
    const acc = computeAccuracy(rows.map((r) => ({ countedMilli: r.counted_milli, systemMilli: r.system_at_count_milli, unitCostCents: r.unit_cost_cents })));
    if (input.apply) {
      for (const r of rows) {
        const diff = r.counted_milli - r.system_at_count_milli;
        if (diff !== 0) moveStock(db, { productId: r.product_id, type: 'INVENTORY', qtyMilli: diff, userId, reason: 'Inventário (acuracidade)', refType: 'inventory_session', refId: id });
      }
    }
    const uncounted = (db.prepare('SELECT COUNT(*) n FROM inventory_session_items WHERE session_id = ? AND counted_milli IS NULL').get(id) as any).n;
    db.prepare("UPDATE inventory_sessions SET status='FINISHED', finished_by=?, finished_at=?, applied=?, item_accuracy=?, value_accuracy=?, summary_json=? WHERE id=?")
      .run(userId, now(), input.apply ? 1 : 0, acc.itemAccuracy, acc.valueAccuracy, JSON.stringify({ ...acc, uncounted }), id);
    audit(db, userId, 'inventory.finish', 'inventory_session', id, { apply: input.apply, ...acc });
    return getSession(db, id, { revealSystem: true });
  });
}

export function cancelSession(db: DB, id: number, userId: number) {
  openSession(db, id);
  db.prepare("UPDATE inventory_sessions SET status='CANCELLED', finished_by=?, finished_at=? WHERE id=?").run(userId, now(), id);
  audit(db, userId, 'inventory.cancel', 'inventory_session', id);
}

export function listSessions(db: DB) {
  return (db.prepare(
    `SELECT s.id, s.name, s.scope, s.blind, s.status, s.created_at, s.finished_at, s.applied, s.item_accuracy, s.value_accuracy, s.summary_json,
            c.name AS category, u.name AS created_by_name,
            (SELECT COUNT(*) FROM inventory_session_items i WHERE i.session_id = s.id) AS total_items,
            (SELECT COUNT(*) FROM inventory_session_items i WHERE i.session_id = s.id AND i.counted_milli IS NOT NULL) AS counted_items
     FROM inventory_sessions s JOIN users u ON u.id = s.created_by LEFT JOIN categories c ON c.id = s.category_id ORDER BY s.id DESC LIMIT 100`,
  ).all() as any[]).map(({ summary_json, ...r }) => ({ ...r, summary: summary_json ? JSON.parse(summary_json) : null }));
}
