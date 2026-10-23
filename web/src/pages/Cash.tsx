import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, useAction } from '../lib/hooks';
import { money, parseMoney, dateTime } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from '../components/ui';
import { CashSummary } from '../components/CashSummary';
import { SaleModal } from '../components/CancelSale';

export default function Cash() {
  const { data: reg, loading, error, reload } = useApi<any>('/cash/current');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && reg === null) return <Loading />;
  return reg ? <OpenRegister reg={reg} reload={reload} /> : <OpenForm onOpened={reload} />;
}

function OpenForm({ onOpened }: { onOpened: () => void }) {
  const [code, setCode] = useState('');
  const [float, setFloat] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const cents = float.trim() === '' ? 0 : parseMoney(float);
  const toast = useToast();
  const [open, busy] = useAction(async () => {
    setErr(null);
    try { await api('/cash/open', { body: { code, openingFloatCents: cents } }); toast('Caixa aberto.', 'success'); onOpened(); } catch (e: any) { setErr(e.message); }
  });
  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '24px auto' }}>
      <h1>Abrir caixa</h1>
      <Field label="Dinheiro inicial na gaveta" hint="Deixe em branco se começar sem troco."><input className="input lg num" inputMode="decimal" placeholder="0,00" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
      <Field label="Código do caixa"><input className="input lg" type="password" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open()} /></Field>
      {cents == null && <div className="error-text">Valor inválido.</div>}
      {err && <div className="notice danger">{err}</div>}
      <button className="btn primary lg" disabled={busy || !code || cents == null} onClick={open}>{busy ? 'Abrindo…' : 'Abrir caixa'}</button>
    </div>
  );
}

function OpenRegister({ reg, reload }: { reg: any; reload: () => void }) {
  const [mov, setMov] = useState<'SUPRIMENTO' | 'SANGRIA' | null>(null);
  const [closing, setClosing] = useState(false);
  const sales = useApi<any[]>('/sales');
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Caixa aberto</h1><div className="faint">Aberto por {reg.openedByName} em {dateTime(reg.openedAt)}</div></div>
        <span className="spacer" />
        <button className="btn" onClick={() => setMov('SUPRIMENTO')}>Suprimento</button>
        <button className="btn" onClick={() => setMov('SANGRIA')}>Retirada</button>
        <button className="btn primary" onClick={() => setClosing(true)}>Fechar caixa</button>
      </div>
      <CashSummary s={reg} />
      <div className="card flush">
        <div style={{ padding: '14px 16px' }}><h2>Vendas deste caixa</h2><div className="faint">Toque em uma venda para ver os itens ou cancelar.</div></div>
        {sales.loading && !sales.data ? <Loading /> : !sales.data?.length ? <Empty>Nenhuma venda ainda.</Empty> : (
          <table className="table responsive"><thead><tr><th>Nº</th><th>Hora</th><th>Forma</th><th>Origem</th><th className="r">Total</th></tr></thead><tbody>
            {sales.data.map((s) => (
              <tr key={s.id} className="click" onClick={() => setSel(s.id)}><td data-label="Nº">{s.id}</td><td data-label="Hora">{dateTime(s.created_at)}</td><td data-label="Forma">{s.payment_method}{s.customer_name ? ` · ${s.customer_name}` : ''}</td>
                <td data-label="Origem">{s.tab_label ?? 'Balcão'}</td><td data-label="Total" className="r num">{s.status === 'CANCELLED' ? <span className="badge danger">cancelada</span> : money(s.total_cents)}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>
      {sel && <SaleModal id={sel} onClose={() => setSel(null)} onChanged={() => { sales.reload(); reload(); }} />}
      {mov && <MovementModal type={mov} onClose={() => setMov(null)} onDone={() => { setMov(null); reload(); }} />}
      {closing && <CloseModal reg={reg} onClose={() => setClosing(false)} onDone={reload} />}
    </div>
  );
}

function MovementModal({ type, onClose, onDone }: { type: 'SUPRIMENTO' | 'SANGRIA'; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState('');
  const [reason, setReason] = useState('');
  const cents = parseMoney(v);
  const toast = useToast();
  const [run, busy] = useAction(async () => {
    try { await api('/cash/movements', { body: { type, amountCents: cents, reason: reason || undefined } }); toast('Registrado.', 'success'); onDone(); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title={type === 'SUPRIMENTO' ? 'Suprimento (colocar dinheiro)' : 'Retirada (tirar dinheiro)'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !cents} onClick={run}>Registrar</button></>}>
      <Field label="Valor"><input className="input lg num" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></Field>
      <Field label="Motivo (opcional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

function CloseModal({ reg, onClose, onDone }: { reg: any; onClose: () => void; onDone: () => void }) {
  const [counted, setCounted] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const cents = parseMoney(counted);
  const diff = cents == null ? null : cents - reg.expectedCashCents;
  const [close, busy] = useAction(async () => {
    setErr(null);
    try { setResult(await api(`/cash/${reg.registerId}/close`, { body: { code, countedCashCents: cents } })); } catch (e: any) { setErr(e.message); }
  });
  if (result) {
    return (
      <Modal wide title="Caixa fechado" onClose={onDone} footer={<button className="btn primary" onClick={onDone}>Concluir</button>}>
        <div className={`notice ${result.differenceCents === 0 ? 'success' : 'warning'}`}>Fechamento registrado. Diferença: {money(result.differenceCents)}.</div>
        <CashSummary s={result} />
      </Modal>
    );
  }
  return (
    <Modal wide title="Fechar caixa" onClose={() => !busy && onClose()} footer={step === 1
      ? <><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={cents == null} onClick={() => setStep(2)}>Conferir</button></>
      : <><button className="btn" onClick={() => setStep(1)} disabled={busy}>Voltar</button><button className="btn primary" disabled={busy || !code} onClick={close}>{busy ? 'Fechando…' : 'Confirmar fechamento'}</button></>}>
      {step === 1 ? (
        <Field label="Quanto dinheiro há na gaveta agora?" hint="Conte as notas e moedas e informe o total."><input className="input lg num" inputMode="decimal" placeholder="0,00" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>
      ) : (
        <>
          <CashSummary s={{ ...reg, countedCashCents: cents, differenceCents: diff }} />
          {diff !== 0 && <div className="notice warning">{diff! > 0 ? `Sobram ${money(diff)}` : `Faltam ${money(-diff!)}`} em relação ao esperado. Confira antes de confirmar.</div>}
          <Field label="Código do caixa"><input className="input lg" type="password" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
          {err && <div className="notice danger">{err}</div>}
        </>
      )}
    </Modal>
  );
}
