import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi, useAction, useDebounced } from '../../lib/hooks';
import { money, qty, parseMoney, centsToInput, parseQty, UNIT_LABEL, Unit, dateTime } from '../../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from '../../components/ui';
import { useSession } from '../../components/session';
import { CameraButton } from '../../components/scanner';
import { ProductArt } from '../../components/ProductArt';

const FIELD_LABEL: Record<string, string> = { name: 'Nome', price_cents: 'Preço', cost_cents: 'Custo', active: 'Ativo', category_id: 'Categoria', min_stock_milli: 'Estoque mínimo', barcode: 'Código de barras', internal_code: 'Código interno', unit: 'Unidade', track_expiry: 'Controla validade' };

export default function Products() {
  const { boot } = useSession();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const dq = useDebounced(q);
  const { data, loading, error, reload } = useApi<any[]>(`/products?all=1&q=${encodeURIComponent(dq)}${cat ? `&categoryId=${cat}` : ''}`);
  const [edit, setEdit] = useState<any | null>(null);
  const [entry, setEntry] = useState<any | null>(null);
  const [history, setHistory] = useState<any | null>(null);
  return (
    <div className="stack">
      <div className="page-head"><h1>Produtos</h1><span className="spacer" /><button className="btn primary" onClick={() => setEdit({})}>Novo produto</button></div>
      <div className="row wrap">
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Buscar por nome ou código" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Categoria">
          <option value="">Todas as categorias</option>{boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush">
          {!data?.length ? <Empty>Nenhum produto cadastrado.</Empty> : (
            <table className="table responsive">
              <thead><tr><th>Produto</th><th className="r">Preço</th><th className="r">Custo</th><th className="r">Estoque</th><th>Situação</th><th /></tr></thead>
              <tbody>{data.map((p) => (
                <tr key={p.id}>
                  <td data-label="Produto"><div className="row" style={{ gap: 10 }}><ProductArt size="sm" image={p.image_url} category={p.category} /><div><b>{p.name}</b><div className="faint">{p.category} · {UNIT_LABEL[p.unit as Unit]}{p.barcode ? ` · ${p.barcode}` : ''}</div></div></div></td>
                  <td data-label="Preço" className="r num">{money(p.price_cents)}</td>
                  <td data-label="Custo" className="r num">{money(p.cost_cents)}</td>
                  <td data-label="Estoque" className="r num">{p.stock_milli <= p.min_stock_milli && p.min_stock_milli > 0 ? <span className="badge warning">{qty(p.stock_milli, p.unit)}</span> : qty(p.stock_milli, p.unit)}</td>
                  <td data-label="Situação">{p.active ? <span className="badge success">ativo</span> : <span className="badge">inativo</span>}</td>
                  <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                    <button className="btn sm" onClick={() => setEntry(p)}>Entrada</button>
                    <button className="btn sm" onClick={() => setEdit(p)}>Editar</button>
                    <button className="btn sm ghost" onClick={() => setHistory(p)}>Histórico</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
      {edit && <ProductForm p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {entry && <EntryForm p={entry} onClose={() => setEntry(null)} onSaved={() => { setEntry(null); reload(); }} />}
      {history && <HistoryModal p={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function ProductForm({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const { boot } = useSession();
  const isNew = !p.id;
  const [f, setF] = useState({
    name: p.name ?? '', internal_code: p.internal_code ?? '', barcode: p.barcode ?? '', category_id: String(p.category_id ?? boot?.categories[0]?.id ?? ''),
    unit: (p.unit ?? 'UN') as Unit, price: centsToInput(p.price_cents), cost: centsToInput(p.cost_cents),
    min: p.min_stock_milli != null ? String(p.min_stock_milli / 1000).replace('.', ',') : '', initial: '', image: p.image_url ?? '', track_expiry: !!p.track_expiry, active: p.active === undefined ? true : !!p.active,
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const price = parseMoney(f.price);
  const cost = f.cost.trim() ? parseMoney(f.cost) : null;
  const min = f.min.trim() ? parseQty(f.min, f.unit === 'UN' || f.unit === 'PCT' ? f.unit : 'L') : 0;
  const initial = f.initial.trim() ? parseQty(f.initial, f.unit === 'UN' || f.unit === 'PCT' ? f.unit : 'L') : 0;
  const valid = f.name.trim() && price != null && (f.cost.trim() === '' || cost != null) && min != null && initial != null;
  const [save, busy] = useAction(async () => {
    setErr(null);
    const body: any = { name: f.name, internal_code: f.internal_code || null, barcode: f.barcode || null, category_id: Number(f.category_id), unit: f.unit, price_cents: price, cost_cents: cost, min_stock_milli: min, track_expiry: f.track_expiry, active: f.active, image_url: f.image.trim() || null };
    try {
      if (isNew) await api('/products', { body: { ...body, initial_stock_milli: initial || 0 } });
      else await api(`/products/${p.id}`, { method: 'PATCH', body });
      onSaved();
    } catch (e: any) { setErr(e.message); }
  });
  const unitHint = f.unit === 'L' ? 'Em litros (ex.: 50 ou 0,5). Preço é por litro.' : f.unit === 'KG' ? 'Em kg (ex.: 2,5). Preço é por kg.' : 'Quantidade inteira.';
  return (
    <Modal wide title={isNew ? 'Novo produto' : `Editar ${p.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!valid || busy} onClick={save}>Salvar</button></>}>
      <Field label="Nome"><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <Field label="Categoria"><select className="input" value={f.category_id} onChange={set('category_id')}>{boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Unidade de venda"><select className="input" value={f.unit} onChange={set('unit')} disabled={!isNew}>{(['UN', 'PCT', 'L', 'KG'] as Unit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}</select></Field>
        <Field label={`Preço de venda${f.unit === 'L' ? ' (por litro)' : f.unit === 'KG' ? ' (por kg)' : ''}`}><input className="input num" inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0,00" /></Field>
        <Field label="Custo de aquisição" hint="Opcional, mas necessário para margem."><input className="input num" inputMode="decimal" value={f.cost} onChange={set('cost')} placeholder="0,00" /></Field>
        <Field label="Código interno"><input className="input" value={f.internal_code} onChange={set('internal_code')} /></Field>
        <Field label="Código de barras"><div className="row"><input className="input" value={f.barcode} onChange={set('barcode')} inputMode="numeric" placeholder="Leia com o coletor ou a câmera" /><CameraButton label="" onScan={(c) => setF((x) => ({ ...x, barcode: c }))} /></div></Field>
        <Field label="Estoque mínimo" hint={unitHint}><input className="input num" inputMode="decimal" value={f.min} onChange={set('min')} /></Field>
        {isNew && <Field label="Estoque inicial" hint={unitHint}><input className="input num" inputMode="decimal" value={f.initial} onChange={set('initial')} /></Field>}
      </div>
      {!isNew && <div className="faint">Unidade não pode ser alterada após o cadastro. Estoque é alterado por entradas, ajustes ou inventário.</div>}
      <Field label="Imagem (opcional)" hint="Cole o link https:// de uma foto do produto. Sem foto, aparece a ilustração da categoria.">
        <div className="row"><ProductArt size="sm" image={f.image || null} category={boot?.categories.find((c) => String(c.id) === f.category_id)?.name} /><input className="input" value={f.image} onChange={set('image')} placeholder="https://..." /></div>
      </Field>
      <label className="check"><input type="checkbox" checked={f.track_expiry} onChange={set('track_expiry')} /> Controlar validade nas entradas</label>
      <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Produto ativo (pode ser vendido)</label>
      {price != null && cost != null && price > 0 && <div className="notice">Margem bruta: {(((price - cost) / price) * 100).toFixed(1).replace('.', ',')}% ({money(price - cost)} por {UNIT_LABEL[f.unit]})</div>}
      {err && <div className="notice danger">{err}</div>}
    </Modal>
  );
}

function EntryForm({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const [cost, setCost] = useState(centsToInput(p.cost_cents));
  const [expiry, setExpiry] = useState('');
  const [updateCost, setUpdateCost] = useState(true);
  const toast = useToast();
  const m = parseQty(q, p.unit);
  const c = cost.trim() ? parseMoney(cost) : null;
  const [save, busy] = useAction(async () => {
    try { await api('/stock/entries', { body: { productId: p.id, qtyMilli: m, unitCostCents: c, expiryDate: expiry || null, updateCost } }); toast('Entrada registrada.', 'success'); onSaved(); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title={`Entrada: ${p.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!m || busy} onClick={save}>Registrar entrada</button></>}>
      <Field label={`Quantidade (${UNIT_LABEL[p.unit as Unit]})`} hint={`Estoque atual: ${qty(p.stock_milli, p.unit)}`}><input className="input lg num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></Field>
      <Field label={`Custo por ${UNIT_LABEL[p.unit as Unit]}`}><input className="input num" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} /> Atualizar custo do produto com este valor</label>
      <Field label={`Validade${p.track_expiry ? '' : ' (opcional)'}`}><input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
      {m && <div className="notice">Novo estoque: {qty(p.stock_milli + m, p.unit)}</div>}
    </Modal>
  );
}

function HistoryModal({ p, onClose }: { p: any; onClose: () => void }) {
  const h = useApi<any[]>(`/products/${p.id}/history`);
  const mv = useApi<any[]>(`/stock/movements?productId=${p.id}`);
  const fmt = (field: string, v: string | null) => v == null ? '—' : field.endsWith('_cents') ? money(Number(v)) : field.endsWith('_milli') ? qty(Number(v), p.unit) : v === '1' && (field === 'active' || field === 'track_expiry') ? 'sim' : v === '0' && (field === 'active' || field === 'track_expiry') ? 'não' : v;
  return (
    <Modal wide title={`Histórico: ${p.name}`} onClose={onClose}>
      <h3>Alterações de cadastro</h3>
      {h.loading && !h.data ? <Loading /> : !h.data?.length ? <Empty>Nenhuma alteração.</Empty> : (
        <table className="table responsive"><thead><tr><th>Quando</th><th>Quem</th><th>Campo</th><th>De</th><th>Para</th></tr></thead><tbody>
          {h.data.map((r) => <tr key={r.id}><td data-label="Quando">{dateTime(r.at)}</td><td data-label="Quem">{r.user_name}</td><td data-label="Campo">{FIELD_LABEL[r.field] ?? r.field}</td><td data-label="De">{fmt(r.field, r.old_value)}</td><td data-label="Para">{fmt(r.field, r.new_value)}</td></tr>)}
        </tbody></table>
      )}
      <h3>Movimentações de estoque</h3>
      {mv.loading && !mv.data ? <Loading /> : <Movements rows={mv.data ?? []} />}
    </Modal>
  );
}

export const MOV_LABEL: Record<string, string> = { SALE: 'Venda', SALE_CANCEL: 'Cancelamento', ENTRY: 'Entrada', ADJUST: 'Ajuste', LOSS: 'Perda', INVENTORY: 'Inventário' };
export function Movements({ rows, showProduct }: { rows: any[]; showProduct?: boolean }) {
  if (!rows.length) return <Empty>Nenhuma movimentação.</Empty>;
  return (
    <table className="table responsive"><thead><tr><th>Quando</th>{showProduct && <th>Produto</th>}<th>Tipo</th><th className="r">Qtd.</th><th className="r">Saldo</th><th>Usuário</th><th>Motivo</th></tr></thead><tbody>
      {rows.map((m) => (
        <tr key={m.id}><td data-label="Quando">{dateTime(m.at)}</td>{showProduct && <td data-label="Produto">{m.product_name}</td>}<td data-label="Tipo">{MOV_LABEL[m.type]}{m.ref_type === 'sale' ? ` nº ${m.ref_id}` : ''}</td>
          <td data-label="Qtd." className={`r num ${m.qty_milli < 0 ? 'down' : 'up'}`}>{m.qty_milli > 0 ? '+' : ''}{qty(m.qty_milli, m.unit)}</td><td data-label="Saldo" className="r num">{qty(m.balance_after_milli, m.unit)}</td>
          <td data-label="Usuário">{m.user_name}</td><td data-label="Motivo" className="faint">{m.reason ?? ''}</td></tr>
      ))}
    </tbody></table>
  );
}
