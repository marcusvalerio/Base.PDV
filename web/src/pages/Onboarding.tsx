import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../components/session';
import { Field } from '../components/ui';
import { SystemFooter } from '../components/SystemFooter';
import { ShareButtons } from '../components/ShareButtons';
import { api } from '../lib/api';
import { easyPassword, suggestLogin } from './admin/Admin';

const SKIP_KEY = 'pdv:onboarding-skip';
export const onboardingSkipped = () => { try { return sessionStorage.getItem(SKIP_KEY) === '1'; } catch { return false; } };

export type BusinessType = 'bar' | 'mercearia' | 'deposito' | 'lanchonete';
export const BUSINESS: { key: BusinessType; label: string; hint: string }[] = [
  { key: 'bar', label: 'Bar', hint: 'Mesas, chopp e porções' },
  { key: 'mercearia', label: 'Mercearia', hint: 'Mercearia, fiado e bebidas' },
  { key: 'deposito', label: 'Depósito de bebidas', hint: 'Cervejas, refrigerantes e gelo' },
  { key: 'lanchonete', label: 'Lanchonete', hint: 'Lanches, salgados e bebidas' },
];

const STEPS = ['Seu negócio', 'Segurança', 'Equipe', 'Pronto'];

/**
 * Primeiro acesso do administrador, em quatro passos curtos: quem é e o que é o negócio, os códigos
 * que protegem o caixa, o primeiro atendente e o caminho para a primeira venda. Os produtos ficam
 * para Administração › Produtos (com o catálogo pronto). Cada passo salva ao continuar; dá para pular.
 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const { user, boot, refreshBoot } = useSession();
  const [step, setStep] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 1. negócio
  const [owner, setOwner] = useState(user?.name ?? '');
  const [store, setStore] = useState(boot?.storeName ?? '');
  const [type, setType] = useState<BusinessType | ''>((boot?.onboarding?.businessType as BusinessType) || '');
  // 2. segurança
  const [needCash, setNeedCash] = useState(false);
  const [hasCancel, setHasCancel] = useState(!!boot?.onboarding?.cancelCode);
  const [cashCode, setCashCode] = useState('');
  const [cancelCode, setCancelCode] = useState('');
  // 3. equipe
  const [mate, setMate] = useState('');
  const [mateLogin, setMateLogin] = useState('');
  const [mateTouched, setMateTouched] = useState(false);
  const [matePass] = useState(easyPassword);
  const [mateCreated, setMateCreated] = useState(false);
  const [matePhone, setMatePhone] = useState('');

  useEffect(() => {
    api<any>('/settings').then((s) => { setNeedCash(s.cash_code_mode === 'SHARED' && !s.shared_cash_code_configured); setHasCancel(!!s.cancel_code_configured); }).catch(() => {});
  }, []);
  const existing = boot?.onboarding?.products ?? 0;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));

  const saveBusiness = () => run(async () => {
    if (owner.trim().length < 2) throw new Error('Informe o seu nome.');
    if (!store.trim()) throw new Error('Informe o nome do estabelecimento.');
    if (!type) throw new Error('Escolha o tipo do seu negócio.');
    if (owner.trim() !== user?.name) await api(`/users/${user!.id}`, { method: 'PATCH', body: { name: owner.trim() } });
    await api('/settings', { method: 'PUT', body: { store_name: store.trim(), business_type: type } });
    next();
  });
  const saveSecurity = () => run(async () => {
    if (needCash && !/^\d{4,8}$/.test(cashCode)) throw new Error('O código do caixa deve ter de 4 a 8 números.');
    if (!hasCancel && !/^\d{4,8}$/.test(cancelCode)) throw new Error('O código de cancelamento deve ter de 4 a 8 números.');
    if (needCash && cancelCode && cashCode === cancelCode) throw new Error('Use códigos diferentes para o caixa e para cancelamentos.');
    if (needCash) { await api('/settings/cash-code', { method: 'PUT', body: { code: cashCode } }); setNeedCash(false); }
    if (!hasCancel) { await api('/settings/cancel-code', { method: 'PUT', body: { code: cancelCode } }); setHasCancel(true); }
    next();
  });
  const saveMate = () => run(async () => {
    if (mate.trim().length < 2) throw new Error('Informe o nome do atendente.');
    await api('/users', { body: { name: mate.trim(), username: mateLogin, password: matePass, role: 'OPERADOR' } });
    setMateCreated(true);
  });
  const finish = (to?: string) => run(async () => {
    await api('/settings', { method: 'PUT', body: { onboarding_done: '1' } });
    await refreshBoot();
    if (to) window.location.href = to; else onDone();
  });
  const skipAll = () => {
    try { sessionStorage.setItem(SKIP_KEY, '1'); } catch { /* sem armazenamento */ }
    api('/settings', { method: 'PUT', body: { onboarding_done: '1' } }).catch(() => {}).finally(() => { refreshBoot().catch(() => {}); onDone(); });
  };

  const mateText = `Olá, ${mate.trim().split(' ')[0]}! Seu acesso ao caixa no Central.PDV (*${store.trim() || 'seu estabelecimento'}*):\n\nEndereço: ${location.origin}/app\nLogin: *${mateLogin}*\nSenha: *${matePass}*\n\nGuarde com você e não compartilhe.`;

  return (
    <div className="login onboarding">
      <div className="card stack onb-card">
        <div>
          <div className="onb-progress" aria-label={`Passo ${step + 1} de ${STEPS.length}`}>
            {STEPS.map((s, i) => <span key={s} data-on={i <= step || undefined} />)}
          </div>
          <div className="onb-step">Passo {step + 1} de {STEPS.length} · {STEPS[step]}</div>
        </div>

        {step === 0 && <>
          <div><h1>Bem-vindo ao Central.PDV{owner.trim() ? `, ${owner.trim().split(' ')[0]}` : ''}</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>Em poucos minutos o seu caixa fica pronto para vender. Dá para mudar tudo depois.</p></div>
          <Field label="Seu nome"><input className="input lg" value={owner} maxLength={80} onChange={(e) => setOwner(e.target.value)} autoFocus /></Field>
          <Field label="Nome do estabelecimento"><input className="input lg" placeholder="Ex.: Bar do Zé" maxLength={60} value={store} onChange={(e) => setStore(e.target.value)} /></Field>
          <div className="stack" style={{ gap: 8 }}>
            <b>O que é o seu negócio?</b>
            <div className="onb-types">
              {BUSINESS.map((b) => (
                <button key={b.key} type="button" className="onb-type" data-on={type === b.key || undefined} onClick={() => setType(b.key)}>
                  <b>{b.label}</b><span className="faint">{b.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </>}

        {step === 1 && <>
          <div><h1>Proteja o seu caixa</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>Dois códigos de números que só você e quem você confiar vão saber.</p></div>
          {needCash && <Field label="Código para abrir e fechar o caixa" hint="De 4 a 8 números. A equipe usa no começo e no fim do turno.">
            <input className="input lg num" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={cashCode} onChange={(e) => setCashCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </Field>}
          {!hasCancel && <Field label="Código de cancelamento" hint="Pedido para cancelar uma venda ou tirar um item da mesa. Guarde só para você ou para o gerente.">
            <input className="input lg num" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={cancelCode} onChange={(e) => setCancelCode(e.target.value.replace(/\D/g, ''))} autoFocus={!needCash} />
          </Field>}
          {!needCash && hasCancel && <div className="notice success">Os códigos já estão configurados. Você pode trocar em Configurações.</div>}
          <div className="notice">Depois de 5 tentativas erradas, o código fica bloqueado por 15 minutos para aquele usuário.</div>
        </>}

        {step === 2 && <>
          <div><h1>Sua equipe</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>Cada atendente com o próprio login: você sabe quem vendeu o quê, e ninguém usa a sua senha no caixa.</p></div>
          {!mateCreated ? <>
            <Field label="Nome do atendente"><input className="input lg" placeholder="Ex.: Carla Souza" value={mate} maxLength={80} onChange={(e) => { setMate(e.target.value); if (!mateTouched) setMateLogin(suggestLogin(e.target.value)); }} autoFocus /></Field>
            <Field label="Login" hint="Sugerido a partir do nome. Precisa ser único no Central.PDV."><input className="input" autoCapitalize="none" value={mateLogin} onChange={(e) => { setMateTouched(true); setMateLogin(e.target.value.toLowerCase()); }} /></Field>
            <div className="faint">Senha gerada: <b className="num">{matePass}</b> (fácil de digitar; a pessoa pode trocar depois).</div>
          </> : <>
            <div className="notice success">Acesso de {mate.trim().split(' ')[0]} criado. Envie para a pessoa:</div>
            <pre className="statement">{mateText.replace(/\*/g, '')}</pre>
            <Field label="Celular do atendente (opcional)" hint="Para abrir o WhatsApp direto na conversa."><input className="input" inputMode="tel" placeholder="(11) 98765-4321" value={matePhone} onChange={(e) => setMatePhone(e.target.value)} /></Field>
            <ShareButtons title="Acesso ao Central.PDV" text={mateText} phone={matePhone} />
          </>}
        </>}

        {step === 3 && <>
          <div><h1>Tudo pronto para vender</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>Abra o caixa com o código que você criou e faça a primeira venda.</p></div>
          <div className="card flush">
            <div className="list-item"><span className="badge success" aria-label="feito" /><span>{store.trim() || boot?.storeName}</span></div>
            <div className="list-item"><span className="badge success" aria-label="feito" /><span>Códigos do caixa e de cancelamento</span></div>
            <div className="list-item"><span className={`badge ${existing ? 'success' : ''}`}>{existing ? '' : 'falta'}</span><span>{existing ? `${existing} produto(s) no cadastro` : 'Produtos: cadastre em Administração › Produtos (tem catálogo pronto)'}</span></div>
            <div className="list-item"><span className={`badge ${mateCreated ? 'success' : ''}`}>{mateCreated ? '' : 'falta'}</span><span>{mateCreated ? `Acesso de ${mate.trim().split(' ')[0]} criado` : 'Equipe: crie os acessos em Administração › Usuários'}</span></div>
          </div>
        </>}

        {err && <div className="notice danger" role="alert">{err}</div>}

        <div className="row">
          {step > 0 && step < 3 && <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep(step - 1)}>Voltar</button>}
          <span className="spacer" />
          {step === 0 && <button className="btn primary lg" disabled={busy} onClick={saveBusiness}>Continuar</button>}
          {step === 1 && <button className="btn primary lg" disabled={busy} onClick={saveSecurity}>Continuar</button>}
          {step === 2 && (mateCreated
            ? <button className="btn primary lg" onClick={next}>Continuar</button>
            : <>
              <button type="button" className="btn ghost" disabled={busy} onClick={next}>Fazer depois</button>
              <button className="btn primary lg" disabled={busy || mate.trim().length < 2 || mateLogin.length < 3} onClick={saveMate}>Criar acesso</button>
            </>)}
          {step === 3 && <>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => finish()}>Ir para o sistema</button>
            <button className="btn primary lg" disabled={busy} onClick={() => finish('/app/caixa')}>Abrir o caixa</button>
          </>}
        </div>
        {step < 3 && <button type="button" className="btn ghost sm block" onClick={skipAll}>Pular a configuração</button>}
      </div>
      <SystemFooter />
    </div>
  );
}
