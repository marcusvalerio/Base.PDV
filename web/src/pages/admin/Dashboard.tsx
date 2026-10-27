import { Link } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { useSession } from '../../components/session';
import { money, pct, qty, date } from '../../lib/format';
import { Loading, ErrorState, Empty, Metric, Change } from '../../components/ui';
import { OpenRegisters } from './Admin';

export default function Dashboard() {
  const { data: d, loading, error, reload } = useApi<any>('/dashboard');
  const { boot } = useSession();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  if (!d) return null;
  const t = d.today;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head"><h1>Painel</h1><span className="spacer" /><button className="btn sm" onClick={reload}>Atualizar</button></div>
      <div className="metrics">
        <Metric label="Faturamento hoje" value={money(t.totalRevenueCents)} sub={<Change v={d.todayChangePct} />} />
        <Metric label="Vendas hoje" value={t.salesCount} sub={t.salesCount ? `Ticket médio ${money(t.avgTicketCents)}` : 'Nenhuma venda ainda'} />
        <Metric label="Margem bruta hoje" value={t.grossMarginPct == null ? '—' : pct(t.grossMarginPct)} sub={t.costCoverage == null ? 'Sem vendas' : t.costCoverage < 1 ? `Estimativa: ${pct(t.costCoverage)} do faturamento tem custo` : 'Todos os itens com custo'} />
        <Metric label="Fiado pendente" value={money(d.fiado.pendingCents)} sub={`${d.fiado.customers} cliente(s)`} />
        <Metric label="Caixas abertos" value={d.openRegisters.length} sub={d.openRegisters.length ? d.openRegisters.map((r: any) => r.openedByName).join(', ') : 'Nenhum caixa aberto'} />
      </div>
      <StatusStrip d={d} />
      <OpenRegisters />
      <div className="grid2">
        <div className="card flush">
          <div className="row" style={{ padding: '14px 16px' }}><h2>Mais vendidos (7 dias)</h2><span className="spacer" />{boot?.modules.analise && <Link to="/admin/analise">Ver análise</Link>}</div>
          {!d.topProducts.length ? <Empty>Sem vendas nos últimos 7 dias.</Empty> : d.topProducts.map((p: any) => (
            <div key={p.productId} className="list-item" style={{ cursor: 'default' }}><span>{p.name}<div className="faint">{p.category}</div></span><span className="spacer" /><span className="num">{qty(p.qtyMilli, p.unit)}</span></div>
          ))}
        </div>
        <div className="card flush">
          <div className="row" style={{ padding: '14px 16px' }}><h2>Estoque baixo</h2><span className="spacer" />{boot?.modules.reposicao && <Link to="/admin/reposicao">Reposição</Link>}</div>
          {!d.lowStock.length ? <Empty>Nenhum produto abaixo do mínimo.</Empty> : d.lowStock.slice(0, 8).map((p: any) => (
            <div key={p.id} className="list-item" style={{ cursor: 'default' }}><span>{p.name}<div className="faint">mínimo {qty(p.min_stock_milli, p.unit)}</div></span><span className="spacer" /><span className={`badge ${p.stock_milli <= 0 ? 'danger' : 'warning'} num`}>{qty(p.stock_milli, p.unit)}</span></div>
          ))}
        </div>
        <div className="card flush">
          <div style={{ padding: '14px 16px' }}><h2>Validade próxima</h2></div>
          {!d.expiring.length ? <Empty>Nenhum lote vencendo em breve.<br /><span className="faint">Registre a validade nas entradas de estoque.</span></Empty> : d.expiring.slice(0, 8).map((l: any) => (
            <div key={l.id} className="list-item" style={{ cursor: 'default' }}><span>{l.name}<div className="faint">lote de {qty(l.qty_milli, l.unit)}</div></span><span className="spacer" /><span className={`badge ${l.expired ? 'danger' : 'warning'}`}>{l.expired ? 'venceu ' : 'vence '}{date(l.expiry_date)}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Faixa de sinalização: vermelho = problema, amarelo = atenção, verde = em dia. */
function StatusStrip({ d }: { d: any }) {
  const zero = d.lowStock.filter((p: any) => p.stock_milli <= 0).length;
  const low = d.lowStock.length - zero;
  const expired = d.expiring.filter((l: any) => l.expired).length;
  const soon = d.expiring.length - expired;
  const items: [string, string][] = [
    zero ? ['danger', `${zero} sem estoque`] : low ? ['warning', `${low} abaixo do mínimo`] : ['success', 'Estoque em dia'],
    ...(zero && low ? [['warning', `${low} abaixo do mínimo`] as [string, string]] : []),
    expired ? ['danger', `${expired} lote(s) vencido(s)`] : soon ? ['warning', `${soon} lote(s) vencendo`] : ['success', 'Validades em dia'],
    d.fiado.pendingCents > 0 ? ['warning', `Fiado a receber ${money(d.fiado.pendingCents)}`] : ['success', 'Fiado em dia'],
  ];
  return <div className="status-strip">{items.map(([c, t]) => <span key={t} className={`badge lg ${c}`}>{t}</span>)}</div>;
}
