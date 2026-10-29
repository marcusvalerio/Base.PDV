import { useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { useApi, useAction, useDebounced } from '../lib/hooks';
import { money, parseMoney, dateTime, qty } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from '../components/ui';
import { useSession } from '../components/session';
import { ShareButtons, waPhone } from '../components/ShareButtons';

export default function Fiado() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const { data, loading, error, reload } = useApi<any[]>(`/customers?q=${encodeURIComponent(dq)}`);
  const [sel, setSel] = useState<number | null>(null);
  const [remind, setRemind] = useState<any>(null);
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
            <div key={c.id} className="list-item" role="button" tabIndex={0} onClick={() => setSel(c.id)} onKeyDown={(e) => e.key === 'Enter' && setSel(c.id)}>
              <span><b>{c.name}</b>{c.phone && <span className="faint"> · {c.phone}</span>}
                {c.balance_cents > 0 && <div className="faint">em aberto há {daysSince(c.oldest_open_at)} dia(s)</div>}</span>
              <span className="spacer" />
              {c.balance_cents > 0 ? <span className={`badge ${daysSince(c.oldest_open_at) > 30 ? 'danger' : 'warning'} num`}>deve {money(c.balance_cents)}</span> : <span className="badge success">em dia</span>}
              {c.balance_cents > 0 && <button className="btn sm wa-btn" onClick={(e) => { e.stopPropagation(); setRemind(c); }}>Cobrar</button>}
            </div>
          ))}
        </div>
      )}
      {sel && <CustomerModal id={sel} onClose={() => { setSel(null); reload(); }} />}
      {remind && <ReminderModal c={remind} onClose={() => setRemind(null)} />}
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
  const [statement, setStatement] = useState(false);
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
          <button className="btn lg" onClick={() => setStatement(true)}>Gerar extrato para enviar</button>
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
      {statement && data && <StatementModal data={data} onClose={() => setStatement(false)} />}
    </Modal>
  );
}

const TZ = 'America/Sao_Paulo';
const dmy = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(iso));

/** Monta o texto do extrato (formatação do WhatsApp: *negrito*). */
export function statementText(data: any, storeName: string, scope: 'open' | 'all') {
  const recs = (data.receivables as any[]).filter((r) => r.status !== 'CANCELLED' && (scope === 'all' || r.status === 'OPEN')).slice().reverse();
  const pays = scope === 'all' ? (data.payments as any[]).slice().reverse() : [];
  const lines: string[] = [];
  lines.push(`*${storeName || 'Extrato de fiado'}*`);
  lines.push(`Extrato de fiado — ${data.customer.name}`);
  lines.push(`Gerado em ${new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date())}`);
  lines.push('');
  lines.push(scope === 'all' ? '*Compras a prazo*' : '*Compras em aberto*');
  if (!recs.length) lines.push('Nenhuma.');
  for (const r of recs) {
    const items = r.items.map((i: any) => `${qty(i.qty_milli, i.unit)} ${i.product_name}`).join(', ');
    const open = r.total_cents - r.paid_cents;
    const extra = r.status === 'PAID' ? ' (quitado)' : r.paid_cents > 0 ? ` (pago ${money(r.paid_cents)}, falta ${money(open)})` : '';
    lines.push(`• ${dmy(r.created_at)} — ${items} — ${money(r.total_cents)}${extra}`);
  }
  if (pays.length) {
    lines.push('');
    lines.push('*Pagamentos*');
    for (const p of pays) lines.push(`• ${dmy(p.at)} — ${p.payment_method} — ${money(p.amount_cents)}`);
  }
  lines.push('');
  lines.push(`*Saldo devedor: ${money(data.balanceCents)}*`);
  return lines.join('\n');
}

function StatementModal({ data, onClose }: { data: any; onClose: () => void }) {
  const { boot } = useSession();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const text = statementText(data, boot?.storeName ?? '', scope);
  return (
    <Modal title={`Extrato — ${data.customer.name}`} onClose={onClose}>
      <div className="row wrap">
        <button className={`chip ${scope === 'open' ? 'active' : ''}`} onClick={() => setScope('open')}>Só o que está em aberto</button>
        <button className={`chip ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>Tudo (com pagamentos)</button>
      </div>
      <pre className="statement">{text.replace(/\*/g, '')}</pre>
      <ShareButtons title={`Extrato — ${data.customer.name}`} text={text} phone={data.customer.phone} />
      {!waPhone(data.customer.phone) && <div className="faint">Cadastre o celular do cliente (Administração → Clientes) para enviar direto para ele. Sem número, o WhatsApp abre para você escolher o contato.</div>}
    </Modal>
  );
}

const daysSince = (iso?: string | null) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : 0);

/** Lembrete curto de cobrança (formatação do WhatsApp). */
export function reminderText(c: any, storeName: string) {
  const first = String(c.name).split(' ')[0];
  return `Olá, ${first}! Tudo bem? Aqui é do *${storeName || 'nosso estabelecimento'}*.\nPassando para lembrar do seu fiado em aberto: *${money(c.balance_cents)}*.\nQuando puder, é só acertar com a gente (dinheiro, Pix ou cartão). Obrigado!`;
}

function ReminderModal({ c, onClose }: { c: any; onClose: () => void }) {
  const { boot } = useSession();
  const text = reminderText(c, boot?.storeName ?? '');
  return (
    <Modal title={`Cobrar ${c.name}`} onClose={onClose}>
      <pre className="statement">{text.replace(/\*/g, '')}</pre>
      <ShareButtons title="Lembrete de fiado" text={text} phone={c.phone} />
      <div className="faint">Para mandar o detalhe das compras, abra o cliente e use "Gerar extrato".</div>
    </Modal>
  );
}
