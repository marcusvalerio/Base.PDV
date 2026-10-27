import { FormEvent, useEffect, useState } from 'react';
import { useSession } from '../components/session';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { SystemFooter } from '../components/SystemFooter';

export default function Login() {
  const { login } = useSession();
  const [setup, setSetup] = useState<{ needed: boolean; enabled: boolean } | null>(null);
  useEffect(() => { api('/setup/status').then(setSetup).catch(() => setSetup({ needed: false, enabled: false })); }, []);
  if (setup?.needed) return <Setup enabled={setup.enabled} onDone={() => setSetup({ needed: false, enabled: true })} />;
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

/** Primeiro acesso: cria o super administrador usando o SETUP_TOKEN configurado no servidor. */
function Setup({ enabled, onDone }: { enabled: boolean; onDone: () => void }) {
  const [f, setF] = useState({ token: '', name: '', username: '', password: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setErr('As senhas não conferem.');
    setBusy(true); setErr(null);
    try { await api('/setup', { body: { token: f.token, name: f.name, username: f.username, password: f.password } }); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <div><h1>Configuração inicial</h1><p className="muted" style={{ margin: '4px 0 8px' }}>Crie a conta do super administrador (dono).</p></div>
        {!enabled ? <div className="notice warning">Defina a variável <b>SETUP_TOKEN</b> no servidor (Vercel) e recarregue a página.</div> : <>
          <Field label="Token de configuração" hint="O valor de SETUP_TOKEN definido na Vercel."><input className="input" type="password" value={f.token} onChange={set('token')} required /></Field>
          <Field label="Nome"><input className="input" value={f.name} onChange={set('name')} required /></Field>
          <Field label="Usuário (login)"><input className="input" autoCapitalize="none" value={f.username} onChange={set('username')} required /></Field>
          <Field label="Senha (mín. 8 caracteres)"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /></Field>
          <Field label="Confirmar senha"><input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required /></Field>
          {err && <div className="notice danger" role="alert">{err}</div>}
          <button className="btn primary lg block" disabled={busy}>{busy ? 'Criando…' : 'Criar super administrador'}</button>
        </>}
      </form>
    </div>
  );
}
