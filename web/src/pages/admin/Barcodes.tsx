import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useApi, useAction } from '../../lib/hooks';
import { money } from '../../lib/format';
import { Loading, ErrorState, Empty, Segmented, useToast } from '../../components/ui';
import { useSession } from '../../components/session';
import { ean13Svg, isInternalEan, newInternalEan, toEan13 } from '../../lib/barcode';
import { printBarcodeSheet } from '../../lib/print';
import { LabelModal } from './Products';

type Tab = 'loja' | 'fabrica' | 'sem';

/**
 * Administração › Códigos de barras: todos os códigos dos produtos, gerar os que faltam
 * e baixar/imprimir a folha de códigos para o balcão (o funcionário lê e o produto entra no pedido).
 */
export default function Barcodes() {
  const toast = useToast();
  const { boot } = useSession();
  const { data, loading, error, reload } = useApi<any[]>('/products');
  const [tab, setTab] = useState<Tab>('loja');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [price, setPrice] = useState(true);
  const [label, setLabel] = useState<any | null>(null);
  const active = useMemo(() => (data ?? []).filter((p) => p.active), [data]);
  const groups = useMemo(() => ({
    loja: active.filter((p) => isInternalEan(p.barcode)),
    fabrica: active.filter((p) => p.barcode && !isInternalEan(p.barcode)),
    sem: active.filter((p) => !p.barcode),
  }), [active]);
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const list = groups[tab].filter((p) => !q || norm(p.name).includes(norm(q)) || String(p.barcode ?? '').includes(q));
  const printable = list.filter((p) => toEan13(p.barcode));
  const chosen = printable.filter((p) => sel.size === 0 || sel.has(p.id));

  const [genAll, generating] = useAction(async () => {
    const todo = groups.sem;
    if (!todo.length || !window.confirm(`Gerar código de barras para ${todo.length} produto(s) sem código? Os códigos ficam salvos nos produtos.`)) return;
    let ok = 0;
    for (const p of todo) {
      for (let tries = 0; tries < 3; tries++) {
        try { await api(`/products/${p.id}`, { method: 'PATCH', body: { barcode: newInternalEan() } }); ok++; break; } catch { /* código repetido: tenta outro */ }
      }
    }
    toast(`${ok} código(s) gerado(s).`, 'success'); setTab('loja'); reload();
  });
  const sheet = () => printBarcodeSheet(chosen.map((p) => { const code = toEan13(p.barcode)!; return { name: p.name, price_cents: p.price_cents, unit: p.unit, code, svg: ean13Svg(code) }; }), { storeName: boot?.storeName, price });
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <div className="page-head"><h1>Códigos de barras</h1></div>
      <div className="notice">Baixe a <b>folha de códigos</b> e deixe no balcão: o funcionário lê o código com o leitor ou a câmera e o produto entra direto no pedido (ou na conta da mesa). Para salvar em PDF, escolha "Salvar como PDF" na janela de impressão.</div>
      <Segmented value={tab} onChange={(t) => { setTab(t); setSel(new Set()); }} options={[
        { value: 'loja', label: `Gerados pela loja (${groups.loja.length})` }, { value: 'fabrica', label: `De fábrica (${groups.fabrica.length})` }, { value: 'sem', label: `Sem código (${groups.sem.length})` }]} />
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 320 }} placeholder="Buscar produto ou código" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        {tab === 'sem'
          ? <button className="btn primary" disabled={generating || !groups.sem.length} onClick={genAll}>{generating ? 'Gerando…' : `Gerar código para todos (${groups.sem.length})`}</button>
          : <>
            <label className="check"><input type="checkbox" checked={price} onChange={(e) => setPrice(e.target.checked)} /> Com preço</label>
            <button className="btn primary" disabled={!chosen.length} onClick={sheet}>Baixar folha de códigos ({chosen.length})</button>
          </>}
      </div>
      {tab !== 'sem' && sel.size > 0 && <div className="faint">{sel.size} selecionado(s): a folha terá só esses. <button className="btn ghost sm" onClick={() => setSel(new Set())}>Limpar seleção</button></div>}
      {tab === 'fabrica' && printable.length < list.length && <div className="faint">{list.length - printable.length} código(s) de fábrica fora do padrão EAN-13 não entram na folha.</div>}
      <div className="card flush">
        {!list.length ? <Empty>{tab === 'sem' ? 'Todos os produtos têm código de barras.' : tab === 'loja' ? 'Nenhum código gerado pela loja ainda. Veja a aba "Sem código".' : 'Nenhum produto com código de fábrica.'}</Empty> : (
          <table className="table responsive barcodes"><thead><tr>{tab !== 'sem' && <th />}<th>Produto</th><th className="r">Preço</th><th>Código</th><th /></tr></thead><tbody>
            {list.map((p) => { const code = toEan13(p.barcode); return (
              <tr key={p.id}>
                {tab !== 'sem' && <td data-label="Na folha"><input type="checkbox" disabled={!code} checked={sel.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Selecionar ${p.name}`} /></td>}
                <td data-label="Produto"><b>{p.name}</b><div className="faint">{p.category}</div></td>
                <td data-label="Preço" className="r num">{money(p.price_cents)}</td>
                <td data-label="Código">{code ? <div className="bc-mini" dangerouslySetInnerHTML={{ __html: ean13Svg(code) }} /> : p.barcode ? <span className="num">{p.barcode}</span> : <span className="faint">—</span>}</td>
                <td className="r"><button className="btn sm" onClick={() => setLabel(p)}>{p.barcode ? 'Etiqueta' : 'Gerar'}</button></td>
              </tr>); })}
          </tbody></table>
        )}
      </div>
      {label && <LabelModal p={label} onClose={() => setLabel(null)} onSaved={reload} />}
    </div>
  );
}
