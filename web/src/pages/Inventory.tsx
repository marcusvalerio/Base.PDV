import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApi, useAction } from '../lib/hooks';
import { money, pct, qty, parseQty, dateTime, isFractional, Unit } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, Segmented, Metric, useToast } from '../components/ui';
import { useSession } from '../components/session';
import { useHidScanner, CameraButton } from '../components/scanner';

const SCOPE: Record<string, string> = { FULL: 'Geral', CATEGORY: 'Por categoria', PARTIAL: 'Parcial' };
/** Cor pela meta do administrador; sem meta, cor neutra. */
const accClass = (v: number | null, target: number | null) => (v == null || target == null ? '' : v * 100 >= target ? 'success' : v * 100 >= target - 5 ? 'warning' : 'danger');
const useTarget = () => useApi<{ targetPct: number | null }>('/inventory-target').data?.targetPct ?? null;
function MetaText({ v, target }: { v: number | null; target: number | null }) {
  if (target == null) return <>Meta não definida (Configurações)</>;
  if (v == null) return <>Meta: {String(target).replace('.', ',')}%</>;
  const d = v * 100 - target;
  return <span className={d >= 0 ? 'up' : 'down'}>Meta {String(target).replace('.', ',')}% · {d >= 0 ? 'atingida' : `${Math.abs(d).toFixed(1).replace('.', ',')} p.p. abaixo`}</span>;
}

export function InventoryList() {
  const { user } = useSession();
  const isAdmin = user?.role === 'ADMIN';
  const { data, loading, error, reload } = useApi<any[]>('/inventory');
  const target = useTarget();
  const [creating, setCreating] = useState(false);
  const open = (data ?? []).filter((s) => s.status === 'OPEN');
  const done = (data ?? []).filter((s) => s.status === 'FINISHED');
  const last = done[0];
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><h1>Inventário</h1><span className="spacer" />{isAdmin && <button className="btn primary" onClick={() => setCreating(true)}>Novo inventário</button>}</div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : <>
        {isAdmin && (
          <div className="metrics">
            <Metric label="Acuracidade (último, por item)" value={last?.item_accuracy == null ? '—' : pct(last.item_accuracy, 1)} sub={<><MetaText v={last?.item_accuracy ?? null} target={target} />{last && <div>{last.name} · {dateTime(last.finished_at)}</div>}</>} />
            <Metric label="Acuracidade em valor (último)" value={last?.value_accuracy == null ? '—' : pct(last.value_accuracy, 1)} sub={last?.summary ? `Divergência ${money(last.summary.divergenceAbsCents)} de ${money(last.summary.systemValueCents)}` : 'Cadastre custos para medir em valor'} />
            <Metric label="Média dos últimos 5 (por item)" value={done.length ? pct(done.slice(0, 5).reduce((a, s) => a + (s.item_accuracy ?? 0), 0) / Math.min(5, done.length), 1) : '—'} sub={`${done.length} inventário(s) concluído(s)${target != null ? ` · ${done.filter((x) => x.item_accuracy != null && x.item_accuracy * 100 >= target).length} na meta` : ''}`} />
          </div>
        )}
        <div className="card flush">
          <div style={{ padding: '14px 16px' }}><h2>Contagens em andamento</h2></div>
          {!open.length ? <Empty>Nenhuma contagem aberta{isAdmin ? '. Crie um novo inventário para começar.' : '.'}</Empty> : open.map((s) => (
            <Link key={s.id} to={`/inventario/${s.id}`} className="list-item" style={{ color: 'inherit' }}>
              <span><b>{s.name}</b><div className="faint">{SCOPE[s.scope]}{s.category ? `: ${s.category}` : ''}{s.blind ? ' · contagem cega' : ''} · iniciado {dateTime(s.created_at)}</div></span>
              <span className="spacer" /><span className="badge accent num">{s.counted_items}/{s.total_items} contados</span>
            </Link>
          ))}
        </div>
        {isAdmin && (
          <div className="card flush">
            <div style={{ padding: '14px 16px' }}><h2>Histórico de acuracidade</h2></div>
            {!done.length ? <Empty>Nenhum inventário concluído.</Empty> : (
              <table className="table responsive"><thead><tr><th>Inventário</th><th>Concluído</th><th className="r">Itens contados</th><th className="r">Divergentes</th><th className="r">Acuracidade (item)</th><th className="r">Acuracidade (valor)</th><th>Meta</th><th>Estoque</th></tr></thead><tbody>
                {done.map((s) => (
                  <tr key={s.id} className="click" onClick={() => location.assign(`/inventario/${s.id}`)}>
                    <td data-label="Inventário"><b>{s.name}</b><div className="faint">{SCOPE[s.scope]}{s.category ? `: ${s.category}` : ''}</div></td>
                    <td data-label="Concluído">{dateTime(s.finished_at)}</td>
                    <td data-label="Itens contados" className="r num">{s.summary?.countedItems ?? s.counted_items}</td>
                    <td data-label="Divergentes" className="r num">{s.summary?.divergentItems ?? '—'}</td>
                    <td data-label="Acuracidade (item)" className="r"><span className={`badge ${accClass(s.item_accuracy, target)} num`}>{pct(s.item_accuracy, 1)}</span></td>
                    <td data-label="Acuracidade (valor)" className="r"><span className={`badge ${accClass(s.value_accuracy, target)} num`}>{pct(s.value_accuracy, 1)}</span></td>
                    <td data-label="Meta">{target == null || s.item_accuracy == null ? '—' : s.item_accuracy * 100 >= target ? <span className="badge success">atingida</span> : <span className="badge danger">abaixo</span>}</td>
                    <td data-label="Estoque">{s.applied ? 'ajustado' : 'não ajustado'}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        )}
      </>}
      {creating && <CreateModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const { boot } = useSession();
  const [scope, setScope] = useState<'FULL' | 'CATEGORY' | 'PARTIAL'>('FULL');
  const [cat, setCat] = useState('');
  const [name, setName] = useState('');
  const [blind, setBlind] = useState(true);
  const nav = useNavigate();
  const toast = useToast();
  const [create, busy] = useAction(async () => {
    try {
      const s = await api('/inventory', { body: { name: name || undefined, scope, categoryId: scope === 'CATEGORY' ? Number(cat) : null, productIds: [], blind } });
      nav(`/inventario/${s.id}`);
    } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title="Novo inventário" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || (scope === 'CATEGORY' && !cat)} onClick={create}>Começar contagem</button></>}>
      <Field group label="Tipo de contagem">
        <Segmented value={scope} onChange={setScope} options={[{ value: 'FULL', label: 'Geral' }, { value: 'CATEGORY', label: 'Por categoria' }, { value: 'PARTIAL', label: 'Parcial' }]} />
      </Field>
      <div className="faint">
        {scope === 'FULL' && 'Todos os produtos ativos. Ideal mensalmente ou ao assumir o estoque.'}
        {scope === 'CATEGORY' && 'Só uma categoria (ex.: Cervejas). Bom para contagens semanais rotativas.'}
        {scope === 'PARTIAL' && 'Contagem rápida (cíclica): conte só o que ler ou digitar — ex.: os itens de maior giro.'}
      </div>
      {scope === 'CATEGORY' && <Field label="Categoria"><select className="input" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Selecione…</option>{boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <Field label="Nome (opcional)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Cervejas — semana 43" /></Field>
      <label className="check"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> Contagem cega (quem conta não vê a quantidade do sistema) — recomendado</label>
    </Modal>
  );
}

export function InventoryCount() {
  const id = Number(useParams().id);
  const { user } = useSession();
  const isAdmin = user?.role === 'ADMIN';
  const { data: s, loading, error, reload } = useApi<any>(`/inventory/${id}`);
  const [mode, setMode] = useState<'scan' | 'type'>('scan');
  const [q, setQ] = useState('');
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const [typing, setTyping] = useState<any>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'diff'>('all');
  const [finishing, setFinishing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const target = useTarget();
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const items: any[] = s?.items ?? [];
  const findLocal = (code: string) => items.find((i) => i.barcode === code || i.internalCode === code);

  const [count] = useAction(async (productId: number, qtyMilli: number, m: 'add' | 'set') => {
    try {
      const r = await api(`/inventory/${id}/count`, { body: { productId, qtyMilli, mode: m } });
      setLast({ ok: true, text: `${r.name}: ${qty(r.countedMilli, r.unit)} contado(s)` });
      if ('vibrate' in navigator) navigator.vibrate?.(40);
      reload();
    } catch (e: any) { setLast({ ok: false, text: e.message }); }
  });

  const onCode = async (code: string) => {
    code = code.trim();
    if (!code) return;
    let p = findLocal(code);
    if (!p) {
      try { const r = await api(`/products/by-code/${encodeURIComponent(code)}`); p = { productId: r.id, name: r.name, unit: r.unit }; }
      catch { setLast({ ok: false, text: `Código ${code} não cadastrado.` }); return; }
    }
    if (mode === 'type' || isFractional(p.unit as Unit)) setTyping(p);
    else count(p.productId, 1000, 'add');
  };
  useHidScanner(onCode, !typing && s?.status === 'OPEN');

  const visible = useMemo(() => items.filter((i) => {
    if (filter === 'pending') return i.countedMilli == null;
    if (filter === 'diff') return i.diffMilli != null && i.diffMilli !== 0;
    return true;
  }).filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()) || i.barcode === q), [items, filter, q]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !s) return <Loading />;
  if (!s) return null;
  const isOpen = s.status === 'OPEN';
  const showSystem = s.revealed && (!isOpen || !s.blind || (isAdmin && reveal));

  return (
    <div className="stack">
      <div className="page-head">
        <Link to="/inventario" className="btn ghost sm">← Inventário</Link>
        <div><h1>{s.name}</h1><div className="faint">{SCOPE[s.scope]}{s.category ? `: ${s.category}` : ''}{s.blind ? ' · contagem cega' : ''} · {s.countedItems}/{s.totalItems} contados</div></div>
        <span className="spacer" />
        {!isOpen && <span className="badge">{s.status === 'FINISHED' ? 'concluído' : 'cancelado'}</span>}
        {isOpen && isAdmin && s.blind && <button className="btn" onClick={() => setReveal(!reveal)}>{reveal ? 'Ocultar sistema' : 'Mostrar sistema'}</button>}
        {isOpen && isAdmin && <button className="btn primary" onClick={() => setFinishing(true)}>Revisar e concluir</button>}
      </div>

      {isOpen && (
        <div className="card stack">
          <div className="row wrap">
            <Segmented value={mode} onChange={setMode} options={[{ value: 'scan', label: 'Cada leitura soma 1' }, { value: 'type', label: 'Ler e digitar quantidade' }]} />
          </div>
          <div className="row">
            <input ref={input} className="input lg" placeholder="Leia o código (coletor) ou digite o código/nome" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { const v = q; setQ(''); if (/^\d{4,}$/.test(v.trim()) || findLocal(v.trim())) onCode(v); else if (visible.length === 1) setTyping(visible[0]); } }} autoFocus />
            <CameraButton continuous onScan={onCode} />
          </div>
          {last && <div className={`scan-result ${last.ok ? 'ok' : 'err'}`} role="status"><b>{last.text}</b></div>}
          <div className="faint">Coletor: basta ler, não precisa clicar no campo. Produtos vendidos por litro/kg sempre pedem a quantidade.</div>
        </div>
      )}

      {s.accuracy && showSystem && (
        <div className="metrics">
          <Metric label="Acuracidade por item" value={pct(s.accuracy.itemAccuracy, 1)} sub={<><div>{s.accuracy.matchedItems} de {s.accuracy.countedItems} itens batendo</div><MetaText v={s.accuracy.itemAccuracy} target={target} /></>} />
          <Metric label="Acuracidade em valor" value={pct(s.accuracy.valueAccuracy, 1)} sub={`Divergência ${money(s.accuracy.divergenceAbsCents)} de ${money(s.accuracy.systemValueCents)}`} />
          <Metric label="Saldo das divergências" value={money(s.accuracy.divergenceNetCents)} sub={s.accuracy.divergenceNetCents < 0 ? 'Falta mercadoria (custo)' : s.accuracy.divergenceNetCents > 0 ? 'Sobra mercadoria (custo)' : 'Sem diferença'} />
        </div>
      )}

      <div className="row wrap">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: `Todos (${items.length})` }, { value: 'pending', label: `Faltam contar (${items.length - s.countedItems})` }, ...(showSystem ? [{ value: 'diff' as const, label: 'Com divergência' }] : [])]} />
      </div>
      <div className="card flush">
        {!visible.length ? <Empty>{s.scope === 'PARTIAL' && !items.length ? 'Leia ou digite os códigos dos produtos que vai contar.' : 'Nada nesta lista.'}</Empty> : (
          <table className="table responsive"><thead><tr><th>Produto</th><th className="r">Contado</th>{showSystem && <><th className="r">Sistema</th><th className="r">Diferença</th><th className="r">Valor</th></>}{isOpen && <th />}</tr></thead><tbody>
            {visible.map((i) => (
              <tr key={i.productId}>
                <td data-label="Produto"><b>{i.name}</b><div className="faint">{i.category}{i.barcode ? ` · ${i.barcode}` : ''}</div></td>
                <td data-label="Contado" className="r num">{i.countedMilli == null ? <span className="faint">—</span> : qty(i.countedMilli, i.unit)}</td>
                {showSystem && <>
                  <td data-label="Sistema" className="r num">{qty(i.systemMilli, i.unit)}</td>
                  <td data-label="Diferença" className={`r num ${i.diffMilli < 0 ? 'down' : i.diffMilli > 0 ? 'up' : ''}`}>{i.diffMilli == null ? '' : i.diffMilli === 0 ? 'OK' : `${i.diffMilli > 0 ? '+' : ''}${qty(i.diffMilli, i.unit)}`}</td>
                  <td data-label="Valor" className="r num">{i.diffValueCents ? money(i.diffValueCents) : ''}</td>
                </>}
                {isOpen && <td className="r"><button className="btn sm" onClick={() => setTyping(i)}>{i.countedMilli == null ? 'Contar' : 'Recontar'}</button></td>}
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      {typing && <QtyModal item={typing} onClose={() => { setTyping(null); input.current?.focus(); }} onSave={(m, mode) => { count(typing.productId, m, mode); setTyping(null); input.current?.focus(); }} />}
      {finishing && <FinishModal target={target} s={s} onClose={() => setFinishing(false)} onDone={() => { setFinishing(false); reload(); toast('Inventário concluído.', 'success'); }} />}
    </div>
  );
}

function QtyModal({ item, onClose, onSave }: { item: any; onClose: () => void; onSave: (m: number, mode: 'add' | 'set') => void }) {
  const [v, setV] = useState('');
  const m = v.trim() === '0' ? 0 : parseQty(v, item.unit);
  const frac = isFractional(item.unit);
  return (
    <Modal title={item.name} onClose={onClose} footer={<>
      {item.countedMilli != null && <button className="btn" disabled={!m} onClick={() => m && onSave(m, 'add')}>Somar</button>}
      <button className="btn primary" disabled={m == null} onClick={() => m != null && onSave(m, 'set')}>{item.countedMilli != null ? 'Substituir contagem' : 'Salvar'}</button>
    </>}>
      {item.countedMilli != null && <div className="notice">Já contado: {qty(item.countedMilli, item.unit)}. Use “Somar” para outro local (ex.: geladeira + depósito).</div>}
      <Field label={`Quantidade encontrada (${frac ? (item.unit === 'L' ? 'litros, ex.: 12,5 ou 500ml' : 'kg') : 'unidades'})`}>
        <input className="input lg num" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && m != null && onSave(m, 'set')} />
      </Field>
      {v && m == null && <div className="error-text">Quantidade inválida{!frac ? ' (use números inteiros)' : ''}.</div>}
    </Modal>
  );
}

function FinishModal({ s, target, onClose, onDone }: { s: any; target: number | null; onClose: () => void; onDone: () => void }) {
  const [apply, setApply] = useState(true);
  const toast = useToast();
  const uncounted = s.totalItems - s.countedItems;
  const [finish, busy] = useAction(async () => {
    try { await api(`/inventory/${s.id}/finish`, { body: { apply } }); onDone(); } catch (e: any) { toast(e.message, 'error'); }
  });
  const [cancel] = useAction(async () => {
    if (!window.confirm('Descartar este inventário? Nada será ajustado.')) return;
    try { await api(`/inventory/${s.id}/cancel`, { body: {} }); location.assign('/inventario'); } catch (e: any) { toast(e.message, 'error'); }
  });
  const a = s.accuracy;
  return (
    <Modal title="Concluir inventário" onClose={onClose} footer={<><button className="btn danger" onClick={cancel}>Descartar</button><span className="spacer" /><button className="btn" onClick={onClose}>Voltar</button><button className="btn primary" disabled={busy || !s.countedItems} onClick={finish}>Concluir</button></>}>
      <div className="row"><span className="muted">Acuracidade por item</span><span className="spacer" /><b className="num">{pct(a?.itemAccuracy, 1)}</b></div>
      <div className="faint"><MetaText v={a?.itemAccuracy ?? null} target={target} /></div>
      <div className="row"><span className="muted">Acuracidade em valor</span><span className="spacer" /><b className="num">{pct(a?.valueAccuracy, 1)}</b></div>
      <div className="row"><span className="muted">Itens divergentes</span><span className="spacer" /><b className="num">{a?.divergentItems ?? 0}</b></div>
      {uncounted > 0 && <div className="notice warning">{uncounted} produto(s) não foram contados e ficarão de fora (não serão ajustados nem entram na acuracidade).</div>}
      <label className="check"><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> Ajustar o estoque do sistema para as quantidades contadas</label>
      <div className="faint">A acuracidade é registrada antes do ajuste. Cada correção fica nas movimentações de estoque como “Inventário”.</div>
    </Modal>
  );
}
