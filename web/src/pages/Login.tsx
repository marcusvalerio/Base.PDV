import { FormEvent, useState } from 'react';
import { useSession } from '../components/session';
import { Field } from '../components/ui';

export default function Login() {
  const { login } = useSession();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try { await login(u, p); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <div><h1>Central PDV</h1><p className="muted" style={{ margin: '4px 0 8px' }}>Entre com a sua conta.</p></div>
        <Field label="Usuário"><input className="input lg" autoComplete="username" autoCapitalize="none" value={u} onChange={(e) => setU(e.target.value)} autoFocus required /></Field>
        <Field label="Senha"><input className="input lg" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></Field>
        {err && <div className="notice danger" role="alert">{err}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
