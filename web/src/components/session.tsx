import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface User { id: number; name: string; username: string; role: 'ADMIN' | 'OPERADOR' }
export interface Boot { paymentMethods: { code: string; name: string; kind: 'CASH' | 'PIX' | 'CARD' | 'CREDIT' }[]; categories: { id: number; name: string }[]; fiadoSurchargeCents: number; cashCodeMode: string }

interface Ctx { user: User | null; boot: Boot | null; ready: boolean; login: (u: string, p: string) => Promise<void>; logout: () => Promise<void>; refreshBoot: () => Promise<void> }
const SessionCtx = createContext<Ctx>(null as any);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [ready, setReady] = useState(false);
  const refreshBoot = useCallback(async () => setBoot(await api<Boot>('/bootstrap')), []);
  useEffect(() => {
    api<{ user: User }>('/auth/me').then(async (r) => { setUser(r.user); await refreshBoot(); }).catch(() => {}).finally(() => setReady(true));
    const h = () => setUser(null);
    window.addEventListener('pdv:unauthorized', h);
    return () => window.removeEventListener('pdv:unauthorized', h);
  }, [refreshBoot]);
  const login = async (username: string, password: string) => {
    const r = await api<{ user: User }>('/auth/login', { body: { username, password } });
    await refreshBoot();
    setUser(r.user);
  };
  const logout = async () => { await api('/auth/logout', { body: {} }).catch(() => {}); setUser(null); };
  return <SessionCtx.Provider value={{ user, boot, ready, login, logout, refreshBoot }}>{children}</SessionCtx.Provider>;
}
