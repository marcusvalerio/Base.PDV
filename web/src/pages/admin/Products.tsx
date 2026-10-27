import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi, useAction, useDebounced } from '../../lib/hooks';
import { money, qty, parseMoney, centsToInput, parseQty, UNIT_LABEL, Unit, dateTime } from '../../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, Segmented, useToast } from '../../components/ui';
import { useSession } from '../../components/session';
import { CameraButton } from '../../components/scanner';
import { ProductArt, ArtPicker } from '../../components/ProductArt';

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
                  <td data-label="Produto"><div className="row" style={{ gap: 10 }}><ProductArt size="sm" image={p.image_url} category={p.category} name={p.name} /><div><b>{p.name}</b><div className="faint">{p.category} · {UNIT_LABEL[p.unit as Unit]}{p.pack_label ? ` · ${p.pack_label} c/ ${qty(p.pack_size_milli, p.unit)}` : ''}{p.stock_source_id ? ` · desconta ${qty(p.stock_source_qty_milli, p.stock_source_unit)} de ${p.stock_source_name}` : ''}{p.barcode ? ` · ${p.barcode}` : ''}</div></div></div></td>
                  <td data-label="Preço" className="r num">{money(p.price_cents)}</td>
                  <td data-label="Custo" className="r num">{money(p.cost_cents)}</td>
                  <td data-label="Estoque" className="r num"><span className={`badge num ${p.stock_milli <= 0 ? 'danger' : p.min_stock_milli > 0 && p.stock_milli <= p.min_stock_milli ? 'warning' : 'success'}`}>{qty(p.stock_milli, p.unit)}</span>{p.stock_source_id ? <div className="faint">pela origem</div> : null}</td>
                  <td data-label="Situação">{p.active ? <span className="badge success">ativo</span> : <span className="badge">inativo</span>}</td>
                  <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                    {!p.stock_source_id && <button className="btn sm" onClick={() => setEntry(p)}>Entrada</button>}
                    <button className="btn sm" onClick={() => setEdit(p)}>Editar</button>
                    <button className="btn sm ghost" onClick={() => setHistory(p)}>Histórico</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
      {edit && <ProductForm catalog={data ?? []} p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {entry && <EntryForm p={entry} onClose={() => setEntry(null)} onSaved={() => { setEntry(null); reload(); }} />}
      {history && <HistoryModal p={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function ProductForm({ p, catalog, onClose, onSaved }: { p: any; catalog: any[]; onClose: () => void; onSaved: () => void }) {
  const { boot } = useSession();
  const isNew = !p.id;
  const [f, setF] = useState({
    name: p.name ?? '', internal_code: p.internal_code ?? '', barcode: p.barcode ?? '', category_id: String(p.category_id ?? boot?.categories[0]?.id ?? ''),
    unit: (p.unit ?? 'UN') as Unit, price: centsToInput(p.price_cents), cost: centsToInput(p.cost_cents),
    min: p.min_stock_milli != null ? String(p.min_stock_milli / 1000).replace('.', ',') : '', initial: '', image: p.image_url ?? '',
    packLabel: p.pack_label ?? '', packSize: p.pack_size_milli != null ? String(p.pack_size_milli / 1000).replace('.', ',') : '',
    sourceId: p.stock_source_id ? String(p.stock_source_id) : '', sourceQty: p.stock_source_qty_milli != null ? String(p.stock_source_qty_milli) : '',
    mode: (p.stock_source_id ? 'source' : 'own') as 'own' | 'source', track_expiry: !!p.track_expiry, active: p.active === undefined ? true : !!p.active,
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const price = parseMoney(f.price);
  const cost = f.cost.trim() ? parseMoney(f.cost) : null;
  const min = f.min.trim() ? parseQty(f.min, f.unit === 'UN' || f.unit === 'PCT' ? f.unit : 'L') : 0;
  const initial = f.initial.trim() ? parseQty(f.initial, f.unit === 'UN' || f.unit === 'PCT' ? f.unit : 'L') : 0;
  const derived = f.mode === 'source';
  const source = catalog.find((x) => String(x.id) === f.sourceId);
  const qUnit = (u: Unit) => (u === 'UN' || u === 'PCT' ? u : 'L');
  const packSize = f.packSize.trim() ? parseQty(f.packSize, qUnit(f.unit)) : null;
  const packOk = !f.packLabel.trim() && !f.packSize.trim() ? true : !!f.packLabel.trim() && packSize != null;
  // Quantidade que sai da origem por unidade vendida: em mL/g para L/KG (ex.: 300) ou em unidades.
  const sourceQty = source ? (source.unit === 'L' || source.unit === 'KG' ? (/^\d+$/.test(f.sourceQty.trim()) ? Number(f.sourceQty) : null) : parseQty(f.sourceQty, qUnit(source.unit))) : null;
  const valid = f.name.trim() && price != null && (f.cost.trim() === '' || cost != null) && (derived ? !!source && !!sourceQty : min != null && initial != null && packOk);
  const [save, busy] = useAction(async () => {
    setErr(null);
    const body: any = { name: f.name, internal_code: f.internal_code || null, barcode: f.barcode || null, category_id: Number(f.category_id), unit: derived ? 'UN' : f.unit, price_cents: price, cost_cents: derived ? null : cost, min_stock_milli: derived ? 0 : min, track_expiry: f.track_expiry, active: f.active, image_url: f.image.trim() || null,
      pack_label: derived ? null : f.packLabel.trim() || null, pack_size_milli: derived ? null : packSize,
      stock_source_id: derived ? Number(f.sourceId) : null, stock_source_qty_milli: derived ? sourceQty : null };
    try {
      if (isNew) await api('/products', { body: { ...body, initial_stock_milli: derived ? 0 : initial || 0 } });
      else await api(`/products/${p.id}`, { method: 'PATCH', body });
      onSaved();
    } catch (e: any) { setErr(e.message); }
  });
  const unitHint = f.unit === 'L' ? 'Em litros (ex.: 50 ou 0,5). Preço é por litro.' : f.unit === 'KG' ? 'Em kg (ex.: 2,5). Preço é por kg.' : 'Quantidade inteira.';
  return (
    <Modal wide title={isNew ? 'Novo produto' : `Editar ${p.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!valid || busy} onClick={save}>Salvar</button></>}>
      <Field label="Nome"><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
      <Field group label="Estoque deste produto">
        <Segmented value={f.mode} onChange={(mode) => setF({ ...f, mode, ...(mode === 'source' ? { unit: 'UN' as Unit } : {}) })}
          options={[{ value: 'own', label: 'Tem estoque próprio' }, { value: 'source', label: 'Desconta de outro produto' }]} />
      </Field>
      {derived && (
        <div className="card stack">
          <div className="faint">Ex.: “Copo de Chopp 300ml” vendido por unidade que desconta 300 mL do “Chopp (barril)”. O custo e o estoque vêm do produto de origem.</div>
          <Field label="Desconta de">
            <select className="input" value={f.sourceId} onChange={set('sourceId')}>
              <option value="">Selecione o produto de origem…</option>
              {catalog.filter((x) => !x.stock_source_id && x.id !== p.id).map((x) => <option key={x.id} value={x.id}>{x.name} ({UNIT_LABEL[x.unit as Unit]})</option>)}
            </select>
          </Field>
          {source && (
            <Field label={source.unit === 'L' ? 'Quanto sai por unidade vendida (mL)' : source.unit === 'KG' ? 'Quanto sai por unidade vendida (g)' : `Quanto sai por unidade vendida (${UNIT_LABEL[source.unit as Unit]})`}
              hint={sourceQty ? `Cada unidade vendida desconta ${qty(sourceQty, source.unit)} de “${source.name}”.${source.cost_cents != null ? ` Custo por unidade: ${money(Math.round(source.cost_cents * sourceQty / 1000))}.` : ''}` : 'Ex.: 300 para um copo de 300 mL; 1500 para uma jarra de 1,5 L.'}>
              <input className="input num" inputMode="numeric" value={f.sourceQty} onChange={set('sourceQty')} placeholder={source.unit === 'L' ? '300' : '1'} />
            </Field>
          )}
        </div>
      )}
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <Field label="Categoria"><select className="input" value={f.category_id} onChange={set('category_id')}>{boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Unidade de venda"><select className="input" value={f.unit} onChange={set('unit')} disabled={!isNew || derived}>{(['UN', 'PCT', 'L', 'KG'] as Unit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}</select></Field>
        <Field label={`Preço de venda${f.unit === 'L' ? ' (por litro)' : f.unit === 'KG' ? ' (por kg)' : ''}`}><input className="input num" inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0,00" /></Field>
        {!derived && <Field label={`Custo por ${UNIT_LABEL[f.unit]}`} hint="Opcional, mas necessário para margem. Na entrada dá para informar o custo da caixa/barril."><input className="input num" inputMode="decimal" value={f.cost} onChange={set('cost')} placeholder="0,00" /></Field>}
        <Field label="Código interno"><input className="input" value={f.internal_code} onChange={set('internal_code')} /></Field>
        <Field group label="Código de barras"><div className="row"><input className="input" value={f.barcode} onChange={set('barcode')} inputMode="numeric" placeholder="Leia com o coletor ou a câmera" /><CameraButton label="" onScan={(c) => setF((x) => ({ ...x, barcode: c }))} /></div></Field>
        {!derived && <Field label="Estoque mínimo" hint={unitHint}><input className="input num" inputMode="decimal" value={f.min} onChange={set('min')} /></Field>}
        {isNew && !derived && <Field label="Estoque inicial" hint={unitHint}><input className="input num" inputMode="decimal" value={f.initial} onChange={set('initial')} /></Field>}
      </div>
      {!derived && (
        <div className="card stack">
          <h3>Embalagem de compra (opcional)</h3>
          <div className="faint">Como o produto chega do fornecedor. Ex.: caixa com 20 unidades, fardo com 12 latas, barril com 50 litros. Na entrada você informa só quantas caixas/barris chegaram.</div>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <Field label="Nome da embalagem"><input className="input" value={f.packLabel} onChange={set('packLabel')} placeholder="caixa, fardo, barril…" /></Field>
            <Field label={`Quanto vem dentro (${f.unit === 'L' ? 'litros' : f.unit === 'KG' ? 'kg' : f.unit === 'PCT' ? 'pacotes' : 'unidades'})`}><input className="input num" inputMode="decimal" value={f.packSize} onChange={set('packSize')} placeholder={f.unit === 'L' ? '50' : '20'} /></Field>
          </div>
          {!packOk && <div className="error-text">Preencha o nome e a quantidade (ou deixe os dois em branco).</div>}
          {packSize && f.packLabel.trim() && <div className="notice">1 {f.packLabel.trim()} = {qty(packSize, f.unit)}.</div>}
        </div>
      )}
      {!isNew && <div className="faint">Unidade não pode ser alterada após o cadastro. Estoque é alterado por entradas, ajustes ou inventário.</div>}
      <Field group label="Desenho do produto" hint="Já vem escolhido pelo nome (ex.: “Cerveja 600ml” usa a garrafa 600). Toque em outro para trocar.">
        <ArtPicker value={f.image} name={f.name} onChange={(v) => setF({ ...f, image: v })} />
      </Field>
      <Field group label="Ou foto (link https, opcional)" hint="Se colar o link de uma foto, ela substitui o desenho.">
        <div className="row"><ProductArt size="sm" image={f.image || null} name={f.name} category={boot?.categories.find((c) => String(c.id) === f.category_id)?.name} /><input className="input" value={f.image.startsWith('art:') ? '' : f.image} onChange={set('image')} placeholder="https://..." /></div>
      </Field>
      <label className="check"><input type="checkbox" checked={f.track_expiry} onChange={set('track_expiry')} /> Controlar validade nas entradas</label>
      <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Produto ativo (pode ser vendido)</label>
      {price != null && cost != null && price > 0 && <div className="notice">Margem bruta: {(((price - cost) / price) * 100).toFixed(1).replace('.', ',')}% ({money(price - cost)} por {UNIT_LABEL[f.unit]})</div>}
      {err && <div className="notice danger">{err}</div>}
    </Modal>
  );
}

function EntryForm({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const hasPack = !!p.pack_size_milli && !!p.pack_label;
  const [byPack, setByPack] = useState(hasPack);
  const [q, setQ] = useState('');
  const [cost, setCost] = useState(byPack && p.cost_cents != null ? centsToInput(Math.round(p.cost_cents * p.pack_size_milli / 1000)) : centsToInput(p.cost_cents));
  const [expiry, setExpiry] = useState('');
  const [updateCost, setUpdateCost] = useState(true);
  const toast = useToast();
  const packs = byPack ? (/^\d+$/.test(q.trim()) ? Number(q) : null) : null;
  const m = byPack ? (packs ? packs * p.pack_size_milli : null) : parseQty(q, p.unit);
  const typed = cost.trim() ? parseMoney(cost) : null;
  // Custo informado por caixa/barril é convertido para custo por unidade do produto.
  const c = typed == null ? null : byPack ? Math.round((typed * 1000) / p.pack_size_milli) : typed;
  const switchMode = (v: boolean) => {
    setByPack(v); setQ('');
    if (p.cost_cents != null) setCost(centsToInput(v ? Math.round(p.cost_cents * p.pack_size_milli / 1000) : p.cost_cents));
  };
  const [save, busy] = useAction(async () => {
    try { await api('/stock/entries', { body: { productId: p.id, qtyMilli: m, unitCostCents: c, expiryDate: expiry || null, updateCost } }); toast('Entrada registrada.', 'success'); onSaved(); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title={`Entrada: ${p.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!m || busy} onClick={save}>Registrar entrada</button></>}>
      {hasPack && <Segmented value={byPack ? 'pack' : 'unit'} onChange={(v) => switchMode(v === 'pack')} options={[{ value: 'pack', label: `Por ${p.pack_label} (${qty(p.pack_size_milli, p.unit)})` }, { value: 'unit', label: `Avulso (${UNIT_LABEL[p.unit as Unit]})` }]} />}
      <Field label={byPack ? `Quantos ${p.pack_label}s chegaram` : `Quantidade (${UNIT_LABEL[p.unit as Unit]})`} hint={`Estoque atual: ${qty(p.stock_milli, p.unit)}`}><input className="input lg num" inputMode={byPack ? 'numeric' : 'decimal'} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></Field>
      <Field label={byPack ? `Custo por ${p.pack_label}` : `Custo por ${UNIT_LABEL[p.unit as Unit]}`} hint={byPack && c != null ? `= ${money(c)} por ${UNIT_LABEL[p.unit as Unit]}` : undefined}><input className="input num" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} /> Atualizar custo do produto com este valor</label>
      <Field label={`Validade${p.track_expiry ? '' : ' (opcional)'}`}><input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
      {m && <div className="notice">{byPack ? `${packs} ${p.pack_label}(s) = ${qty(m, p.unit)}. ` : ''}Novo estoque: {qty(p.stock_milli + m, p.unit)}</div>}
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
