import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, newKey } from '../lib/api';
import { useApi, useAction } from '../lib/hooks';
import { money, qty, dateTime } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from '../components/ui';
import { ProductPicker, CheckoutModal, CheckoutResult, Product, surchargeUnits } from '../components/pos';
import { RegisterGate } from '../components/RegisterGate';

export function TabsList() {
  const { data, loading, error, reload } = useApi<any[]>('/tabs');
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [people, setPeople] = useState('');
  const nav = useNavigate();
  const toast = useToast();
  const [create, busy] = useAction(async () => {
    try {
      const t = await api('/tabs', { body: { label, people: people.split(',').map((s) => s.trim()).filter(Boolean) } });
      nav(`/mesas/${t.id}`);
    } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <div>
      <div className="page-head"><h1>Mesas</h1><span className="spacer" /><button className="btn primary lg" onClick={() => setOpen(true)}>Abrir mesa</button></div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <div className="card"><Empty>Nenhuma mesa aberta.</Empty></div> : (
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {data.map((t) => (
            <Link key={t.id} to={`/mesas/${t.id}`} className="tile" style={{ color: 'inherit' }}>
              <span className="name" style={{ fontSize: 18 }}>{t.label}</span>
              <span className="faint">{t.people_count} {t.people_count === 1 ? 'pessoa' : 'pessoas'} · desde {dateTime(t.opened_at)}</span>
              <span className="price num">{money(t.pending_cents)} <span className="faint">em aberto</span></span>
            </Link>
          ))}
        </div>
      )}
      {open && (
        <Modal title="Abrir mesa" onClose={() => setOpen(false)} footer={<><button className="btn" onClick={() => setOpen(false)}>Cancelar</button><button className="btn primary" disabled={busy || !label.trim()} onClick={create}>Abrir</button></>}>
          <Field label="Mesa ou identificação"><input className="input lg" placeholder="Ex.: Mesa 04" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus /></Field>
          <Field label="Pessoas (opcional)" hint="Separe os nomes por vírgula. Também é possível adicionar depois."><input className="input" placeholder="Paula, Rodrigo, Bruno" value={people} onChange={(e) => setPeople(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  );
}

export function TabDetail() {
  return <RegisterGate><TabDetailInner /></RegisterGate>;
}

function TabDetailInner() {
  const id = Number(useParams().id);
  const { data: tab, loading, error, reload, setData } = useApi<any>(`/tabs/${id}`);
  const [active, setActive] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [newPerson, setNewPerson] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ personId: number | null; label: string; total: number } | null>(null);
  const [voiding, setVoiding] = useState<any>(null);
  const [closeErr, setCloseErr] = useState<string | null>(null);
  const key = useRef(newKey());
  const toast = useToast();
  const nav = useNavigate();

  const [addItem] = useAction(async (p: Product, m: number) => {
    if (!active) return;
    try {
      setData(await api(`/tabs/${id}/items`, { body: { personId: active, items: [{ productId: p.id, qtyMilli: m }] } }));
      toast(`${qty(m, p.unit)} ${p.name} → ${tab.people.find((x: any) => x.id === active)?.name}`, 'success');
    } catch (e: any) { toast(e.message, 'error'); }
  });
  const [addPerson, addingPerson] = useAction(async () => {
    try {
      const t = await api(`/tabs/${id}/people`, { body: { name: newPerson } });
      setData(t); setActive(t.people[t.people.length - 1].id); setNewPerson(null);
    } catch (e: any) { toast(e.message, 'error'); }
  });
  const [closeBill, closingBusy] = useAction(async (r: CheckoutResult) => {
    setCloseErr(null);
    try {
      const res = await api(`/tabs/${id}/close`, { body: { idempotencyKey: key.current, personId: closing!.personId, ...r } });
      setData(res.tab); setClosing(null);
      toast(`Conta paga: ${money(res.sale.total_cents)}${res.sale.change_cents ? ` · troco ${money(res.sale.change_cents)}` : ''}`, 'success');
      if (res.tab.status !== 'OPEN') nav('/mesas');
    } catch (e: any) { setCloseErr(e.message); }
  });
  const [finish] = useAction(async () => {
    try { await api(`/tabs/${id}/finish`, { body: {} }); nav('/mesas'); } catch (e: any) { toast(e.message, 'error'); }
  });

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !tab) return <Loading />;
  if (!tab) return null;
  if (tab.status !== 'OPEN') return <div className="card stack"><h2>{tab.label}</h2><p className="muted">Esta mesa já foi encerrada.</p><Link to="/mesas" className="btn">Voltar às mesas</Link></div>;
  const person = tab.people.find((p: any) => p.id === active);
  const startClose = (personId: number | null, label: string, total: number) => { key.current = newKey(); setCloseErr(null); setClosing({ personId, label, total }); };

  return (
    <div className="stack">
      <div className="page-head">
        <Link to="/mesas" className="btn ghost sm">← Mesas</Link>
        <h1>{tab.label}</h1>
        <span className="spacer" />
        <span className="muted num">Em aberto: <b>{money(tab.pending_cents)}</b></span>
        {tab.pending_cents > 0
          ? <button className="btn primary" onClick={() => startClose(null, `Fechar ${tab.label} inteira`, tab.pending_cents)}>Fechar mesa inteira</button>
          : <button className="btn" onClick={finish}>Encerrar mesa</button>}
      </div>

      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {tab.people.map((p: any) => (
          <div key={p.id} className="card stack" style={{ borderColor: active === p.id ? 'var(--accent)' : undefined, borderWidth: active === p.id ? 2 : 1 }}>
            <div className="row"><h2>{p.name}</h2><span className="spacer" /><b className="num">{money(p.pending_cents)}</b></div>
            {p.items.length === 0 ? <span className="faint">Nada consumido ainda.</span> : (
              <div className="stack" style={{ gap: 4 }}>
                {p.items.map((i: any) => (
                  <div key={i.id} className="row" style={{ fontSize: 14, opacity: i.status === 'PENDING' ? 1 : 0.55 }}>
                    <span style={{ textDecoration: i.status === 'VOIDED' ? 'line-through' : undefined }}>{qty(i.qty_milli, i.unit)} {i.product_name}</span>
                    <span className="spacer" />
                    {i.status === 'PAID' && <span className="badge success">pago</span>}
                    {i.status === 'VOIDED' && <span className="badge" title={i.void_reason}>corrigido</span>}
                    <span className="num">{money(i.total_cents)}</span>
                    {i.status === 'PENDING' && <button className="btn ghost sm" aria-label={`Corrigir ${i.product_name}`} onClick={() => setVoiding(i)}>Corrigir</button>}
                  </div>
                ))}
              </div>
            )}
            <div className="row wrap">
              <button className={`btn ${active === p.id ? 'primary' : ''}`} onClick={() => { setActive(p.id); setAdding(true); }}>Lançar para {p.name}</button>
              {p.pending_cents > 0 && <button className="btn" onClick={() => startClose(p.id, `Conta de ${p.name}`, p.pending_cents)}>Fechar conta</button>}
            </div>
          </div>
        ))}
        <button className="card tile" style={{ alignItems: 'center', justifyContent: 'center' }} onClick={() => setNewPerson('')}><b>+ Adicionar pessoa</b></button>
      </div>

      {adding && person && (
        <Modal wide title={`Lançar para ${person.name}`} onClose={() => setAdding(false)} footer={<button className="btn primary" onClick={() => setAdding(false)}>Concluir</button>}>
          <div className="row wrap">{tab.people.map((p: any) => <button key={p.id} className={`chip ${p.id === active ? 'active' : ''}`} onClick={() => setActive(p.id)}>{p.name}</button>)}</div>
          <ProductPicker onPick={addItem} />
        </Modal>
      )}
      {newPerson !== null && (
        <Modal title="Adicionar pessoa" onClose={() => setNewPerson(null)} footer={<button className="btn primary" disabled={addingPerson || !newPerson.trim()} onClick={addPerson}>Adicionar</button>}>
          <Field label="Nome"><input className="input lg" value={newPerson} onChange={(e) => setNewPerson(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPerson()} autoFocus /></Field>
        </Modal>
      )}
      {voiding && <VoidModal item={voiding} onClose={() => setVoiding(null)} onDone={(t) => { setData(t); setVoiding(null); }} tabId={id} />}
      {closing && <CheckoutModal title={closing.label} subtotalCents={closing.total} units={surchargeUnits(tab.people.filter((p: any) => closing.personId == null || p.id === closing.personId).flatMap((p: any) => p.items).filter((i: any) => i.status === 'PENDING').map((i: any) => ({ unit: i.unit, qtyMilli: i.qty_milli })))} busy={closingBusy} error={closeErr} onClose={() => !closingBusy && setClosing(null)} onConfirm={closeBill} />}
    </div>
  );
}

function VoidModal({ item, tabId, onClose, onDone }: { item: any; tabId: number; onClose: () => void; onDone: (t: any) => void }) {
  const [reason, setReason] = useState('');
  const toast = useToast();
  const [run, busy] = useAction(async () => {
    try { onDone(await api(`/tabs/${tabId}/items/${item.id}/void`, { body: { reason } })); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title="Corrigir lançamento" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Voltar</button><button className="btn primary" disabled={busy || reason.trim().length < 3} onClick={run}>Retirar item</button></>}>
      <p style={{ margin: 0 }}>{qty(item.qty_milli, item.unit)} {item.product_name} — {money(item.total_cents)}</p>
      <p className="faint" style={{ margin: 0 }}>O item sai da conta, mas fica registrado no histórico com o motivo.</p>
      <Field label="Motivo"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: lançado na pessoa errada" autoFocus /></Field>
    </Modal>
  );
}
