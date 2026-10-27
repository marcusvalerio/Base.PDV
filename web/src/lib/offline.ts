import { useEffect, useState } from 'react';

/**
 * Modo offline do caixa.
 * - Guarda no aparelho a última cópia de produtos, configurações, sessão e caixa aberto (para abrir sem internet).
 * - Vendas feitas sem internet entram numa fila e são enviadas sozinhas quando a conexão volta.
 *   A chave de idempotência garante que um reenvio nunca duplica a venda.
 * Fiado, mesas, cadastros, relatórios e fechamento de caixa continuam precisando de internet.
 */

const CACHE = 'pdv.cache.';
const OUTBOX = 'pdv.outbox';

/** Respostas GET guardadas para uso offline. */
const CACHEABLE = /^\/(bootstrap|auth\/me|cash\/current|products)$/;

export function cacheGet<T = any>(path: string): T | undefined {
  try { const v = localStorage.getItem(CACHE + path); return v ? JSON.parse(v) : undefined; } catch { return undefined; }
}
export function cachePut(path: string, data: unknown) {
  if (!CACHEABLE.test(path)) return;
  try { localStorage.setItem(CACHE + path, JSON.stringify(data)); } catch { /* armazenamento cheio ou bloqueado */ }
}
export function cacheClear() {
  try { Object.keys(localStorage).filter((k) => k.startsWith(CACHE)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignorar */ }
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Responde consultas de produtos com a cópia guardada (busca, categoria e código de barras). */
export function offlineAnswer(path: string): unknown | undefined {
  const [p, qs] = path.split('?');
  if (CACHEABLE.test(p)) return cacheGet(p);
  const list = cacheGet<any[]>('/products');
  if (!list) return undefined;
  if (p.startsWith('/products/by-code/')) {
    const code = decodeURIComponent(p.slice('/products/by-code/'.length));
    return list.find((x) => x.barcode === code || x.internal_code === code);
  }
  if (p === '/products') {
    const q = new URLSearchParams(qs);
    const term = norm(q.get('q') ?? '');
    const cat = Number(q.get('categoryId') ?? 0);
    return list.filter((x) => (!cat || x.category_id === cat) && (!term || norm(x.name).includes(term) || x.barcode === term || x.internal_code === term));
  }
  return undefined;
}

// ---------- Fila de vendas offline ----------

export interface QueuedSale {
  key: string; userId: number; body: any; at: string; totalCents: number; label: string; error?: string;
}

function read(): QueuedSale[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; }
}
function write(list: QueuedSale[]) {
  try { localStorage.setItem(OUTBOX, JSON.stringify(list)); } catch { /* ignorar */ }
  window.dispatchEvent(new Event('pdv:outbox'));
}

export const queued = read;

export function enqueueSale(s: QueuedSale) { write([...read().filter((x) => x.key !== s.key), s]); }
export function discardSale(key: string) { write(read().filter((x) => x.key !== key)); }

let syncing = false;

/**
 * Envia a fila do usuário atual. Para no primeiro erro de rede (tenta de novo depois).
 * Recusa definitiva do servidor (ex.: caixa fechado) fica marcada para a pessoa ver e decidir.
 */
export async function syncOutbox(userId: number | undefined, post: (body: any) => Promise<unknown>): Promise<number> {
  if (syncing || !userId || !navigator.onLine) return 0;
  syncing = true;
  let sent = 0;
  try {
    for (const item of read().filter((x) => x.userId === userId && !x.error)) {
      try {
        await post({ ...item.body, idempotencyKey: item.key, offlineAt: item.at });
        write(read().filter((x) => x.key !== item.key));
        sent++;
      } catch (e: any) {
        if (e?.code === 'NETWORK' || !e?.status || e.status >= 500 || e.status === 401 || e.status === 402 || e.status === 429) break;
        write(read().map((x) => (x.key === item.key ? { ...x, error: e.message } : x)));
      }
    }
  } finally { syncing = false; }
  return sent;
}

export function retrySale(key: string) { write(read().map((x) => (x.key === key ? { ...x, error: undefined } : x))); }

/** Estado da conexão e da fila, para a barra do topo e o caixa. */
export function useOffline(userId?: number) {
  const [online, setOnline] = useState(navigator.onLine);
  const [list, setList] = useState(read);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false), upd = () => setList(read());
    addEventListener('online', on); addEventListener('offline', off);
    addEventListener('pdv:outbox', upd); addEventListener('storage', upd);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); removeEventListener('pdv:outbox', upd); removeEventListener('storage', upd); };
  }, []);
  const mine = list.filter((x) => !userId || x.userId === userId);
  return { online, pending: mine.filter((x) => !x.error), failed: mine.filter((x) => x.error) };
}
