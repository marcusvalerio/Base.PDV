import { useState } from 'react';
import { useApi } from '../../lib/hooks';
import { money, pct, qty, date, todayISO } from '../../lib/format';
import { Loading, ErrorState, Empty, Metric, Change, Segmented } from '../../components/ui';
import { PeriodFilter, PeriodState, periodQuery } from '../../components/PeriodFilter';
import { DailyChart } from '../../components/BarChart';

type Rank = 'qty' | 'revenue' | 'low' | 'margin';

export default function Analysis() {
  const [f, setF] = useState<PeriodState>({ preset: '7d', from: todayISO(), to: todayISO(), categoryId: '' });
  const [productId, setProductId] = useState('');
  const [rank, setRank] = useState<Rank>('qty');
  const q = periodQuery(f, productId ? { productId } : {});
  const { data: a, loading, error, reload } = useApi<any>(q ? `/analytics?${q}` : null);
  const products = useApi<any[]>('/products?all=1');
  const visibleProducts = (products.data ?? []).filter((p) => !f.categoryId || String(p.category_id) === f.categoryId);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head"><h1>Análise</h1></div>
      <div className="stack" style={{ gap: 8 }}>
        <PeriodFilter value={f} onChange={(v) => { setF(v); if (v.categoryId !== f.categoryId) setProductId(''); }} />
        <select className="input" style={{ width: 'auto', minWidth: 220, maxWidth: '100%' }} value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Produto">
          <option value="">Todos os produtos</option>
          {visibleProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {!q ? <div className="notice">Escolha as duas datas do intervalo.</div> : error ? <ErrorState message={error} onRetry={reload} /> : loading && !a ? <Loading /> : a && <Body a={a} rank={rank} setRank={setRank} filtered={!!(f.categoryId || productId)} />}
    </div>
  );
}

function Body({ a, rank, setRank, filtered }: { a: any; rank: Rank; setRank: (r: Rank) => void; filtered: boolean }) {
  const s = a.summary;
  const noData = s.salesCount === 0;
  const rows = rank === 'qty' ? a.topByQty : rank === 'revenue' ? a.topByRevenue : rank === 'margin' ? a.highVolumeLowMargin : a.lowRotation;
  return (
    <>
      <div className="faint">{date(a.period.from)} a {date(a.period.to)} ({a.period.days} dia{a.period.days > 1 ? 's' : ''}) · comparado com {date(a.previousPeriod.from)} a {date(a.previousPeriod.to)}</div>
      <div className="metrics">
        <Metric label="Faturamento" value={money(filtered ? s.productRevenueCents : s.totalRevenueCents)} sub={<Change v={a.revenueChangePct} />} />
        <Metric label="Vendas" value={s.salesCount} sub={s.avgTicketCents != null ? `Ticket médio ${money(s.avgTicketCents)}` : 'Sem vendas'} />
        <Metric label="Custo das mercadorias" value={s.costedRevenueCents ? money(s.cogsCents) : '—'} sub={s.costCoverage == null ? 'Sem vendas' : `${pct(s.costCoverage)} do faturamento com custo`} />
        <Metric label="Lucro bruto estimado" value={money(s.grossProfitCents)} sub={s.grossMarginPct == null ? 'Cadastre custos para calcular' : `Margem ${pct(s.grossMarginPct, 1)}${s.costCoverage < 1 ? ' (parcial)' : ''}`} />
      </div>
      {!filtered && s.fiadoSurchargeCents > 0 && <div className="faint">Faturamento inclui {money(s.fiadoSurchargeCents)} de acréscimos de vendas a prazo.</div>}
      <div className="notice">{a.notes.netProfit}</div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}><h2>Evolução diária</h2></div>
        {noData ? <Empty>Sem vendas no período.</Empty> : <DailyChart data={a.daily} />}
      </div>

      <div className="grid2">
        <div className="card flush" style={{ gridColumn: '1 / -1' }}>
          <div className="row wrap" style={{ padding: '14px 16px' }}>
            <h2>Produtos</h2><span className="spacer" />
            <Segmented value={rank} onChange={setRank} options={[{ value: 'qty', label: 'Mais vendidos' }, { value: 'revenue', label: 'Faturamento' }, { value: 'low', label: 'Menor giro' }, { value: 'margin', label: 'Alta saída, baixa margem' }]} />
          </div>
          {rank === 'margin' && <div className="faint" style={{ padding: '0 16px 10px' }}>Produtos entre os que mais faturam com margem abaixo da mediana. Exige custo cadastrado em ao menos 3 produtos vendidos.</div>}
          {!rows.length ? <Empty>{rank === 'margin' ? 'Dados de custo insuficientes ou nenhum produto nesta situação.' : 'Sem dados no período.'}</Empty> : (
            <table className="table responsive">
              <thead><tr><th>Produto</th><th className="r">Quantidade</th><th className="r">Faturamento</th>{rank !== 'low' && <><th className="r">Margem</th><th className="r">Média/dia</th><th className="r">Variação</th></>}{rank === 'low' && <th className="r">Estoque</th>}</tr></thead>
              <tbody>
                {rows.slice(0, 30).map((p: any) => (
                  <tr key={p.productId}>
                    <td data-label="Produto"><b>{p.name}</b><div className="faint">{p.category}</div></td>
                    <td data-label="Quantidade" className="r num">{qty(p.qtyMilli, p.unit)}</td>
                    <td data-label="Faturamento" className="r num">{money(p.revenueCents)}</td>
                    {rank !== 'low' && <>
                      <td data-label="Margem" className="r num">{p.marginPct == null ? <span className="faint">sem custo</span> : pct(p.marginPct, 1)}</td>
                      <td data-label="Média/dia" className="r num">{qty(p.avgPerDayMilli, p.unit)}</td>
                      <td data-label="Variação" className="r num">{p.qtyChangePct == null ? <span className="faint">novo</span> : <span className={p.qtyChangePct >= 0 ? 'up' : 'down'}>{p.qtyChangePct >= 0 ? '+' : ''}{(p.qtyChangePct * 100).toFixed(0)}%</span>}</td>
                    </>}
                    {rank === 'low' && <td data-label="Estoque" className="r num">{qty(p.stockMilli, p.unit)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Faturamento por categoria</h2>
          {!a.categories.length ? <Empty>Sem dados.</Empty> : a.categories.map((c: any) => {
            const share = s.productRevenueCents ? c.revenueCents / s.productRevenueCents : 0;
            const ch = c.prevRevenueCents ? (c.revenueCents - c.prevRevenueCents) / c.prevRevenueCents : null;
            return (
              <div key={c.category} style={{ marginBottom: 12 }}>
                <div className="row" style={{ fontSize: 14 }}><span>{c.category}</span><span className="spacer" /><span className="num">{money(c.revenueCents)}</span><span className="faint num" style={{ width: 44, textAlign: 'right' }}>{pct(share)}</span></div>
                <div className="bar" style={{ margin: '4px 0' }}><i style={{ width: `${share * 100}%` }} /></div>
                <div className="faint">{ch == null ? 'sem vendas no período anterior' : <span className={ch >= 0 ? 'up' : 'down'}>{ch >= 0 ? '+' : ''}{(ch * 100).toFixed(0)}% vs. anterior</span>}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="faint">{a.notes.margin}</div>
    </>
  );
}
