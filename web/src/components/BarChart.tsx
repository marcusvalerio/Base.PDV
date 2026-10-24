import { money, date } from '../lib/format';

/** Gráfico de barras diário simples (SVG), legível em telas pequenas. */
export function DailyChart({ data }: { data: { day: string; revenueCents: number; salesCount: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.revenueCents));
  const w = 100 / data.length;
  const showEvery = Math.ceil(data.length / 8);
  return (
    <div>
      <svg viewBox="0 0 100 44" preserveAspectRatio="none" style={{ width: '100%', height: 180, display: 'block' }} role="img" aria-label="Faturamento por dia">
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2="100" y1={40 - g * 38} y2={40 - g * 38} stroke="var(--border)" strokeWidth="0.15" />)}
        {data.map((d, i) => {
          const h = (d.revenueCents / max) * 38;
          return (
            <rect key={d.day} x={i * w + w * 0.15} y={40 - h} width={w * 0.7} height={Math.max(h, d.revenueCents ? 0.4 : 0)} rx="0.4" fill="var(--accent)">
              <title>{`${date(d.day)}: ${money(d.revenueCents)} · ${d.salesCount} venda(s)`}</title>
            </rect>
          );
        })}
        <line x1="0" x2="100" y1="40" y2="40" stroke="var(--border-strong)" strokeWidth="0.2" />
      </svg>
      <div className="row faint" style={{ justifyContent: 'space-between', fontSize: 11 }}>
        {data.filter((_, i) => i % showEvery === 0).map((d) => <span key={d.day}>{date(d.day).slice(0, 5)}</span>)}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>Maior dia: {money(max)}</div>
    </div>
  );
}
