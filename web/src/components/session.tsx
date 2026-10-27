import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface User { id: number; name: string; username: string; role: 'ADMIN' | 'OPERADOR' }
export interface Access { ok: boolean; reason: 'OK' | 'SUSPENDED' | 'NO_SUBSCRIPTION' | 'UNPAID'; trialEndsAt: string | null }
export type ModuleKey = 'mesas' | 'fiado' | 'estoque' | 'inventario' | 'analise' | 'reposicao' | 'auditoria';
export interface Boot { modules: Record<ModuleKey, boolean>; paymentMethods: { code: string; name: string; kind: 'CASH' | 'PIX' | 'CARD' | 'CREDIT' }[]; categories: { id: number; name: string }[]; fiadoSurchargeCents: number; cardSurcharge?: Record<string, { mode: 'UNIT' | 'PERCENT'; value: number }>; cashCodeMode: string; storeName?: string; storeLogo?: string }

interface Ctx { user: User | null; boot: Boot | null; ready: boolean; access: Access | null; refreshAccess: () => Promise<void>; login: (u: string, p: string) => Promise<void>; logout: () => Promise<void>; refreshBoot: () => Promise<void> }
const SessionCtx = createContext<Ctx>(null as any);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);
  const refreshBoot = useCallback(async () => setBoot(await api<Boot>('/bootstrap')), []);
  const refreshAccess = useCallback(async () => { const r = await api<{ user: User; access: Access }>('/auth/me'); setAccess(r.access); }, []);
  useEffect(() => {
    api<{ user: User; access: Access }>('/auth/me').then(async (r) => { setUser(r.user); setAccess(r.access); await refreshBoot(); }).catch(() => {}).finally(() => setReady(true));
    const h = () => setUser(null);
    // Assinatura vencida ou estabelecimento suspenso: o servidor responde 402.
    const b = () => setAccess((a) => ({ ok: false, reason: a?.reason === 'OK' || !a ? 'UNPAID' : a.reason, trialEndsAt: null }));
    window.addEventListener('pdv:unauthorized', h);
    window.addEventListener('pdv:blocked', b);
    return () => { window.removeEventListener('pdv:unauthorized', h); window.removeEventListener('pdv:blocked', b); };
  }, [refreshBoot]);
  const login = async (username: string, password: string) => {
    const r = await api<{ user: User }>('/auth/login', { body: { username, password } });
    await refreshBoot();
    await refreshAccess();
    setUser(r.user);
  };
  const logout = async () => { await api('/auth/logout', { body: {} }).catch(() => {}); setUser(null); };
  return <SessionCtx.Provider value={{ user, boot, ready, access, refreshAccess, login, logout, refreshBoot }}>{children}</SessionCtx.Provider>;
}
