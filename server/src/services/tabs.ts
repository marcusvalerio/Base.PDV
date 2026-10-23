import { DB, now, audit, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { prepareLines, persistSale, getSale } from './sales.js';

/**
 * Mesas/comandas. Consumo em aberto (tab_items PENDING) NÃO é dívida: só vira venda (e, se a prazo, fiado)
 * quando a conta individual ou a mesa é fechada. Itens pagos ficam vinculados à venda (sale_id) e não podem ser cobrados de novo.
 */
export function openTab(db: DB, label: string, people: string[], userId: number) {
  if (!label?.trim()) throw badRequest('Informe a mesa ou identificação.');
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM tabs WHERE label = ? AND status = 'OPEN'").get(label.trim())) throw conflict('Esta mesa já está aberta.');
    const r = db.prepare("INSERT INTO tabs (label, status, opened_by, opened_at) VALUES (?, 'OPEN', ?, ?)").run(label.trim(), userId, now());
    const id = Number(r.lastInsertRowid);
    for (const p of people.filter((x) => x.trim())) addPerson(db, id, p, userId);
    audit(db, userId, 'tab.open', 'tab', id, { label });
    return id;
  });
}

function openTabOrThrow(db: DB, tabId: number) {
  const t = db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId) as any;
  if (!t) throw notFound('Mesa não encontrada.');
  if (t.status !== 'OPEN') throw conflict('Esta mesa já foi fechada.');
  return t;
}

export function addPerson(db: DB, tabId: number, name: string, userId: number) {
  openTabOrThrow(db, tabId);
  if (!name?.trim()) throw badRequest('Informe o nome da pessoa.');
  const r = db.prepare('INSERT INTO tab_people (tab_id, name, created_at) VALUES (?,?,?)').run(tabId, name.trim(), now());
  audit(db, userId, 'tab.add_person', 'tab', tabId, { name });
  return Number(r.lastInsertRowid);
}

export function addTabItems(db: DB, tabId: number, personId: number, items: { productId: number; qtyMilli: number }[], userId: number) {
  return tx(db, () => {
    openTabOrThrow(db, tabId);
    const person = db.prepare('SELECT * FROM tab_people WHERE id = ? AND tab_id = ?').get(personId, tabId);
    if (!person) throw badRequest('Pessoa não pertence a esta mesa.');
    const lines = prepareLines(db, items);
    const ins = db.prepare(
      `INSERT INTO tab_items (tab_id, person_id, product_id, product_name, unit, qty_milli, unit_price_cents, total_cents, status, added_by, added_at)
       VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`,
    );
    for (const l of lines) ins.run(tabId, personId, l.productId, l.productName, l.unit, l.qtyMilli, l.unitPriceCents, l.totalCents, userId, now());
    audit(db, userId, 'tab.add_items', 'tab', tabId, { personId, items });
    return getTab(db, tabId);
  });
}

/** Correção de lançamento: o item é marcado como anulado (com motivo e usuário), nunca apagado. */
export function voidTabItem(db: DB, tabId: number, itemId: number, reason: string, userId: number) {
  if (!reason?.trim()) throw badRequest('Informe o motivo da correção.');
  return tx(db, () => {
    openTabOrThrow(db, tabId);
    const it = db.prepare('SELECT * FROM tab_items WHERE id = ? AND tab_id = ?').get(itemId, tabId) as any;
    if (!it) throw notFound('Item não encontrado.');
    if (it.status !== 'PENDING') throw conflict('Só é possível corrigir itens ainda não pagos.');
    db.prepare("UPDATE tab_items SET status='VOIDED', voided_by=?, voided_at=?, void_reason=? WHERE id=?").run(userId, now(), reason.trim(), itemId);
    audit(db, userId, 'tab.void_item', 'tab', tabId, { itemId, reason });
    return getTab(db, tabId);
  });
}

/**
 * Fecha a conta de uma pessoa (personId) ou de toda a mesa (personId = null), cobrando apenas os itens pendentes.
 * Idempotente pela chave. Quando não restam itens pendentes após o fechamento da mesa inteira, a mesa é encerrada.
 */
export function closeTabBill(db: DB, tabId: number, input: { idempotencyKey: string; personId: number | null; paymentMethodCode: string; customerId?: number | null; receivedCents?: number | null }, userId: number) {
  const prev = db.prepare('SELECT id FROM sales WHERE idempotency_key = ?').get(input.idempotencyKey) as any;
  if (prev) return { sale: getSale(db, prev.id), tab: getTab(db, tabId), replayed: true };
  return tx(db, () => {
    openTabOrThrow(db, tabId);
    const items = (input.personId
      ? db.prepare("SELECT * FROM tab_items WHERE tab_id = ? AND person_id = ? AND status = 'PENDING' ORDER BY id").all(tabId, input.personId)
      : db.prepare("SELECT * FROM tab_items WHERE tab_id = ? AND status = 'PENDING' ORDER BY id").all(tabId)) as any[];
    if (!items.length) throw badRequest('Não há itens pendentes para cobrar.');
    const lines = items.map((it) => {
      const p = db.prepare('SELECT category_id, cost_cents FROM products WHERE id = ?').get(it.product_id) as any;
      // Preço registrado no momento do consumo é preservado.
      return {
        productId: it.product_id, productName: it.product_name, categoryId: p.category_id, unit: it.unit, qtyMilli: it.qty_milli,
        unitPriceCents: it.unit_price_cents, unitCostCents: p.cost_cents, totalCents: it.total_cents, tabPersonId: it.person_id,
      };
    });
    const sale = persistSale(db, { idempotencyKey: input.idempotencyKey, paymentMethodCode: input.paymentMethodCode, customerId: input.customerId, receivedCents: input.receivedCents, lines, tabId }, userId);
    const upd = db.prepare("UPDATE tab_items SET status='PAID', sale_id=? WHERE id=? AND status='PENDING'");
    for (const it of items) {
      if (upd.run(sale.id, it.id).changes !== 1) throw conflict('Um dos itens já foi cobrado. Atualize a tela.');
    }
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM tab_items WHERE tab_id = ? AND status = 'PENDING'").get(tabId) as any).n;
    if (remaining === 0 && input.personId === null) {
      db.prepare("UPDATE tabs SET status='CLOSED', closed_at=? WHERE id=?").run(now(), tabId);
    }
    audit(db, userId, 'tab.close_bill', 'tab', tabId, { personId: input.personId, saleId: sale.id });
    return { sale, tab: getTab(db, tabId), replayed: false };
  });
}

/** Encerra a mesa quando não há mais nada pendente (ex.: todos pagaram individualmente). */
export function finishTab(db: DB, tabId: number, userId: number) {
  return tx(db, () => {
    openTabOrThrow(db, tabId);
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM tab_items WHERE tab_id = ? AND status = 'PENDING'").get(tabId) as any).n;
    if (pending > 0) throw conflict('Ainda há itens pendentes nesta mesa.');
    const paid = (db.prepare("SELECT COUNT(*) AS n FROM tab_items WHERE tab_id = ? AND status = 'PAID'").get(tabId) as any).n;
    db.prepare('UPDATE tabs SET status=?, closed_at=? WHERE id=?').run(paid > 0 ? 'CLOSED' : 'CANCELLED', now(), tabId);
    audit(db, userId, 'tab.finish', 'tab', tabId);
    return getTab(db, tabId);
  });
}

export function getTab(db: DB, tabId: number) {
  const t = db.prepare('SELECT t.*, u.name AS opened_by_name FROM tabs t JOIN users u ON u.id = t.opened_by WHERE t.id = ?').get(tabId) as any;
  if (!t) throw notFound('Mesa não encontrada.');
  const people = db.prepare('SELECT * FROM tab_people WHERE tab_id = ? ORDER BY id').all(tabId) as any[];
  const items = db.prepare('SELECT * FROM tab_items WHERE tab_id = ? ORDER BY id').all(tabId) as any[];
  for (const p of people) {
    p.items = items.filter((i) => i.person_id === p.id);
    p.pending_cents = p.items.filter((i: any) => i.status === 'PENDING').reduce((a: number, i: any) => a + i.total_cents, 0);
    p.paid_cents = p.items.filter((i: any) => i.status === 'PAID').reduce((a: number, i: any) => a + i.total_cents, 0);
  }
  t.people = people;
  t.pending_cents = people.reduce((a, p) => a + p.pending_cents, 0);
  t.paid_cents = people.reduce((a, p) => a + p.paid_cents, 0);
  return t;
}

export function listOpenTabs(db: DB) {
  return db.prepare(
    `SELECT t.id, t.label, t.opened_at,
      (SELECT COUNT(*) FROM tab_people p WHERE p.tab_id = t.id) AS people_count,
      COALESCE((SELECT SUM(total_cents) FROM tab_items i WHERE i.tab_id = t.id AND i.status = 'PENDING'),0) AS pending_cents
     FROM tabs t WHERE t.status = 'OPEN' ORDER BY t.label`,
  ).all();
}
