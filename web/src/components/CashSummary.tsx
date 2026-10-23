import { money } from '../lib/format';

export function CashSummary({ s }: { s: any }) {
  const Row = ({ l, v, strong }: { l: string; v: number | null; strong?: boolean }) => (
    <div className="row" style={{ padding: '6px 0', fontWeight: strong ? 650 : 400 }}><span className={strong ? '' : 'muted'}>{l}</span><span className="spacer" /><span className="num">{money(v)}</span></div>
  );
  return (
    <div className="grid2">
      <div className="card">
        <h3>Vendas (faturamento)</h3>
        {s.salesByMethod.map((m: any) => <Row key={m.code} l={`${m.name} (${m.count})`} v={m.total_cents} />)}
        <Row l="Total vendido" v={s.salesTotalCents} strong />
        {s.cancelledCount > 0 && <div className="faint">{s.cancelledCount} venda(s) cancelada(s): {money(s.cancelledTotalCents)} — não somadas.</div>}
      </div>
      <div className="card">
        <h3>Dinheiro na gaveta</h3>
        <Row l="Valor inicial" v={s.openingFloatCents} />
        <Row l="Vendas em dinheiro" v={s.salesByMethod.filter((m: any) => m.kind === 'CASH').reduce((a: number, m: any) => a + m.total_cents, 0)} />
        <Row l="Recebimentos de fiado em dinheiro" v={s.receiptsByMethod.filter((m: any) => m.kind === 'CASH').reduce((a: number, m: any) => a + m.total_cents, 0)} />
        <Row l="Suprimentos (+)" v={s.suprimentosCents} />
        <Row l="Retiradas (−)" v={s.sangriasCents} />
        <Row l="Esperado no caixa" v={s.expectedCashCents} strong />
        {s.countedCashCents != null && <><Row l="Contado" v={s.countedCashCents} /><Row l="Diferença" v={s.differenceCents} strong /></>}
      </div>
      <div className="card">
        <h3>Recebimentos de fiado</h3>
        {s.receiptsByMethod.map((m: any) => <Row key={m.code} l={`${m.name} (${m.count})`} v={m.total_cents} />)}
        <Row l="Total recebido" v={s.receiptsTotalCents} strong />
        <div className="faint">Recebimentos não contam como venda: a venda foi registrada quando o fiado foi feito.</div>
      </div>
    </div>
  );
}
