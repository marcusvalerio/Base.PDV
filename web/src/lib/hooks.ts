import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Carrega dados de uma rota GET com estados de carregamento e erro. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const ctrl = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(null);
    try {
      const d = await api<T>(path, { signal: c.signal });
      if (!c.signal.aborted) setData(d);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e.message);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { load(); return () => ctrl.current?.abort(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Executa uma ação uma única vez por vez (evita cliques duplos). */
export function useAction<A extends any[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try { return await fn(...a); } finally { running.current = false; setBusy(false); }
  }, [fn]);
  return [run, busy] as const;
}

export function useDebounced<T>(v: T, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
