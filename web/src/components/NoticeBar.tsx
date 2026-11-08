import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { useSession } from './session';

const KEY = 'pdv.notices.closed';
const closedIds = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };

/** Avisos do Central.PDV (manutenção, vencimento, novidades) no topo do sistema. Cada um pode ser fechado neste aparelho. */
export function NoticeBar() {
  const { data } = useApi<any[]>('/notices');
  const { user } = useSession();
  const [closed, setClosed] = useState(closedIds);
  const close = (id: string) => {
    const next = [...closed, id].slice(-100);
    setClosed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* armazenamento bloqueado */ }
  };
  const list = (data ?? []).filter((n) => !closed.includes(String(n.id)));
  if (!list.length) return null;
  const admin = user?.role === 'ADMIN';
  return <>{list.map((n) => (
    <div key={n.id} className={`notice-bar ${n.kind}`} role="status">
      <div className="msg"><b>{n.title}</b> {n.message}
        {n.action && (!n.action.adminOnly || admin) && <a className="notice-action" href={n.action.href}>{n.action.label} →</a>}
        {n.action?.adminOnly && admin && <a className="notice-howto" href="/media/como-assinar-7e4606f570.mp4" target="_blank" rel="noopener">Ver como assinar (vídeo de 1 min)</a>}
        {n.action?.adminOnly && !admin && <span className="notice-hint"> Avise o administrador para assinar.</span>}
      </div>
      <button aria-label="Fechar aviso" onClick={() => close(String(n.id))}>×</button>
    </div>
  ))}</>;
}
