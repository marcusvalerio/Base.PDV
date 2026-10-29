import { FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { Field } from '../components/ui';
import { SystemFooter } from '../components/SystemFooter';
import { suggestLogin } from './admin/Admin';

/** Contratar pelo site: cria o estabelecimento e a conta do administrador e leva para o pagamento. */
export default function Signup() {
  const [f, setF] = useState({ storeName: '', name: '', phone: '', username: '', password: '' });
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await api('/signup', { body: f });
      window.location.href = '/app/admin/assinatura';
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card stack" style={{ maxWidth: 460 }} onSubmit={submit}>
        <div>
          <span className="central-tag">Contratar o Central.PDV</span>
          <h1 style={{ margin: '10px 0 4px' }}>Seu estabelecimento no sistema hoje</h1>
          <p className="muted" style={{ margin: 0 }}>Adesão de <b>R$ 250,00</b> (instalação + 1º mês) e depois <b>R$ 80,00 por mês</b>. Cancele quando quiser.</p>
        </div>
        <Field label="Nome do estabelecimento"><input className="input lg" value={f.storeName} onChange={set('storeName')} placeholder="Ex.: Bar do Zé" required autoFocus /></Field>
        <Field label="Seu nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, username: touched ? f.username : suggestLogin(e.target.value) })} required /></Field>
        <Field label="Celular (WhatsApp)"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="(11) 98765-4321" required /></Field>
        <div className="grid2">
          <Field label="Login" hint="Ex.: nome.sobrenome"><input className="input" autoCapitalize="none" value={f.username} onChange={(e) => { setTouched(true); setF({ ...f, username: e.target.value.toLowerCase() }); }} required /></Field>
          <Field label="Senha" hint="Mín. 8 caracteres"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /></Field>
        </div>
        {err && <div className="notice danger" role="alert">{err}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Criando…' : 'Criar e ir para o pagamento'}</button>
        <div className="faint" style={{ textAlign: 'center' }}>Já tem conta? <a href="/app">Entrar</a> · <a href="/termos">Termos e privacidade</a></div>
      </form>
      <SystemFooter />
    </div>
  );
}
