import { FormEvent, useEffect, useState } from 'react';
import { useSession } from '../components/session';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { SystemFooter } from '../components/SystemFooter';

export default function Login() {
  const { login } = useSession();
  return <LoginForm login={login} />;
}

function LoginForm({ login }: { login: (u: string, p: string) => Promise<void> }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [store, setStore] = useState('');
  const [logo, setLogo] = useState('');
  useEffect(() => { api<{ storeName: string; storeLogo: string }>('/public/info').then((r) => { setStore(r.storeName); setLogo(r.storeLogo); }).catch(() => {}); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try { await login(u, p); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        {logo && <img className="login-logo" src={logo} alt="" />}<div><h1>{store || <>Central<span className="brand-dot">.</span>PDV</>}</h1><p className="muted" style={{ margin: '4px 0 8px' }}>Entre com a sua conta.</p></div>
        <Field label="Usuário"><input className="input lg" autoComplete="username" autoCapitalize="none" value={u} onChange={(e) => setU(e.target.value)} autoFocus required /></Field>
        <Field label="Senha"><input className="input lg" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></Field>
        {err && <div className="notice danger" role="alert">{err}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
      <SystemFooter />
    </div>
  );
}
