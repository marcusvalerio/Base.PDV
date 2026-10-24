import { DB, now, audit, tx, isUniqueViolation } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { prepareLines, persistSaleTx, getSale, idempotentSale } from './sales.js';

/**
 * Mesas/comandas. Consumo em aberto (tab_items PENDING) NÃO é dívida: só vira venda (e, se a prazo, fiado)
 * quando a conta individual ou a mesa é fechada. Itens pagos ficam vinculados à venda (sale_id) e não podem ser cobrados de novo.
 */
export async function openTab(db: DB, label: string, people: string[], userId: number) {
  if (!label?.trim()) throw badRequest('Informe a mesa ou identificação.');
  try {
    return await tx(db, async (t) => {
      const r = await t.one<{ id: number }>("INSERT INTO tabs (label, status, opened_by, opened_at) VALUES (?, 'OPEN', ?, ?) RETURNING id", [label.trim(), userId, now()]);
      const id = r!.id;
      for (const p of people.filter((x) => x.trim())) await addPerson(t, id, p, userId);
      await audit(t, userId, 'tab.open', 'tab', id, { label });
      return id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Esta mesa já está aberta.');
    throw e;
  }
}

async function openTabOrThrow(db: DB, tabId: number, lock = false) {
  const t = await db.one(`SELECT * FROM tabs WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [tabId]);
  if (!t) throw notFound('Mesa não encontrada.');
  if (t.status !== 'OPEN') throw conflict('Esta mesa já foi fechada.');
  return t;
}

export async function addPerson(db: DB, tabId: number, name: string, userId: number) {
  await openTabOrThrow(db, tabId);
  if (!name?.trim()) throw badRequest('Informe o nome da pessoa.');
  const r = await db.one<{ id: number }>('INSERT INTO tab_people (tab_id, name, created_at) VALUES (?,?,?) RETURNING id', [tabId, name.trim(), now()]);
  await audit(db, userId, 'tab.add_person', 'tab', tabId, { name });
  return r!.id;
}

export async function addTabItems(db: DB, tabId: number, personId: number, items: { productId: number; qtyMilli: number }[], userId: number) {
  await tx(db, async (t) => {
    await openTabOrThrow(t, tabId, true);
    if (!(await t.one('SELECT 1 FROM tab_people WHERE id = ? AND tab_id = ?', [personId, tabId]))) throw badRequest('Pessoa não pertence a esta mesa.');
    for (const l of await prepareLines(t, items)) {
      await t.run(
        `INSERT INTO tab_items (tab_id, person_id, product_id, product_name, unit, qty_milli, unit_price_cents, total_cents, status, added_by, added_at)
         VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`,
        [tabId, personId, l.productId, l.productName, l.unit, l.qtyMilli, l.unitPriceCents, l.totalCents, userId, now()],
      );
    }
    await audit(t, userId, 'tab.add_items', 'tab', tabId, { personId, items });
  });
  return getTab(db, tabId);
}

/** Correção de lançamento: o item é marcado como anulado (com motivo e usuário), nunca apagado. */
export async function voidTabItem(db: DB, tabId: number, itemId: number, reason: string, userId: number) {
  if (!reason?.trim()) throw badRequest('Informe o motivo da correção.');
  await tx(db, async (t) => {
    await openTabOrThrow(t, tabId, true);
    const it = await t.one('SELECT * FROM tab_items WHERE id = ? AND tab_id = ?', [itemId, tabId]);
    if (!it) throw notFound('Item não encontrado.');
    if (it.status !== 'PENDING') throw conflict('Só é possível corrigir itens ainda não pagos.');
    await t.run("UPDATE tab_items SET status='VOIDED', voided_by=?, voided_at=?, void_reason=? WHERE id=?", [userId, now(), reason.trim(), itemId]);
    await audit(t, userId, 'tab.void_item', 'tab', tabId, { itemId, reason });
  });
  return getTab(db, tabId);
}

/**
 * Fecha a conta de uma pessoa (personId) ou de toda a mesa (personId = null), cobrando apenas os itens pendentes.
 * Idempotente pela chave. Quando não restam itens pendentes após o fechamento da mesa inteira, a mesa é encerrada.
 */
export async function closeTabBill(db: DB, tabId: number, input: { idempotencyKey: string; personId: number | null; paymentMethodCode: string; customerId?: number | null; receivedCents?: number | null }, userId: number) {
  return idempotentSale(db, input.idempotencyKey,
    async () => {
      const saleId = await tx(db, async (t) => {
        await openTabOrThrow(t, tabId, true);
        const items = input.personId
          ? await t.all("SELECT * FROM tab_items WHERE tab_id = ? AND person_id = ? AND status = 'PENDING' ORDER BY id", [tabId, input.personId])
          : await t.all("SELECT * FROM tab_items WHERE tab_id = ? AND status = 'PENDING' ORDER BY id", [tabId]);
        if (!items.length) throw badRequest('Não há itens pendentes para cobrar.');
        const lines = [];
        for (const it of items) {
          const p = await t.one('SELECT category_id, cost_cents FROM products WHERE id = ?', [it.product_id]);
          // Preço registrado no momento do consumo é preservado.
          lines.push({
            productId: it.product_id, productName: it.product_name, categoryId: p.category_id, unit: it.unit, qtyMilli: it.qty_milli,
            unitPriceCents: it.unit_price_cents, unitCostCents: p.cost_cents, totalCents: it.total_cents, tabPersonId: it.person_id,
          });
        }
        const id = await persistSaleTx(t, { idempotencyKey: input.idempotencyKey, paymentMethodCode: input.paymentMethodCode, customerId: input.customerId, receivedCents: input.receivedCents, lines, tabId }, userId);
        for (const it of items) {
          const u = await t.run("UPDATE tab_items SET status='PAID', sale_id=? WHERE id=? AND status='PENDING'", [id, it.id]);
          if (u.rowCount !== 1) throw conflict('Um dos itens já foi cobrado. Atualize a tela.');
        }
        const remaining = (await t.one("SELECT COUNT(*)::int AS n FROM tab_items WHERE tab_id = ? AND status = 'PENDING'", [tabId])).n;
        if (remaining === 0 && input.personId === null) await t.run("UPDATE tabs SET status='CLOSED', closed_at=? WHERE id=?", [now(), tabId]);
        await audit(t, userId, 'tab.close_bill', 'tab', tabId, { personId: input.personId, saleId: id });
        return id;
      });
      return { sale: await getSale(db, saleId), tab: await getTab(db, tabId), replayed: false };
    },
    async (id) => ({ sale: await getSale(db, id), tab: await getTab(db, tabId), replayed: true }));
}

/** Encerra a mesa quando não há mais nada pendente (ex.: todos pagaram individualmente). */
export async function finishTab(db: DB, tabId: number, userId: number) {
  await tx(db, async (t) => {
    await openTabOrThrow(t, tabId, true);
    const pending = (await t.one("SELECT COUNT(*)::int AS n FROM tab_items WHERE tab_id = ? AND status = 'PENDING'", [tabId])).n;
    if (pending > 0) throw conflict('Ainda há itens pendentes nesta mesa.');
    const paid = (await t.one("SELECT COUNT(*)::int AS n FROM tab_items WHERE tab_id = ? AND status = 'PAID'", [tabId])).n;
    await t.run('UPDATE tabs SET status=?, closed_at=? WHERE id=?', [paid > 0 ? 'CLOSED' : 'CANCELLED', now(), tabId]);
    await audit(t, userId, 'tab.finish', 'tab', tabId);
  });
  return getTab(db, tabId);
}

export async function getTab(db: DB, tabId: number) {
  const t = await db.one('SELECT t.*, u.name AS opened_by_name FROM tabs t JOIN users u ON u.id = t.opened_by WHERE t.id = ?', [tabId]);
  if (!t) throw notFound('Mesa não encontrada.');
  const people = await db.all('SELECT * FROM tab_people WHERE tab_id = ? ORDER BY id', [tabId]);
  const items = await db.all('SELECT * FROM tab_items WHERE tab_id = ? ORDER BY id', [tabId]);
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
  return db.all(
    `SELECT t.id, t.label, t.opened_at,
      (SELECT COUNT(*)::int FROM tab_people p WHERE p.tab_id = t.id) AS people_count,
      COALESCE((SELECT SUM(total_cents) FROM tab_items i WHERE i.tab_id = t.id AND i.status = 'PENDING'),0)::bigint AS pending_cents
     FROM tabs t WHERE t.status = 'OPEN' ORDER BY t.label`,
  );
}
