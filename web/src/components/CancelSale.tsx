import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, useAction } from '../lib/hooks';
import { money, qty, dateTime } from '../lib/format';
import { Modal, Loading, Field, useToast } from './ui';

/** Detalhe da venda com cancelamento autorizado pelo código único de cancelamento. */
export function SaleModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { data: s, loading, setData } = useApi<any>(`/sales/${id}`);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const [cancel, busy] = useAction(async () => {
    setErr(null);
    try {
      setData(await api(`/sales/${id}/cancel`, { body: { reason, code } }));
      onChanged();
      toast(s.tab_id ? 'Venda cancelada. Os itens voltaram para a mesa.' : 'Venda cancelada.', 'success');
    } catch (e: any) { setErr(e.message); }
  });
  return (
    <Modal wide title={`Venda nº ${id}`} onClose={onClose}>
      {loading && !s ? <Loading /> : s && <>
        <div className="row wrap"><span>{dateTime(s.created_at)} · {s.user_name} · {s.payment_method}{s.customer_name ? ` · ${s.customer_name}` : ''}</span><span className="spacer" />{s.status === 'CANCELLED' && <span className="badge danger">cancelada</span>}</div>
        <table className="table"><tbody>
          {s.items.map((i: any) => <tr key={i.id}><td>{qty(i.qty_milli, i.unit)} {i.product_name}</td><td className="r num">{money(i.total_cents)}</td></tr>)}
          {s.surcharge_cents > 0 && <tr><td>Acréscimo</td><td className="r num">{money(s.surcharge_cents)}</td></tr>}
          <tr><td><b>Total</b></td><td className="r num"><b>{money(s.total_cents)}</b></td></tr>
          {s.received_cents != null && <tr><td className="muted">Recebido / troco</td><td className="r num">{money(s.received_cents)} / {money(s.change_cents)}</td></tr>}
        </tbody></table>
        {s.status === 'CANCELLED' ? <div className="notice">Cancelada em {dateTime(s.cancelled_at)}: {s.cancel_reason}</div> : (
          <div className="card stack">
            <h3>Cancelar esta venda</h3>
            <div className="faint">O estoque volta{s.tab_id ? ' e os itens voltam a ficar em aberto na mesa para serem cobrados de novo' : ''}. A venda fica registrada como cancelada.</div>
            <Field label="Motivo"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s.tab_id ? 'Ex.: fechou a conta errada' : 'Ex.: produto lançado errado'} /></Field>
            <Field label="Código de cancelamento"><input className="input" type="password" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            {err && <div className="notice danger">{err}</div>}
            <button className="btn danger" disabled={busy || reason.trim().length < 3 || !code} onClick={cancel}>{busy ? 'Cancelando…' : 'Cancelar venda'}</button>
          </div>
        )}
      </>}
    </Modal>
  );
}
