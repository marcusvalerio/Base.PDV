import { DB } from '../db.js';
import { addDays, daysBetween, localDate, rangeToUtc } from '../tz.js';
import { badRequest } from '../errors.js';
import { getNumberSetting } from './settings.js';
import { lowStock, expiringSoon } from './stock.js';
import { openRegisters } from './cash.js';
import { FRACTIONAL_UNITS, Unit } from '../money.js';

export type Preset = 'today' | '7d' | '15d' | '30d' | 'month' | 'custom';

export function resolvePeriod(preset: Preset, from?: string, to?: string, today = localDate(new Date())) {
  switch (preset) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: addDays(today, -6), to: today };
    case '15d': return { from: addDays(today, -14), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: today.slice(0, 8) + '01', to: today };
    case 'custom': {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!from || !to || !re.test(from) || !re.test(to) || from > to) throw badRequest('Intervalo de datas inválido.');
      if (daysBetween(from, to) > 366) throw badRequest('O intervalo máximo é de 1 ano.');
      return { from, to };
    }
    default: throw badRequest('Período inválido.');
  }
}

interface Filter { categoryId?: number; productId?: number }

async function itemRows(db: DB, from: string, to: string, f: Filter): Promise<any[]> {
  const { start, end } = rangeToUtc(from, to);
  const where = ["s.status = 'COMPLETED'", 's.created_at >= ?', 's.created_at < ?'];
  const args: any[] = [start, end];
  if (f.categoryId) { where.push('si.category_id = ?'); args.push(f.categoryId); }
  if (f.productId) { where.push('si.product_id = ?'); args.push(f.productId); }
  return db.all(
    `SELECT si.sale_id, si.product_id, si.product_name, si.category_id, c.name AS category, si.unit, si.qty_milli,
            si.total_cents, si.unit_cost_cents, si.stock_product_id, si.stock_qty_milli, s.created_at
     FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN categories c ON c.id = si.category_id
     WHERE ${where.join(' AND ')}`,
    args,
  );
}

async function surchargeTotal(db: DB, from: string, to: string): Promise<number> {
  const { start, end } = rangeToUtc(from, to);
  return (await db.one("SELECT COALESCE(SUM(surcharge_cents),0)::bigint AS t FROM sales WHERE status='COMPLETED' AND created_at >= ? AND created_at < ?", [start, end])).t;
}

function summarize(rows: any[]) {
  const sales = new Set(rows.map((r) => r.sale_id));
  const revenue = rows.reduce((a, r) => a + r.total_cents, 0);
  const costed = rows.filter((r) => r.unit_cost_cents != null);
  const costedRevenue = costed.reduce((a, r) => a + r.total_cents, 0);
  const cogs = costed.reduce((a, r) => a + Math.round((r.unit_cost_cents * r.qty_milli) / 1000), 0);
  return {
    productRevenueCents: revenue,
    salesCount: sales.size,
    avgTicketCents: sales.size ? Math.round(revenue / sales.size) : null,
    cogsCents: cogs,
    costedRevenueCents: costedRevenue,
    /** Fração do faturamento com custo cadastrado; margem é estimativa quando < 1. */
    costCoverage: revenue ? costedRevenue / revenue : null,
    grossProfitCents: costed.length ? costedRevenue - cogs : null,
    grossMarginPct: costedRevenue ? (costedRevenue - cogs) / costedRevenue : null,
  };
}

export async function analysis(db: DB, q: { preset: Preset; from?: string; to?: string } & Filter) {
  const period = resolvePeriod(q.preset, q.from, q.to);
  const len = daysBetween(period.from, period.to) + 1;
  const prev = { from: addDays(period.from, -len), to: addDays(period.from, -1) };
  const f: Filter = { categoryId: q.categoryId, productId: q.productId };
  const rows = await itemRows(db, period.from, period.to, f);
  const prevRows = await itemRows(db, prev.from, prev.to, f);
  const summary = summarize(rows);
  const prevSummary = summarize(prevRows);
  const surcharge = !f.categoryId && !f.productId ? await surchargeTotal(db, period.from, period.to) : 0;

  const daily: Record<string, { day: string; revenueCents: number; sales: Set<number>; qty: number }> = {};
  for (let i = 0; i < len; i++) { const d = addDays(period.from, i); daily[d] = { day: d, revenueCents: 0, sales: new Set(), qty: 0 }; }
  for (const r of rows) {
    const d = daily[localDate(r.created_at)];
    if (d) { d.revenueCents += r.total_cents; d.sales.add(r.sale_id); }
  }

  const byProduct = new Map<number, any>();
  const prevQty = new Map<number, number>();
  for (const r of prevRows) prevQty.set(r.product_id, (prevQty.get(r.product_id) ?? 0) + r.qty_milli);
  for (const r of rows) {
    const p = byProduct.get(r.product_id) ?? { productId: r.product_id, name: r.product_name, category: r.category, unit: r.unit, qtyMilli: 0, revenueCents: 0, cogsCents: 0, costedRevenueCents: 0, hasCost: true };
    p.qtyMilli += r.qty_milli;
    p.revenueCents += r.total_cents;
    if (r.unit_cost_cents == null) p.hasCost = false;
    else { p.cogsCents += Math.round((r.unit_cost_cents * r.qty_milli) / 1000); p.costedRevenueCents += r.total_cents; }
    byProduct.set(r.product_id, p);
  }
  const products = [...byProduct.values()].map((p) => {
    const pq = prevQty.get(p.productId) ?? 0;
    const marginPct = p.costedRevenueCents ? (p.costedRevenueCents - p.cogsCents) / p.costedRevenueCents : null;
    return {
      ...p,
      grossProfitCents: p.costedRevenueCents ? p.costedRevenueCents - p.cogsCents : null,
      marginPct,
      prevQtyMilli: pq,
      qtyChangePct: pq ? (p.qtyMilli - pq) / pq : null,
      avgPerDayMilli: Math.round(p.qtyMilli / len),
      revenueSharePct: summary.productRevenueCents ? p.revenueCents / summary.productRevenueCents : 0,
    };
  });
  // Alta saída + baixa margem: no terço superior de faturamento com margem abaixo da mediana dos produtos com custo.
  const margins = products.filter((p) => p.marginPct != null).map((p) => p.marginPct as number).sort((a, b) => a - b);
  const medianMargin = margins.length ? margins[Math.floor(margins.length / 2)] : null;
  const byRevenue = [...products].sort((a, b) => b.revenueCents - a.revenueCents);
  const topCut = Math.max(1, Math.ceil(byRevenue.length / 3));
  const highVolumeLowMargin = medianMargin == null || margins.length < 3 ? [] :
    byRevenue.slice(0, topCut).filter((p) => p.marginPct != null && (p.marginPct as number) < medianMargin);

  // Menor giro: produtos ativos (respeitando filtro) com menos saída, incluindo os que não venderam nada.
  const catalog = await db.all(
    `SELECT p.id, p.name, p.unit, p.stock_milli, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 ${f.categoryId ? 'AND p.category_id = ' + Number(f.categoryId) : ''} ${f.productId ? 'AND p.id = ' + Number(f.productId) : ''}`,
  );
  const lowRotation = catalog
    .map((c) => ({ productId: c.id, name: c.name, category: c.category, unit: c.unit, stockMilli: c.stock_milli, qtyMilli: byProduct.get(c.id)?.qtyMilli ?? 0, revenueCents: byProduct.get(c.id)?.revenueCents ?? 0 }))
    .sort((a, b) => a.revenueCents - b.revenueCents || a.qtyMilli - b.qtyMilli)
    .slice(0, 10);

  const byCategory = new Map<string, { category: string; revenueCents: number; prevRevenueCents: number }>();
  for (const r of rows) {
    const c = byCategory.get(r.category) ?? { category: r.category, revenueCents: 0, prevRevenueCents: 0 };
    c.revenueCents += r.total_cents; byCategory.set(r.category, c);
  }
  for (const r of prevRows) {
    const c = byCategory.get(r.category) ?? { category: r.category, revenueCents: 0, prevRevenueCents: 0 };
    c.prevRevenueCents += r.total_cents; byCategory.set(r.category, c);
  }

  return {
    period: { ...period, days: len },
    previousPeriod: prev,
    summary: { ...summary, fiadoSurchargeCents: surcharge, totalRevenueCents: summary.productRevenueCents + surcharge },
    previous: prevSummary,
    revenueChangePct: prevSummary.productRevenueCents ? (summary.productRevenueCents - prevSummary.productRevenueCents) / prevSummary.productRevenueCents : null,
    daily: Object.values(daily).map((d) => ({ day: d.day, revenueCents: d.revenueCents, salesCount: d.sales.size })),
    categories: [...byCategory.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    topByQty: [...products].sort((a, b) => b.qtyMilli - a.qtyMilli),
    topByRevenue: byRevenue,
    lowRotation,
    highVolumeLowMargin,
    notes: {
      netProfit: 'Lucro líquido não é calculado: o sistema não registra despesas operacionais (aluguel, salários, contas etc.).',
      margin: 'Margem bruta = faturamento − custo das mercadorias, apenas para itens com custo cadastrado no momento da venda.',
    },
  };
}

/**
 * Sugestão de reposição explicável. Não cria pedidos. Usa média diária dos últimos `windowDays` dias,
 * prazo de reposição e reserva de segurança configurados; sinaliza quando o histórico é insuficiente.
 */
export async function restockSuggestions(db: DB, opts: { windowDays?: number; categoryId?: number; today?: string } = {}) {
  const windowDays = Math.min(Math.max(opts.windowDays ?? 30, 7), 120);
  const today = opts.today ?? localDate(new Date());
  const from = addDays(today, -(windowDays - 1));
  const lead = await getNumberSetting(db, 'restock_lead_time_days');
  const safety = await getNumberSetting(db, 'restock_safety_days');
  const targetDays = (lead ?? 7) + (safety ?? 0);
  const rows = await itemRows(db, from, today, { categoryId: opts.categoryId });
  const sold = new Map<number, number>();
  for (const r of rows) { const pid = r.stock_product_id ?? r.product_id; const q = r.stock_qty_milli ?? r.qty_milli; sold.set(pid, (sold.get(pid) ?? 0) + q); }
  const products = await db.all(
    `SELECT p.id, p.name, p.unit, p.stock_milli, p.min_stock_milli, p.cost_cents, p.created_at, c.name AS category
     FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND p.stock_source_id IS NULL ${opts.categoryId ? 'AND p.category_id = ' + Number(opts.categoryId) : ''}`,
  );
  const firstSales = new Map<number, string>((await db.all("SELECT COALESCE(si.stock_product_id, si.product_id) AS product_id, MIN(s.created_at) AS f FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status='COMPLETED' GROUP BY 1")).map((r) => [r.product_id, r.f]));

  const items = products.map((p) => {
    const q = sold.get(p.id) ?? 0;
    const first = firstSales.get(p.id) ?? null;
    const historyDays = first ? Math.min(windowDays, daysBetween(localDate(first), today) + 1) : 0;
    const limited = historyDays < 7;
    const avgDaily = historyDays > 0 ? q / historyDays : 0;
    const coverageDays = avgDaily > 0 ? Math.max(0, p.stock_milli) / avgDaily : null;
    let target = Math.max(p.min_stock_milli, Math.ceil(avgDaily * targetDays));
    let suggested = Math.max(0, target - p.stock_milli);
    if (!FRACTIONAL_UNITS.includes(p.unit as Unit)) suggested = Math.ceil(suggested / 1000) * 1000;
    const reasons: string[] = [];
    if (p.stock_milli <= p.min_stock_milli && p.min_stock_milli > 0) reasons.push('Estoque no mínimo ou abaixo dele.');
    if (coverageDays != null && coverageDays < targetDays) reasons.push(`Estoque cobre ~${coverageDays.toFixed(1)} dia(s); alvo de ${targetDays} dia(s).`);
    if (limited) reasons.push(historyDays === 0 ? 'Sem vendas no período: sugestão baseada apenas no estoque mínimo.' : `Histórico curto (${historyDays} dia(s)): estimativa limitada.`);
    return {
      productId: p.id, name: p.name, category: p.category, unit: p.unit, stockMilli: p.stock_milli, minStockMilli: p.min_stock_milli,
      soldMilli: q, historyDays, avgDailyMilli: Math.round(avgDaily), coverageDays: coverageDays == null ? null : Math.round(coverageDays * 10) / 10,
      targetMilli: target, suggestedMilli: suggested, estimatedCostCents: p.cost_cents != null ? Math.round((p.cost_cents * suggested) / 1000) : null,
      limitedHistory: limited, reasons, needsRestock: suggested > 0,
    };
  }).sort((a, b) => Number(b.needsRestock) - Number(a.needsRestock) || (a.coverageDays ?? 1e9) - (b.coverageDays ?? 1e9));

  return {
    windowDays, from, to: today, leadTimeDays: lead, safetyDays: safety, targetDays,
    assumptions: [
      `Média diária calculada sobre as vendas dos últimos ${windowDays} dias (ou desde a primeira venda, se mais recente).`,
      lead == null ? 'Prazo de reposição não configurado: usando 7 dias como referência.' : `Prazo de reposição: ${lead} dia(s).`,
      safety == null ? 'Reserva de segurança não configurada.' : `Reserva de segurança: ${safety} dia(s).`,
      'Quantidade sugerida = max(estoque mínimo, média diária × dias-alvo) − estoque atual. Ajuste conforme sua experiência.',
    ],
    items,
  };
}

export async function dashboard(db: DB) {
  const today = await analysis(db, { preset: 'today' });
  const week = await analysis(db, { preset: '7d' });
  const fiado = await db.one(
    `SELECT COALESCE(SUM(total_cents - paid_cents),0)::bigint AS total, COUNT(DISTINCT customer_id)::int AS customers FROM receivables WHERE status = 'OPEN'`,
  );
  return {
    today: today.summary,
    todayChangePct: today.revenueChangePct,
    week: week.summary,
    topProducts: week.topByQty.slice(0, 5),
    lowStock: await lowStock(db),
    expiring: await expiringSoon(db),
    fiado: { pendingCents: fiado.total, customers: fiado.customers },
    openRegisters: await openRegisters(db),
  };
}
