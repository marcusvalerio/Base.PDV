import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../components/session';
import { Field } from '../components/ui';
import { SystemFooter } from '../components/SystemFooter';
import { ProductArt } from '../components/ProductArt';
import { ShareButtons } from '../components/ShareButtons';
import { api } from '../lib/api';
import { parseMoney } from '../lib/format';
import { CATALOG, type CatalogItem } from '../lib/catalog';
import { easyPassword, suggestLogin } from './admin/Admin';

const SKIP_KEY = 'pdv:onboarding-skip';
export const onboardingSkipped = () => { try { return sessionStorage.getItem(SKIP_KEY) === '1'; } catch { return false; } };

export type BusinessType = 'bar' | 'mercearia' | 'deposito' | 'lanchonete';
const A_TYPE: Record<BusinessType, string> = { bar: 'um bar', mercearia: 'uma mercearia', deposito: 'um depósito de bebidas', lanchonete: 'uma lanchonete' };
export const BUSINESS: { key: BusinessType; label: string; hint: string }[] = [
  { key: 'bar', label: 'Bar', hint: 'Mesas, chopp e porções' },
  { key: 'mercearia', label: 'Mercearia', hint: 'Mercearia, fiado e bebidas' },
  { key: 'deposito', label: 'Depósito de bebidas', hint: 'Cervejas, refrigerantes e gelo' },
  { key: 'lanchonete', label: 'Lanchonete', hint: 'Lanches, salgados e bebidas' },
];

/** O que cada tipo de negócio costuma vender: estas categorias do catálogo já vêm marcadas. */
const PICKS: Record<BusinessType, string[]> = {
  bar: ['Cervejas', 'Chopp', 'Refrigerantes', 'Bebidas em geral', 'Alimentos'],
  mercearia: ['Mercearia', 'Biscoitos', 'Refrigerantes', 'Bebidas em geral', 'Cervejas'],
  deposito: ['Cervejas', 'Refrigerantes', 'Bebidas em geral'],
  lanchonete: ['Alimentos', 'Refrigerantes', 'Bebidas em geral', 'Biscoitos'],
};
/** Itens que não combinam com o tipo, mesmo dentro de uma categoria marcada. */
const UNLESS: Record<BusinessType, string[]> = {
  bar: ['Bala', 'Chocolate (barra)'],
  mercearia: ['Porção de Fritas', 'Cachorro-quente', 'Dose de Cachaça'],
  deposito: ['Dose de Cachaça', 'Suco de Caixinha'],
  lanchonete: ['Dose de Cachaça'],
};
const recommended = (type: BusinessType, c: CatalogItem) => PICKS[type].includes(c.category) && !UNLESS[type].includes(c.name);
const price = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

const STEPS = ['Seu negócio', 'Segurança', 'Produtos', 'Equipe', 'Pronto'];

/**
 * Primeiro acesso do administrador, em cinco passos curtos: quem é e o que vende, os códigos que
 * protegem o caixa, os produtos (do catálogo pronto, já filtrado pelo tipo de negócio), o primeiro
 * atendente e o caminho para a primeira venda. Cada passo salva ao continuar; dá para pular.
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
  // 3. produtos
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(CATALOG.map((c) => [c.name, price(c.price_cents)])));
  const [added, setAdded] = useState(0);
  // 4. equipe
  const [mate, setMate] = useState('');
  const [mateLogin, setMateLogin] = useState('');
  const [mateTouched, setMateTouched] = useState(false);
  const [matePass] = useState(easyPassword);
  const [mateCreated, setMateCreated] = useState(false);
  const [matePhone, setMatePhone] = useState('');

  useEffect(() => {
    api<any>('/settings').then((s) => { setNeedCash(s.cash_code_mode === 'SHARED' && !s.shared_cash_code_configured); setHasCancel(!!s.cancel_code_configured); }).catch(() => {});
  }, []);
  // Ao escolher o tipo, marca o que esse negócio costuma vender
  useEffect(() => { if (type && !(boot?.onboarding?.products)) setSel(Object.fromEntries(CATALOG.map((c) => [c.name, recommended(type, c)]))); }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const existing = boot?.onboarding?.products ?? 0;
  const chosen = useMemo(() => CATALOG.filter((c) => sel[c.name]), [sel]);
  const groups = useMemo(() => {
    const cats = [...new Set(CATALOG.map((c) => c.category))];
    return type ? [...PICKS[type].filter((g) => cats.includes(g)), ...cats.filter((g) => !PICKS[type].includes(g))] : cats;
  }, [type]);

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
  const saveProducts = () => run(async () => {
    if (!chosen.length) return next();
    const bad = chosen.find((c) => parseMoney(prices[c.name]) == null);
    if (bad) throw new Error(`Preço inválido em ${bad.name}.`);
    const r = await api<{ created: number }>('/products/bulk', { body: { items: chosen.map((c) => ({ name: c.name, category: c.category, unit: c.unit, price_cents: parseMoney(prices[c.name]), image_url: `art:${c.art}` })) } });
    setAdded(r.created);
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
          <div><h1>Seus produtos</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>{existing ? `Você já tem ${existing} produto(s). Quer acrescentar algum do catálogo pronto?` : `Já marcamos o que ${type ? A_TYPE[type] : 'um negócio como o seu'} costuma vender. Ajuste os preços e desmarque o que não vende.`}</p></div>
          <div className="onb-catalog">
            {groups.map((g) => (
              <div key={g} className="stack" style={{ gap: 4 }}>
                <div className="row"><b>{g}</b><span className="spacer" />
                  <button type="button" className="btn ghost sm" onClick={() => { const all = CATALOG.filter((c) => c.category === g).every((c) => sel[c.name]); setSel({ ...sel, ...Object.fromEntries(CATALOG.filter((c) => c.category === g).map((c) => [c.name, !all])) }); }}>
                    {CATALOG.filter((c) => c.category === g).every((c) => sel[c.name]) ? 'Desmarcar' : 'Marcar todos'}
                  </button></div>
                <div className="card flush">
                  {CATALOG.filter((c) => c.category === g).map((c) => (
                    <label key={c.name} className="list-item" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" style={{ width: 20, height: 20 }} checked={!!sel[c.name]} onChange={(e) => setSel({ ...sel, [c.name]: e.target.checked })} />
                      <ProductArt size="sm" image={`art:${c.art}`} name={c.name} />
                      <span>{c.name}</span><span className="spacer" />
                      <span className="faint">R$</span>
                      <input className="input num" style={{ width: 86, height: 34, textAlign: 'right' }} inputMode="decimal" value={prices[c.name]} onChange={(e) => setPrices({ ...prices, [c.name]: e.target.value })} onClick={(e) => e.stopPropagation()} aria-label={`Preço de ${c.name}`} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="faint">O estoque você lança depois, em Administração › Estoque. Código de barras é opcional.</div>
        </>}

        {step === 3 && <>
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

        {step === 4 && <>
          <div><h1>Tudo pronto para vender</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>Abra o caixa com o código que você criou e faça a primeira venda.</p></div>
          <div className="card flush">
            <div className="list-item"><span className="badge success" aria-label="feito" /><span>{store.trim() || boot?.storeName}</span></div>
            <div className="list-item"><span className="badge success" aria-label="feito" /><span>Códigos do caixa e de cancelamento</span></div>
            <div className="list-item"><span className={`badge ${added || existing ? 'success' : ''}`}>{added || existing ? '' : 'falta'}</span><span>{added ? `${added} produto(s) adicionado(s)` : existing ? `${existing} produto(s) no cadastro` : 'Produtos: cadastre em Administração › Produtos'}</span></div>
            <div className="list-item"><span className={`badge ${mateCreated ? 'success' : ''}`}>{mateCreated ? '' : 'falta'}</span><span>{mateCreated ? `Acesso de ${mate.trim().split(' ')[0]} criado` : 'Equipe: crie os acessos em Administração › Usuários'}</span></div>
          </div>
        </>}

        {err && <div className="notice danger" role="alert">{err}</div>}

        <div className="row">
          {step > 0 && step < 4 && <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep(step - 1)}>Voltar</button>}
          <span className="spacer" />
          {step === 0 && <button className="btn primary lg" disabled={busy} onClick={saveBusiness}>Continuar</button>}
          {step === 1 && <button className="btn primary lg" disabled={busy} onClick={saveSecurity}>Continuar</button>}
          {step === 2 && <button className="btn primary lg" disabled={busy} onClick={saveProducts}>{busy ? 'Adicionando…' : chosen.length ? `Adicionar ${chosen.length} produto(s)` : 'Continuar sem produtos'}</button>}
          {step === 3 && (mateCreated
            ? <button className="btn primary lg" onClick={next}>Continuar</button>
            : <>
              <button type="button" className="btn ghost" disabled={busy} onClick={next}>Fazer depois</button>
              <button className="btn primary lg" disabled={busy || mate.trim().length < 2 || mateLogin.length < 3} onClick={saveMate}>Criar acesso</button>
            </>)}
          {step === 4 && <>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => finish()}>Ir para o sistema</button>
            <button className="btn primary lg" disabled={busy} onClick={() => finish('/app/caixa')}>Abrir o caixa</button>
          </>}
        </div>
        {step < 4 && <button type="button" className="btn ghost sm block" onClick={skipAll}>Pular a configuração</button>}
      </div>
      <SystemFooter />
    </div>
  );
}
