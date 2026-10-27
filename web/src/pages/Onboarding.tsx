import { FormEvent, useEffect, useState } from 'react';
import { useSession } from '../components/session';
import { Field } from '../components/ui';
import { SystemFooter } from '../components/SystemFooter';
import { api } from '../lib/api';

const SKIP_KEY = 'pdv:onboarding-skip';
export const onboardingSkipped = () => { try { return sessionStorage.getItem(SKIP_KEY) === '1'; } catch { return false; } };

/** Primeiro acesso do administrador: nome do estabelecimento e código do caixa. Depois vai direto para o sistema. */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const { user, refreshBoot } = useSession();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<any>('/settings').then((s) => setNeedCode(s.cash_code_mode === 'SHARED' && !s.shared_cash_code_configured)).catch(() => {}); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (needCode && !/^\d{4,8}$/.test(code)) return setErr('O código do caixa deve ter de 4 a 8 números.');
    setBusy(true); setErr(null);
    try {
      await api('/settings', { method: 'PUT', body: { store_name: name.trim() } });
      if (needCode) await api('/settings/cash-code', { method: 'PUT', body: { code } });
      await refreshBoot();
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const skip = () => { try { sessionStorage.setItem(SKIP_KEY, '1'); } catch { /* sem armazenamento */ } onDone(); };
  return (
    <div className="login onboarding">
      <form className="card stack" onSubmit={submit}>
        <div>
          <div className="onb-step">Bem-vindo{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</div>
          <h1>Vamos deixar o sistema com a sua cara</h1>
          <p className="muted" style={{ margin: '6px 0 4px' }}>Leva menos de um minuto. Dá para mudar depois em Configurações.</p>
        </div>
        <Field label="Nome do estabelecimento">
          <input className="input lg" placeholder="Ex.: Bar do Zé" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </Field>
        {needCode && <Field label="Código para abrir o caixa" hint="De 4 a 8 números. A equipe usa para abrir e fechar o caixa.">
          <input className="input lg num" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
        </Field>}
        {err && <div className="notice danger" role="alert">{err}</div>}
        <button className="btn primary lg block" disabled={busy || !name.trim()}>{busy ? 'Salvando…' : 'Começar a vender'}</button>
        <button type="button" className="btn ghost block" onClick={skip}>Fazer depois</button>
      </form>
      <SystemFooter />
    </div>
  );
}
