import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi, useAction } from '../../lib/hooks';
import { qty, parseQty, date, UNIT_LABEL, Unit } from '../../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, Segmented, useToast } from '../../components/ui';
import { Movements, MOV_LABEL } from './Products';
import { useSession } from '../../components/session';
import { useDebounced } from '../../lib/hooks';
import { PRESETS } from '../../components/PeriodFilter';
import { downloadCsv, csvDate, csvQty } from '../../lib/csv';

export default function Stock() {
  const [tab, setTab] = useState<'alerts' | 'moves'>('alerts');
  return (
    <div className="stack">
      <div className="page-head"><h1>Estoque</h1></div>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'alerts', label: 'Alertas' }, { value: 'moves', label: 'Movimentações' }]} />
      {tab === 'alerts' && <Alerts />}
      {tab === 'moves' && <Moves />}
    </div>
  );
}

function Alerts() {
  const { data, loading, error, reload } = useApi<any>('/stock/alerts');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="grid2">
      <div className="card flush"><div style={{ padding: '14px 16px' }}><h2>Abaixo do mínimo</h2></div>
        {!data.lowStock.length ? <Empty>Tudo acima do mínimo.</Empty> : data.lowStock.map((p: any) => (
          <div key={p.id} className="list-item" style={{ cursor: 'default' }}><span>{p.name}<div className="faint">{p.category} · mínimo {qty(p.min_stock_milli, p.unit)}</div></span><span className="spacer" /><span className={`badge ${p.stock_milli <= 0 ? 'danger' : 'warning'} num`}>{qty(p.stock_milli, p.unit)}</span></div>
        ))}
      </div>
      <div className="card flush"><div style={{ padding: '14px 16px' }}><h2>Validade próxima ou vencida</h2></div>
        {!data.expiring.length ? <Empty>Nenhum lote na janela de alerta.</Empty> : data.expiring.map((l: any) => (
          <div key={l.id} className="list-item" style={{ cursor: 'default' }}><span>{l.name}<div className="faint">lote de {qty(l.qty_milli, l.unit)} · estoque {qty(l.stock_milli, l.unit)}</div></span><span className="spacer" /><span className={`badge ${l.expired ? 'danger' : 'warning'}`}>{l.expired ? 'vencido' : 'vence'} {date(l.expiry_date)}</span></div>
        ))}
        <div className="faint" style={{ padding: '0 16px 12px' }}>Os lotes não são baixados individualmente; confira fisicamente e registre perdas quando necessário.</div>
      </div>
    </div>
  );
}

const EMPTY_F = { q: '', userId: '', type: '', categoryId: '', preset: 'all', from: '', to: '' };

function Moves() {
  const { boot } = useSession();
  const users = useApi<any[]>('/users');
  const [f, setF] = useState(EMPTY_F);
  const q = useDebounced(f.q, 300);
  const params = new URLSearchParams(Object.entries({ ...f, q }).filter(([k, v]) => v && !(k === 'preset' && v === 'all') && !((k === 'from' || k === 'to') && f.preset !== 'custom')) as [string, string][]);
  const ready = f.preset !== 'custom' || (f.from && f.to);
  const { data, loading, error, reload } = useApi<any[]>(ready ? `/stock/movements?${params}` : null);
  const [adj, setAdj] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY_F);
  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 10 }}>
        <Segmented value={f.preset} onChange={(preset) => setF({ ...f, preset })} options={[{ value: 'all', label: 'Tudo' }, ...PRESETS]} />
        <div className="filters">
          {f.preset === 'custom' && <>
            <input className="input" type="date" value={f.from} onChange={set('from')} aria-label="Data inicial" />
            <input className="input" type="date" value={f.to} onChange={set('to')} aria-label="Data final" />
          </>}
          <input className="input" placeholder="Buscar produto" value={f.q} onChange={set('q')} aria-label="Buscar produto" />
          <select className="input" value={f.userId} onChange={set('userId')} aria-label="Quem fez">
            <option value="">Todas as pessoas</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select className="input" value={f.type} onChange={set('type')} aria-label="Tipo">
            <option value="">Todos os tipos</option>
            {Object.entries(MOV_LABEL).map(([k, l]) => <option key={k} value={k}>{l as string}</option>)}
          </select>
          <select className="input" value={f.categoryId} onChange={set('categoryId')} aria-label="Categoria">
            <option value="">Todas as categorias</option>
            {boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="row wrap">
          <span className="faint">{data ? `${data.length}${data.length >= 300 ? '+' : ''} movimentação(ões)` : ''}</span>
          {active && <button className="btn ghost sm" onClick={() => setF(EMPTY_F)}>Limpar filtros</button>}
          <span className="spacer" />{!!data?.length && <button className="btn" onClick={() => downloadCsv('movimentacoes-estoque', data, [['Data', (m) => csvDate(m.at)], ['Produto', (m) => m.product_name], ['Tipo', (m) => MOV_LABEL[m.type]], ['Quantidade', (m) => csvQty(m.qty_milli)], ['Saldo depois', (m) => csvQty(m.balance_after_milli)], ['Unidade', (m) => m.unit], ['Usuário', (m) => m.user_name], ['Motivo', (m) => m.reason]])}>Exportar planilha</button>}<button className="btn" onClick={() => setAdj(true)}>Registrar ajuste ou perda</button>
        </div>
      </div>
      {!ready ? <div className="faint">Escolha as duas datas.</div> : error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : <div className="card flush"><Movements rows={data ?? []} showProduct /></div>}
      {adj && <AdjustModal onClose={() => setAdj(false)} onDone={() => { setAdj(false); reload(); }} />}
    </div>
  );
}

function AdjustModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const products = useApi<any[]>('/products?all=1');
  const [pid, setPid] = useState('');
  const [type, setType] = useState<'LOSS' | 'ADJUST'>('LOSS');
  const [dir, setDir] = useState<'-' | '+'>('-');
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const toast = useToast();
  const p = products.data?.find((x) => String(x.id) === pid);
  const m = p ? parseQty(q, p.unit) : null;
  const signed = m == null ? null : type === 'LOSS' || dir === '-' ? -m : m;
  const [save, busy] = useAction(async () => {
    try { await api('/stock/adjustments', { body: { productId: Number(pid), qtyMilli: signed, type, reason } }); toast('Registrado.', 'success'); onDone(); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title="Ajuste de estoque" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!signed || reason.trim().length < 3 || busy} onClick={save}>Registrar</button></>}>
      <Field label="Produto"><select className="input" value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Selecione…</option>{products.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <Segmented value={type} onChange={setType} options={[{ value: 'LOSS', label: 'Perda / baixa' }, { value: 'ADJUST', label: 'Ajuste' }]} />
      {type === 'ADJUST' && <Segmented value={dir} onChange={setDir} options={[{ value: '-', label: 'Retirar' }, { value: '+', label: 'Acrescentar' }]} />}
      <Field label={`Quantidade${p ? ` (${UNIT_LABEL[p.unit as Unit]})` : ''}`} hint={p ? `Estoque atual: ${qty(p.stock_milli, p.unit)}` : undefined}><input className="input num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      <Field label="Motivo"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: garrafa quebrada, vencido" /></Field>
    </Modal>
  );
}

