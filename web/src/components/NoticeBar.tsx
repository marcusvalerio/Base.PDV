import { useState } from 'react';
import { useApi } from '../lib/hooks';

const KEY = 'pdv.notices.closed';
const closedIds = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };

/** Avisos do Central.PDV (manutenção, vencimento, novidades) no topo do sistema. Cada um pode ser fechado neste aparelho. */
export function NoticeBar() {
  const { data } = useApi<any[]>('/notices');
  const [closed, setClosed] = useState(closedIds);
  const close = (id: string) => {
    const next = [...closed, id].slice(-100);
    setClosed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* armazenamento bloqueado */ }
  };
  const list = (data ?? []).filter((n) => !closed.includes(String(n.id)));
  if (!list.length) return null;
  return <>{list.map((n) => (
    <div key={n.id} className={`notice-bar ${n.kind}`} role="status">
      <div className="msg"><b>{n.title}</b> {n.message}</div>
      <button aria-label="Fechar aviso" onClick={() => close(String(n.id))}>×</button>
    </div>
  ))}</>;
}
