import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><span className="spacer" /><button className="btn ghost sm" onClick={onClose}>Fechar</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

type Toast = { id: number; text: string; kind?: 'success' | 'error' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind?: Toast['kind']) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

export const Loading = ({ label = 'Carregando…' }: { label?: string }) => <div className="center row muted"><div className="spinner" /> {label}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="notice danger row wrap"><span>{message}</span><span className="spacer" />{onRetry && <button className="btn sm" onClick={onRetry}>Tentar novamente</button>}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <label className="field">{label}{children}{hint && <span className="faint" style={{ fontWeight: 400 }}>{hint}</span>}</label>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return <div className="metric"><div className="label">{label}</div><div className="value num">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

export function Change({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="faint">sem base de comparação</span>;
  const s = `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
  return <span className={v >= 0 ? 'up' : 'down'}>{s} vs. período anterior</span>;
}
