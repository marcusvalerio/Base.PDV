import { useState } from 'react';
import { useApi } from '../../lib/hooks';
import { money, qty, avgQty, isFractional } from '../../lib/format';
import { Loading, ErrorState, Empty, Segmented } from '../../components/ui';
import { useSession } from '../../components/session';

export default function Restock() {
  const { boot } = useSession();
  const [win, setWin] = useState('30');
  const [cat, setCat] = useState('');
  const [onlyNeeded, setOnlyNeeded] = useState(true);
  const [adjust, setAdjust] = useState<Record<number, string>>({});
  const { data, loading, error, reload } = useApi<any>(`/restock?windowDays=${win}${cat ? `&categoryId=${cat}` : ''}`);
  const items = (data?.items ?? []).filter((i: any) => !onlyNeeded || i.needsRestock);
  const chosen = (i: any) => {
    const v = adjust[i.productId];
    if (v === undefined) return i.suggestedMilli;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0;
  };
  const est = items.reduce((a: number, i: any) => a + (i.estimatedCostCents == null ? 0 : Math.round((i.estimatedCostCents / Math.max(i.suggestedMilli, 1)) * chosen(i))), 0);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head"><h1>Lista de reposição</h1></div>
      <div className="row wrap">
        <Segmented value={win} onChange={setWin} options={[{ value: '7', label: 'Base 7 dias' }, { value: '15', label: '15 dias' }, { value: '30', label: '30 dias' }, { value: '60', label: '60 dias' }]} />
        <select className="input" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} /> Só o que precisa repor</label>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : data && (
        <>
          <details className="notice"><summary>Como a sugestão é calculada</summary><ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{data.assumptions.map((s: string) => <li key={s}>{s}</li>)}</ul></details>
          <div className="card flush">
            {!items.length ? <Empty>Nenhum produto precisa de reposição pelos critérios atuais.</Empty> : (
              <table className="table responsive">
                <thead><tr><th>Produto</th><th className="r">Estoque</th><th className="r">Média/dia</th><th className="r">Cobertura</th><th className="r">Comprar</th><th>Por quê</th></tr></thead>
                <tbody>
                  {items.map((i: any) => (
                    <tr key={i.productId}>
                      <td data-label="Produto"><b>{i.name}</b><div className="faint">{i.category}</div></td>
                      <td data-label="Estoque" className="r num">{qty(i.stockMilli, i.unit)}</td>
                      <td data-label="Média/dia" className="r num">{i.historyDays ? avgQty(i.avgDailyMilli, i.unit) : '—'}</td>
                      <td data-label="Cobertura" className="r num">{i.coverageDays == null ? '—' : `${String(i.coverageDays).replace('.', ',')} dias`}</td>
                      <td data-label="Comprar" className="r">
                        <input className="input num" style={{ width: 90, height: 34, textAlign: 'right' }} inputMode="decimal" aria-label={`Quantidade a comprar de ${i.name} (${i.unit})`}
                          value={adjust[i.productId] ?? String(i.suggestedMilli / 1000).replace('.', ',')}
                          onChange={(e) => setAdjust({ ...adjust, [i.productId]: e.target.value })} />
                        <div className="faint">{isFractional(i.unit) ? i.unit : i.unit === 'PCT' ? 'pct' : 'un'}</div>
                      </td>
                      <td data-label="Por quê" className="faint" style={{ maxWidth: 280 }}>{i.reasons.join(' ') || '—'}{i.limitedHistory && <span className="badge warning" style={{ marginLeft: 6 }}>estimativa limitada</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {est > 0 && <div className="muted">Custo estimado da lista (produtos com custo cadastrado): <b className="num">{money(est)}</b></div>}
          <div className="faint">A lista é apenas uma sugestão: nenhum pedido é feito automaticamente. Ajustes feitos aqui não são salvos.</div>
        </>
      )}
    </div>
  );
}
