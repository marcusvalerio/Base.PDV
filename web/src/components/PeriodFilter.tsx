import { Segmented } from './ui';
import { useSession } from './session';

export type PeriodState = { preset: string; from: string; to: string; categoryId: string };
export const PRESETS = [
  { value: 'today', label: 'Hoje' }, { value: '7d', label: '7 dias' }, { value: '15d', label: '15 dias' },
  { value: '30d', label: '30 dias' }, { value: 'month', label: 'Mês atual' }, { value: 'custom', label: 'Personalizado' },
];

export function PeriodFilter({ value, onChange, showCategory = true }: { value: PeriodState; onChange: (v: PeriodState) => void; showCategory?: boolean }) {
  const { boot } = useSession();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Segmented value={value.preset} options={PRESETS} onChange={(preset) => onChange({ ...value, preset })} />
      <div className="row wrap">
        {value.preset === 'custom' && <>
          <input className="input" style={{ width: 'auto' }} type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="Data inicial" />
          <span className="faint">até</span>
          <input className="input" style={{ width: 'auto' }} type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="Data final" />
        </>}
        {showCategory && (
          <select className="input" style={{ width: 'auto', minWidth: 180 }} value={value.categoryId} onChange={(e) => onChange({ ...value, categoryId: e.target.value })} aria-label="Categoria">
            <option value="">Todas as categorias</option>
            {boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

export function periodQuery(v: PeriodState, extra: Record<string, string> = {}) {
  const p: Record<string, string> = { preset: v.preset, ...extra };
  if (v.preset === 'custom') { if (!v.from || !v.to) return null; p.from = v.from; p.to = v.to; }
  if (v.categoryId) p.categoryId = v.categoryId;
  return new URLSearchParams(p).toString();
}
