import { useState } from 'react';
import { useApi, useDebounced } from '../lib/hooks';
import { money } from '../lib/format';
import { Loading, ErrorState, Empty, Segmented } from './ui';
import { useSession } from './session';
import { SaleModal } from './CancelSale';
import { downloadCsv, csvDate, csvMoney } from '../lib/csv';

const TZ = 'America/Sao_Paulo';
const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const dayName = (iso: string) => {
  const t = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit' }).format(new Date(iso));
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const hour = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const lastDay = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

const EMPTY = { preset: 'all', month: '', from: '', to: '', kind: '', categoryId: '', origin: '', status: '', userId: '', customer: '' };

/** Lista de vendas com filtros e divisão por dia (faixas alternando branco e cinza). */
export function SalesList({ admin = false, onChanged }: { admin?: boolean; onChanged?: () => void }) {
  const { boot } = useSession();
  const users = useApi<any[]>(admin ? '/users' : null);
  const [f, setF] = useState({ ...EMPTY, preset: admin ? '7d' : 'all' });
  const customer = useDebounced(f.customer, 300);
  const p: Record<string, string> = {};
  if (f.preset === 'pick') { if (f.month) Object.assign(p, { preset: 'custom', from: `${f.month}-01`, to: lastDay(f.month) }); }
  else if (f.preset === 'custom') { if (f.from && f.to) Object.assign(p, { preset: 'custom', from: f.from, to: f.to }); }
  else p.preset = f.preset;
  for (const k of ['kind', 'categoryId', 'origin', 'status', 'userId'] as const) if (f[k]) p[k] = f[k];
  if (customer) p.customer = customer;
  const ready = !!p.preset;
  const { data, loading, error, reload } = useApi<any[]>(ready ? `/sales?${new URLSearchParams(p)}` : null);
  const [sel, setSel] = useState<number | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const active = JSON.stringify({ ...f, preset: '' }) !== JSON.stringify({ ...EMPTY, preset: '' });

  const days: { key: string; name: string; rows: any[] }[] = [];
  for (const s of data ?? []) {
    const k = dayKey(s.created_at);
    if (days[days.length - 1]?.key !== k) days.push({ key: k, name: dayName(s.created_at), rows: [] });
    days[days.length - 1].rows.push(s);
  }
  const total = (rows: any[]) => rows.reduce((a, s) => a + (s.status === 'CANCELLED' ? 0 : s.total_cents), 0);
  const cols = admin ? 6 : 5;

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 10 }}>
        <Segmented value={f.preset} onChange={(preset) => setF({ ...f, preset })} options={[
          ...(admin ? [] : [{ value: 'all', label: 'Caixa todo' }]),
          { value: 'today', label: 'Hoje' }, { value: '7d', label: 'Semana' }, { value: '15d', label: 'Quinzena' }, { value: 'month', label: 'Mês atual' },
          { value: 'pick', label: 'Escolher mês' }, { value: 'custom', label: 'Personalizado' }, ...(admin ? [{ value: 'all', label: 'Tudo' }] : []),
        ]} />
        <div className="filters">
          {f.preset === 'pick' && <input className="input" type="month" value={f.month} onChange={set('month')} aria-label="Mês" />}
          {f.preset === 'custom' && <>
            <input className="input" type="date" value={f.from} onChange={set('from')} aria-label="Data inicial" />
            <input className="input" type="date" value={f.to} onChange={set('to')} aria-label="Data final" />
          </>}
          <select className="input" value={f.kind} onChange={set('kind')} aria-label="Forma de pagamento">
            <option value="">Todas as formas</option><option value="CASH">Dinheiro</option><option value="PIX">Pix</option><option value="CARD">Cartão</option><option value="CREDIT">A prazo (fiado)</option>
          </select>
          <select className="input" value={f.categoryId} onChange={set('categoryId')} aria-label="Categoria">
            <option value="">Todas as categorias</option>
            {boot?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input" value={f.origin} onChange={set('origin')} aria-label="Origem">
            <option value="">Balcão e mesas</option><option value="BALCAO">Só balcão</option><option value="MESA">Só mesas</option>
          </select>
          <select className="input" value={f.status} onChange={set('status')} aria-label="Situação">
            <option value="">Todas as situações</option><option value="COMPLETED">Concluídas</option><option value="CANCELLED">Canceladas</option>
          </select>
          {admin && <select className="input" value={f.userId} onChange={set('userId')} aria-label="Operador">
            <option value="">Todos os operadores</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>}
          <input className="input" placeholder="Cliente do fiado" value={f.customer} onChange={set('customer')} aria-label="Cliente" />
        </div>
        <div className="row wrap">
          {data && <span className="faint">{data.length}{data.length >= 500 ? '+' : ''} venda(s) · total {money(total(data))}</span>}
          {active && <button className="btn ghost sm" onClick={() => setF({ ...EMPTY, preset: f.preset })}>Limpar filtros</button>}
          <span className="spacer" />
          {!!data?.length && <button className="btn sm" onClick={() => downloadCsv('vendas', data, [['Nº', (s) => s.id], ['Data', (s) => csvDate(s.created_at)], ['Operador', (s) => s.user_name], ['Forma', (s) => s.payment_method], ['Cliente', (s) => s.customer_name], ['Origem', (s) => s.tab_label ?? 'Balcão'], ['Situação', (s) => (s.status === 'CANCELLED' ? 'Cancelada' : 'Concluída')], ['Acréscimo (R$)', (s) => csvMoney(s.surcharge_cents)], ['Total (R$)', (s) => csvMoney(s.total_cents)]])}>Exportar planilha</button>}
        </div>
      </div>
      {!ready ? <div className="faint">{f.preset === 'pick' ? 'Escolha o mês.' : 'Escolha as duas datas.'}</div>
        : error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush">{!data?.length ? <Empty>Nenhuma venda com esses filtros.</Empty> : (
          <table className="table responsive months">
            <thead><tr><th>Nº</th><th>Hora</th>{admin && <th>Operador</th>}<th>Forma</th><th>Origem</th><th className="r">Total</th></tr></thead>
            {days.map((d, i) => (
              <tbody key={d.key} className={i % 2 ? 'm-b' : 'm-a'}>
                <tr className="month-row"><td colSpan={cols}><b>{d.name}</b><span className="faint"> · {d.rows.length} venda(s) · {money(total(d.rows))}</span></td></tr>
                {d.rows.map((s) => (
                  <tr key={s.id} className="click" onClick={() => setSel(s.id)}>
                    <td data-label="Nº">{s.id}</td><td data-label="Hora">{hour(s.created_at)}</td>{admin && <td data-label="Operador">{s.user_name}</td>}
                    <td data-label="Forma">{s.payment_method}{s.customer_name ? ` · ${s.customer_name}` : ''}</td>
                    <td data-label="Origem">{s.tab_label ?? 'Balcão'}</td>
                    <td data-label="Total" className="r num">{s.status === 'CANCELLED' ? <span className="badge danger">cancelada</span> : money(s.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}</div>
      )}
      {sel && <SaleModal id={sel} onClose={() => setSel(null)} onChanged={() => { reload(); onChanged?.(); }} />}
    </div>
  );
}
