export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pdv' },
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor. Verifique a internet e tente novamente.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('pdv:unauthorized'));
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'Algo deu errado.');
  }
  return data as T;
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
