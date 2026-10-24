import { useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { useApi, useAction, useDebounced } from '../lib/hooks';
import { money, parseMoney, dateTime, qty } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from '../components/ui';
import { useSession } from '../components/session';

export default function Fiado() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const { data, loading, error, reload } = useApi<any[]>(`/customers?q=${encodeURIComponent(dq)}`);
  const [sel, setSel] = useState<number | null>(null);
  const [onlyDebt, setOnlyDebt] = useState(true);
  const list = (data ?? []).filter((c) => !onlyDebt || c.balance_cents > 0);
  return (
    <div className="stack">
      <div className="page-head"><h1>Fiado</h1></div>
      <div className="row wrap">
        <input className="input lg" style={{ flex: 1, minWidth: 220 }} placeholder="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={onlyDebt} onChange={(e) => setOnlyDebt(e.target.checked)} /> Só quem tem saldo</label>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush">
          {!list.length ? <Empty>Nenhum cliente {onlyDebt ? 'com saldo em aberto' : 'encontrado'}.</Empty> : list.map((c) => (
            <button key={c.id} className="list-item" onClick={() => setSel(c.id)}>
              <span><b>{c.name}</b>{c.phone && <span className="faint"> · {c.phone}</span>}</span><span className="spacer" />
              {c.balance_cents > 0 ? <span className="badge warning num">deve {money(c.balance_cents)}</span> : <span className="badge success">em dia</span>}
            </button>
          ))}
        </div>
      )}
      {sel && <CustomerModal id={sel} onClose={() => { setSel(null); reload(); }} />}
    </div>
  );
}

export function CustomerModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, loading, error, reload } = useApi<any>(`/customers/${id}`);
  const { boot } = useSession();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('DINHEIRO');
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey());
  const toast = useToast();
  const cents = parseMoney(amount);
  const [pay, busy] = useAction(async () => {
    setErr(null);
    try {
      const r = await api(`/customers/${id}/payments`, { body: { idempotencyKey: key.current, amountCents: cents, paymentMethodCode: method } });
      key.current = newKey();
      setAmount('');
      toast(`Recebimento registrado. Saldo restante: ${money(r.balanceCents)}`, 'success');
      reload();
    } catch (e: any) { setErr(e.message); }
  });
  return (
    <Modal wide title={data?.customer.name ?? 'Cliente'} onClose={onClose}>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : data && (
        <>
          <div className="row"><span className="muted">Saldo devedor</span><span className="spacer" /><span className="total-big num">{money(data.balanceCents)}</span></div>
          {data.balanceCents > 0 && (
            <div className="card stack">
              <h3>Registrar pagamento</h3>
              <div className="row wrap">
                {boot?.paymentMethods.filter((m) => m.kind !== 'CREDIT').map((m) => <button key={m.code} className={`chip ${method === m.code ? 'active' : ''}`} onClick={() => setMethod(m.code)}>{m.name}</button>)}
              </div>
              <div className="row wrap">
                <input className="input lg num" style={{ flex: 1, minWidth: 140 }} inputMode="decimal" placeholder="Valor pago" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <button className="btn" onClick={() => setAmount((data.balanceCents / 100).toFixed(2).replace('.', ','))}>Valor total</button>
              </div>
              {cents != null && cents > 0 && cents <= data.balanceCents && <div className="faint">Saldo após o pagamento: {money(data.balanceCents - cents)}</div>}
              {cents != null && cents > data.balanceCents && <div className="error-text">O valor é maior que o saldo devedor.</div>}
              {err && <div className="notice danger">{err}</div>}
              <button className="btn primary lg" disabled={busy || !cents || cents > data.balanceCents} onClick={pay}>{busy ? 'Registrando…' : `Receber ${cents ? money(cents) : ''}`}</button>
            </div>
          )}
          <h3>Compras a prazo</h3>
          {!data.receivables.length ? <Empty>Nenhuma compra a prazo.</Empty> : (
            <table className="table responsive"><thead><tr><th>Data</th><th>Itens</th><th className="r">Valor</th><th className="r">Acréscimo</th><th className="r">Pago</th><th>Situação</th></tr></thead><tbody>
              {data.receivables.map((r: any) => (
                <tr key={r.id}>
                  <td data-label="Data">{dateTime(r.created_at)}</td>
                  <td data-label="Itens" className="faint">{r.items.map((i: any) => `${qty(i.qty_milli, i.unit)} ${i.product_name}`).join(', ')}</td>
                  <td data-label="Valor" className="r num">{money(r.total_cents)}</td>
                  <td data-label="Acréscimo" className="r num">{money(r.surcharge_cents)}</td>
                  <td data-label="Pago" className="r num">{money(r.paid_cents)}</td>
                  <td data-label="Situação">{r.status === 'PAID' ? <span className="badge success">quitado</span> : r.status === 'CANCELLED' ? <span className="badge">cancelado</span> : <span className="badge warning">em aberto</span>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
          <h3>Pagamentos</h3>
          {!data.payments.length ? <Empty>Nenhum pagamento registrado.</Empty> : (
            <table className="table responsive"><thead><tr><th>Data</th><th>Forma</th><th>Recebido por</th><th className="r">Valor</th></tr></thead><tbody>
              {data.payments.map((p: any) => <tr key={p.id}><td data-label="Data">{dateTime(p.at)}</td><td data-label="Forma">{p.payment_method}</td><td data-label="Recebido por">{p.user_name}</td><td data-label="Valor" className="r num">{money(p.amount_cents)}</td></tr>)}
            </tbody></table>
          )}
        </>
      )}
    </Modal>
  );
}
