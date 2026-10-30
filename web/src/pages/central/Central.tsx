import { FormEvent, useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api, ApiError } from '../../lib/api';
import { useApi, useAction } from '../../lib/hooks';
import { date, dateTime, money } from '../../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, Segmented, Metric, useToast } from '../../components/ui';
import { SystemFooter } from '../../components/SystemFooter';
import { ShareButtons, waLink } from '../../components/ShareButtons';
import { easyPassword, suggestLogin } from '../admin/Admin';

type Admin = { id: number; name: string; username: string };

/** Painel do administrador central (dono da plataforma): estabelecimentos, liberações e assinaturas. */
export default function Central() {
  const [me, setMe] = useState<{ admin: Admin; stripe: boolean; totp: boolean } | null | undefined>(undefined);
  const load = () => api<{ admin: Admin; stripe: boolean; totp: boolean }>('/central/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); }, []);
  if (me === undefined) return <Loading />;
  if (!me) return <CentralLogin onDone={load} />;
  return <CentralHome me={me} onLogout={async () => { await api('/central/logout', { body: {} }).catch(() => {}); setMe(null); }} />;
}

function CentralLogin({ onDone }: { onDone: () => void }) {
  const setup = useApi<{ needed: boolean; enabled: boolean }>('/central/setup-status');
  const [f, setF] = useState({ token: '', name: '', username: '', password: '', code: '' });
  const [askCode, setAskCode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needed = !!setup.data?.needed;
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (needed) await api('/central/setup', { body: f });
      await api('/central/login', { body: { username: f.username, password: f.password, code: askCode ? f.code : undefined } });
      onDone();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'TOTP_REQUIRED') { setAskCode(true); setErr(null); } else setErr(e.message);
    } finally { setBusy(false); }
  };
  return (
    <div className="login central-login">
      <form className="card stack" onSubmit={submit}>
        <div><span className="central-tag">Administração da plataforma</span><h1 style={{ marginTop: 10 }}>Central<span className="brand-dot">.</span>PDV</h1>
          <p className="muted" style={{ margin: '4px 0 8px' }}>{needed ? 'Primeiro acesso: crie a conta do administrador central.' : 'Acesso do administrador da plataforma.'}</p></div>
        {needed && !setup.data?.enabled && <div className="notice warning">Defina a variável <b>SETUP_TOKEN</b> no servidor (Vercel) e recarregue a página.</div>}
        {needed && <>
          <Field label="Token de configuração"><input className="input" type="password" value={f.token} onChange={set('token')} required /></Field>
          <Field label="Seu nome"><input className="input" value={f.name} onChange={set('name')} required /></Field>
        </>}
        <Field label="Usuário"><input className="input lg" autoComplete="username" autoCapitalize="none" value={f.username} onChange={set('username')} required autoFocus /></Field>
        <Field label="Senha"><input className="input lg" type="password" autoComplete={needed ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} required /></Field>
        {askCode && <Field label="Código do aplicativo autenticador" hint="Os 6 dígitos que aparecem agora no aplicativo.">
          <input className="input lg" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} required autoFocus />
        </Field>}
        {err && <div className="notice danger" role="alert">{err}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Entrando…' : needed ? 'Criar e entrar' : askCode ? 'Confirmar código' : 'Entrar'}</button>
      </form>
      <SystemFooter />
    </div>
  );
}

const SUB: Record<string, string> = { active: 'Em dia', trialing: 'Em teste (Stripe)', past_due: 'Pagamento recusado', unpaid: 'Não pago', canceled: 'Cancelada', incomplete: 'Pendente' };

function AccessBadge({ t }: { t: any }) {
  if (t.status === 'SUSPENDED') return <span className="badge danger">Suspenso</span>;
  if (t.billing_exempt) return <span className="badge success">Isento</span>;
  if (t.access.ok) return <span className="badge success">{t.subscription_status === 'active' ? 'Pago' : `Teste até ${date(t.access.trialEndsAt ?? t.trial_ends_at)}`}</span>;
  return <span className="badge danger">{t.subscription_status ? SUB[t.subscription_status] ?? t.subscription_status : 'Sem assinatura'}</span>;
}

function CentralHome({ me, onLogout }: { me: { admin: Admin; stripe: boolean; totp: boolean }; onLogout: () => void }) {
  const [totp, setTotp] = useState(me.totp);
  const [security, setSecurity] = useState(false);
  const [tab, setTab] = useState<'tenants' | 'finance' | 'notices' | 'growth' | 'audit'>('tenants');
  const [onlyRisk, setOnlyRisk] = useState(false);
  const { data, loading, error, reload } = useApi<any[]>('/central/tenants');
  const ov = useApi<any>('/central/overview');
  const [showErrors, setShowErrors] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const blocked = data?.filter((t) => !t.access.ok).length ?? 0;
  const isQuiet = (t: any) => t.access.ok && (!t.lastSaleAt || Date.now() - Date.parse(t.lastSaleAt) > 7 * 864e5);
  const quiet = data?.filter(isQuiet).length ?? 0;
  const risky = data?.filter((t) => t.health?.risk === 'risk').length ?? 0;
  const shown = onlyRisk ? data?.filter((t) => t.health?.risk !== 'ok') : data;
  return (
    <div className="shell central-shell">
      <header className="topbar">
        <span className="brand">Central<span className="brand-dot">.</span>PDV</span><span className="central-tag">Administração da plataforma</span>
        <span className="spacer" /><span className="faint user-name">{me.admin.name}</span>
        <button className="btn ghost sm" onClick={() => setSecurity(true)}>Segurança</button>
        <button className="btn ghost sm" onClick={onLogout}>Sair</button>
      </header>
      <main className="content stack">
        <div className="page-head"><h1>Painel central</h1><span className="spacer" /><button className="btn primary" onClick={() => setCreating(true)}>Novo estabelecimento</button></div>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'tenants', label: 'Estabelecimentos' }, { value: 'finance', label: 'Financeiro' }, { value: 'notices', label: 'Avisos' }, { value: 'growth', label: 'Crescimento' }, { value: 'audit', label: 'Histórico' }]} />
        {tab === 'finance' && <FinancePanel tenants={data ?? []} />}
        {tab === 'notices' && <NoticesPanel tenants={data ?? []} />}
        {tab === 'growth' && <GrowthPanel />}
        {tab === 'audit' && <AuditPanel />}
        {tab === 'tenants' && <>
        {!totp && <div className="notice warning row wrap">
          <span><b>Recomendado:</b> ative a verificação em duas etapas. Este painel controla todos os estabelecimentos; com ela, quem descobrir sua senha ainda precisa do seu celular para entrar.</span>
          <span className="spacer" /><button className="btn sm" onClick={() => setSecurity(true)}>Ativar agora</button>
        </div>}
        {security && <SecurityModal enabled={totp} onClose={() => setSecurity(false)} onChanged={setTotp} />}
        {!me.stripe && <div className="notice warning">Stripe ainda não configurado (STRIPE_SECRET_KEY, STRIPE_PRICE_ID e STRIPE_WEBHOOK_SECRET na Vercel). Até lá, use "Isento" ou período de teste.</div>}
        {ov.data && <div className="metrics">
          <Metric label="Receita mensal (assinantes)" value={money(ov.data.monthlyRevenueCents)} sub={`${ov.data.paying} assinante(s) × ${money(ov.data.priceCents)}`} />
          <Metric label="Em teste grátis" value={ov.data.trial} sub="Vão precisar assinar" />
          <Metric label="Isentos" value={ov.data.exempt} sub="Cortesia ou uso próprio" />
          <Metric label="Fora do ar" value={ov.data.blocked} sub={ov.data.suspended ? `${ov.data.suspended} suspenso(s) por você` : 'Sem pagamento em dia'} />
        </div>}
        {data && <div className="status-strip">
          <span className="badge lg success">{data.length - blocked} ativo(s)</span>
          {blocked > 0 && <span className="badge lg danger">{blocked} fora do ar</span>}
          {quiet > 0 && <span className="badge lg warning">{quiet} sem vender há 7+ dias</span>}
          {risky > 0 && <button className={`badge lg ${onlyRisk ? 'danger' : 'warning'} offline-pill`} onClick={() => setOnlyRisk(!onlyRisk)}>{onlyRisk ? 'Mostrando só em risco · ver todos' : `${risky} em risco de cancelar`}</button>}
          {ov.data && <button className={`badge lg ${ov.data.errors24h ? 'danger' : 'success'} offline-pill`} onClick={() => setShowErrors(true)}>{ov.data.errors24h ? `${ov.data.errors24h} erro(s) nas últimas 24h` : 'Sem erros nas últimas 24h'}</button>}
        </div>}
        {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
          <div className="card flush">{!data?.length ? <Empty>Nenhum estabelecimento ainda.</Empty> : (
            <table className="table responsive"><thead><tr><th>Estabelecimento</th><th>Situação</th><th>Saúde</th><th className="r">Usuários</th><th className="r">Vendas (30 dias)</th><th>Última venda</th></tr></thead><tbody>
              {shown!.map((t) => (
                <tr key={t.id} className="click" onClick={() => setSel(t)}>
                  <td data-label="Estabelecimento"><b>{t.name}</b><div className="faint">nº {t.id} · desde {date(t.created_at)}{t.signup_source === 'site' ? ' · pelo site' : ''}</div>
                    {t.contact_phone && <a className="faint" href={waLink(`Olá, ${String(t.contact_name ?? '').split(' ')[0]}! Aqui é do Central.PDV.`, t.contact_phone)} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{t.contact_name} · {t.contact_phone}</a>}</td>
                  <td data-label="Situação"><AccessBadge t={t} /></td>
                  <td data-label="Saúde"><HealthBadge h={t.health} /></td>
                  <td data-label="Usuários" className="r num">{t.users}</td>
                  <td data-label="Vendas (30 dias)" className="r num">{t.salesLast30}</td>
                  <td data-label="Última venda">{t.lastSaleAt ? dateTime(t.lastSaleAt) : '—'}{isQuiet(t) && <div><span className="badge warning">parado</span></div>}</td>
                </tr>
              ))}
            </tbody></table>
          )}</div>
        )}
        </>}
      </main>
      <SystemFooter />
      {showErrors && <ErrorsModal onClose={() => setShowErrors(false)} />}
      {creating && <NewTenant onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {sel && <TenantModal t={sel} onClose={() => setSel(null)} onChanged={reload} />}
    </div>
  );
}

const MOD_LABELS: Record<string, string> = { mesas: 'Mesas e comandas', fiado: 'Fiado e clientes', estoque: 'Estoque', inventario: 'Inventário', analise: 'Análise comercial', reposicao: 'Reposição', auditoria: 'Auditoria' };

function NewTenant({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', adminName: '', phone: '', username: '', password: easyPassword(), billing: 'trial', trialDays: '7' });
  const [mods, setMods] = useState<Record<string, boolean>>(Object.fromEntries(Object.keys(MOD_LABELS).map((k) => [k, k !== 'auditoria'])));
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const [save, busy] = useAction(async () => {
    setErr(null);
    try {
      await api('/central/tenants', { body: {
        name: f.name, admin: { name: f.adminName, username: f.username, password: f.password },
        exempt: f.billing === 'exempt', trialDays: f.billing === 'trial' ? Number(f.trialDays) || 0 : undefined, modules: mods, contact: f.phone ? { phone: f.phone } : undefined,
      } });
      toast('Estabelecimento criado.', 'success'); setCreated(true);
    } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Erro ao criar.'); }
  });
  const [created, setCreated] = useState(false);
  if (created) {
    const text = `Olá, ${f.adminName.split(' ')[0]}! Bem-vindo ao *Central.PDV* 🎉\nSeu sistema do *${f.name}* está pronto:\n\nEndereço: ${location.origin}/app\nLogin: *${f.username}*\nSenha: *${f.password}*\n\nNo primeiro acesso, defina o código do caixa e cadastre sua equipe.`;
    return (
      <Modal title="Estabelecimento criado" onClose={onDone} footer={<button className="btn primary" onClick={onDone}>Concluir</button>}>
        <div className="notice success">Envie o acesso para {f.adminName}. A senha não fica visível depois.</div>
        <pre className="statement">{text.replace(/\*/g, '')}</pre>
        <ShareButtons title="Acesso ao Central.PDV" text={text} phone={f.phone} />
      </Modal>
    );
  }
  return (
    <Modal title="Novo estabelecimento" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !f.name || !f.username || f.password.length < 8 || !f.adminName} onClick={save}>Criar</button></>}>
      <Field label="Nome do estabelecimento"><input className="input" value={f.name} onChange={set('name')} placeholder="Ex.: Bar do Zé" autoFocus /></Field>
      <div className="faint">Administrador do estabelecimento (quem vai usar e cadastrar a equipe):</div>
      <div className="grid2">
        <Field label="Nome"><input className="input" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value, username: suggestLogin(e.target.value) })} /></Field>
        <Field label="Login" hint="Único em toda a plataforma (ex.: ze.silva)."><input className="input" autoCapitalize="none" value={f.username} onChange={set('username')} /></Field>
      </div>
      <Field label="Celular do responsável (WhatsApp)"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="(11) 98765-4321" /></Field>
      <Field label="Senha inicial" hint="Mín. 8 caracteres. Passe para o cliente trocar depois."><input className="input" value={f.password} onChange={set('password')} /></Field>
      <Field group label="Cobrança">
        <Segmented value={f.billing} onChange={(billing) => setF({ ...f, billing })} options={[{ value: 'trial', label: 'Teste grátis' }, { value: 'paid', label: 'Assinatura já' }, { value: 'exempt', label: 'Isento' }]} />
      </Field>
      {f.billing === 'trial' && <Field label="Dias de teste"><input className="input num" style={{ maxWidth: 120 }} inputMode="numeric" value={f.trialDays} onChange={set('trialDays')} /></Field>}
      {f.billing === 'paid' && <div className="faint">Fica fora do ar até o administrador assinar em Administração → Assinatura.</div>}
      <Field group label="Liberações (módulos)">
        <div className="stack" style={{ gap: 6 }}>{Object.entries(MOD_LABELS).map(([k, l]) => (
          <label key={k} className="check"><input type="checkbox" checked={!!mods[k]} onChange={(e) => setMods({ ...mods, [k]: e.target.checked })} /> {l}</label>
        ))}</div>
      </Field>
      {err && <div className="notice danger">{err}</div>}
    </Modal>
  );
}

function TenantModal({ t, onClose, onChanged }: { t: any; onClose: () => void; onChanged: () => void }) {
  const mods = useApi<any>(`/central/tenants/${t.id}/modules`);
  const users = useApi<any[]>(`/central/tenants/${t.id}/users`);
  const [name, setName] = useState(t.name);
  const [trialDays, setTrialDays] = useState('');
  const [pwFor, setPwFor] = useState<any>(null);
  const toast = useToast();
  const patch = async (body: any, msg: string) => {
    try { await api(`/central/tenants/${t.id}`, { method: 'PATCH', body }); toast(msg, 'success'); onChanged(); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const [toggle] = useAction(async (k: string, v: boolean) => {
    try { mods.setData(await api(`/central/tenants/${t.id}/modules`, { method: 'PUT', body: { [k]: v } })); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal wide title={t.name} onClose={onClose}>
      <div className="card stack">
        <div className="row wrap"><b>Situação</b><span className="spacer" /><AccessBadge t={t} /></div>
        {t.current_period_end && <div className="faint">Assinatura Stripe: {SUB[t.subscription_status] ?? t.subscription_status} · período até {date(t.current_period_end)}</div>}
        <div className="row wrap">
          {t.status === 'SUSPENDED'
            ? <button className="btn primary" onClick={() => patch({ status: 'ACTIVE' }, 'Estabelecimento reativado.')}>Reativar</button>
            : <button className="btn danger" onClick={() => window.confirm(`Suspender ${t.name}? O sistema sai do ar para todos de lá.`) && patch({ status: 'SUSPENDED' }, 'Estabelecimento suspenso.')}>Suspender</button>}
          <button className="btn" onClick={() => patch({ billing_exempt: !t.billing_exempt }, t.billing_exempt ? 'Agora depende da assinatura.' : 'Marcado como isento.')}>{t.billing_exempt ? 'Tirar isenção' : 'Marcar como isento'}</button>
          <a className="btn" href={`/api/central/tenants/${t.id}/backup`} download>Baixar cópia de segurança</a>
        </div>
        <div className="row wrap">
          <input className="input num" style={{ width: 110 }} inputMode="numeric" placeholder="dias" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} aria-label="Dias de teste" />
          <button className="btn" disabled={!Number(trialDays)} onClick={() => patch({ trial_ends_at: new Date(Date.now() + Number(trialDays) * 864e5).toISOString() }, 'Período de teste definido.')}>Dar dias de teste</button>
        </div>
        <div className="row wrap">
          <input className="input" style={{ maxWidth: 300 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome" />
          <button className="btn" disabled={!name.trim() || name === t.name} onClick={() => patch({ name }, 'Nome alterado.')}>Renomear</button>
        </div>
      </div>
      {t.health && <div className="card stack">
        <div className="row wrap"><h2>Primeiros passos</h2><span className="spacer" /><HealthBadge h={t.health} /></div>
        <div className="steps-list">{t.health.steps.map((s: any) => <span key={s.key} className={`badge ${s.done ? 'success' : ''}`}>{s.label}</span>)}</div>
        {t.health.reasons.length > 0 && <div className="faint">Atenção: {t.health.reasons.join(' · ')}</div>}
        <div className="faint">{t.health.products} produto(s) · {t.health.users} usuário(s){t.health.firstSaleAt ? ` · primeira venda em ${date(t.health.firstSaleAt)}` : ''}</div>
        {t.contact_phone && <div className="row wrap"><span><b>{t.contact_name}</b> · {t.contact_phone}</span><span className="spacer" />
          <a className="btn sm primary" target="_blank" rel="noopener" href={waLink(`Olá, ${String(t.contact_name ?? '').split(' ')[0]}! Aqui é do Central.PDV. Tudo certo com o sistema do ${t.name}?`, t.contact_phone)}>Chamar no WhatsApp</a></div>}
      </div>}
      <Notes tenantId={t.id} />
      <div className="card flush">
        <div style={{ padding: '14px 16px' }}><h2>Liberações</h2><div className="faint">Só você altera. Vale na hora para o estabelecimento.</div></div>
        {!mods.data ? <Loading /> : Object.entries(mods.data.labels as Record<string, string>).map(([k, label]) => (
          <label key={k} className="list-item" style={{ cursor: 'pointer' }}>
            <span><b>{label}</b></span><span className="spacer" />
            <span className={`badge ${mods.data.modules[k] ? 'success' : ''}`}>{mods.data.modules[k] ? 'liberado' : 'bloqueado'}</span>
            <input type="checkbox" style={{ width: 22, height: 22 }} checked={!!mods.data.modules[k]} onChange={(e) => toggle(k, e.target.checked)} aria-label={`Liberar ${label}`} />
          </label>
        ))}
      </div>
      <div className="card flush">
        <div style={{ padding: '14px 16px' }}><h2>Usuários</h2></div>
        {!users.data ? <Loading /> : users.data.map((u) => (
          <div key={u.id} className="list-item" style={{ cursor: 'default' }}>
            <span><b>{u.name}</b><div className="faint">{u.username} · {u.role === 'ADMIN' ? 'Administrador' : 'Operador'}{u.active ? '' : ' · bloqueado'}</div></span>
            <span className="spacer" /><button className="btn sm" onClick={() => setPwFor(u)}>Redefinir senha</button>
          </div>
        ))}
      </div>
      {pwFor && <ResetPassword tenantId={t.id} u={pwFor} onClose={() => setPwFor(null)} />}
    </Modal>
  );
}

function ResetPassword({ tenantId, u, onClose }: { tenantId: number; u: any; onClose: () => void }) {
  const [p, setP] = useState(easyPassword);
  const [done, setDone] = useState(false);
  const toast = useToast();
  const [save, busy] = useAction(async () => {
    try { await api(`/central/tenants/${tenantId}/users/${u.id}/password`, { method: 'PUT', body: { password: p } }); setDone(true); } catch (e: any) { toast(e.message, 'error'); }
  });
  const text = `Olá, ${String(u.name).split(' ')[0]}! Sua nova senha do Central.PDV:\n\nEndereço: ${location.origin}/app\nLogin: *${u.username}*\nSenha: *${p}*`;
  if (done) return (
    <Modal title="Senha redefinida" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Concluir</button>}>
      <pre className="statement">{text.replace(/\*/g, '')}</pre>
      <ShareButtons title="Nova senha" text={text} />
    </Modal>
  );
  return (
    <Modal title={`Nova senha para ${u.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || p.length < 8} onClick={save}>Salvar</button></>}>
      <Field group label="Nova senha" hint="Mín. 8 caracteres. As sessões abertas desse usuário são encerradas.">
        <div className="row"><input className="input" value={p} onChange={(e) => setP(e.target.value)} autoFocus /><button className="btn" type="button" onClick={() => setP(easyPassword())}>Gerar outra</button></div>
      </Field>
    </Modal>
  );
}

/** Erros do servidor (últimos 30 dias): para você saber antes do cliente reclamar. */
function ErrorsModal({ onClose }: { onClose: () => void }) {
  const { data, loading } = useApi<any[]>('/central/errors');
  return (
    <Modal wide title="Erros do sistema" onClose={onClose}>
      <div className="faint">Falhas inesperadas do servidor (ex.: banco fora do ar). Erros de digitação dos usuários não aparecem aqui.</div>
      {loading && !data ? <Loading /> : !data?.length ? <Empty>Nenhum erro registrado. 🎉</Empty> : (
        <div className="card flush"><table className="table responsive"><thead><tr><th>Quando</th><th>Estabelecimento</th><th>Onde</th><th>Erro</th></tr></thead><tbody>
          {data.map((e) => <tr key={e.id}><td data-label="Quando">{dateTime(e.at)}</td><td data-label="Estabelecimento">{e.tenant_name ?? '—'}</td><td data-label="Onde" className="faint">{e.method} {e.path}</td><td data-label="Erro">{e.message}</td></tr>)}
        </tbody></table></div>
      )}
    </Modal>
  );
}

/** Verificação em duas etapas do painel central: opcional, com aplicativo autenticador (Google Authenticator, Microsoft Authenticator…). */
function SecurityModal({ enabled, onClose, onChanged }: { enabled: boolean; onClose: () => void; onChanged: (v: boolean) => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const svg = useMemo(() => {
    if (!setup) return '';
    const q = qrcode(0, 'M'); q.addData(setup.url); q.make();
    return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  }, [setup]);
  const safe = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e: any) { toast(e.message, 'error'); } };
  const [begin, b1] = useAction(safe(async () => setSetup(await api('/central/2fa/begin', { body: {} }))));
  const [enable, b2] = useAction(safe(async () => {
    await api('/central/2fa/enable', { body: { code } });
    toast('Verificação em duas etapas ativada.', 'success'); onChanged(true); onClose();
  }));
  const [disable, b3] = useAction(safe(async () => {
    await api('/central/2fa/disable', { body: { password, code } });
    toast('Verificação em duas etapas desativada.', 'success'); onChanged(false); onClose();
  }));
  const onlyDigits = (e: any) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
  return (
    <Modal title="Segurança do painel central" onClose={onClose}>
      <div className="stack">
        {enabled ? <>
          <div className="notice success">A verificação em duas etapas está <b>ativada</b>. Todo acesso pede a senha e o código do aplicativo.</div>
          <p className="muted" style={{ margin: 0 }}>Para desativar, confirme sua senha e o código atual do aplicativo.</p>
          <Field label="Senha"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Código do aplicativo"><input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={onlyDigits} /></Field>
          <div className="row"><span className="spacer" /><button className="btn danger" disabled={b3 || code.length !== 6 || !password} onClick={disable}>Desativar</button></div>
        </> : !setup ? <>
          <p style={{ margin: 0 }}>A verificação em duas etapas é <b>opcional</b>, mas recomendada: além da senha, o acesso pede um código de 6 dígitos que muda a cada 30 segundos no seu celular.</p>
          <p className="muted" style={{ margin: 0 }}>Você vai precisar de um aplicativo autenticador gratuito, como Google Authenticator ou Microsoft Authenticator.</p>
          <div className="row"><span className="spacer" /><button className="btn primary" disabled={b1} onClick={begin}>Começar</button></div>
        </> : <>
          <p style={{ margin: 0 }}><b>1.</b> No aplicativo autenticador, toque em <b>+</b> e leia este QR Code.</p>
          <div className="pix-qr" style={{ maxWidth: 220, margin: '0 auto' }} dangerouslySetInnerHTML={{ __html: svg }} aria-label="QR Code para o aplicativo autenticador" />
          <p className="faint" style={{ margin: 0, textAlign: 'center', wordBreak: 'break-all' }}>Sem câmera? Digite a chave: <code>{setup.secret}</code></p>
          <p style={{ margin: 0 }}><b>2.</b> Digite o código de 6 dígitos que apareceu no aplicativo.</p>
          <Field label="Código"><input className="input lg" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={onlyDigits} autoFocus /></Field>
          <div className="notice warning">Se você perder o celular, peça ao suporte técnico para desativar pelo banco de dados.</div>
          <div className="row"><span className="spacer" /><button className="btn primary" disabled={b2 || code.length !== 6} onClick={enable}>Ativar</button></div>
        </>}
      </div>
    </Modal>
  );
}

function HealthBadge({ h }: { h?: { risk: 'ok' | 'attention' | 'risk'; reasons: string[] } }) {
  if (!h) return null;
  const [cls, label] = h.risk === 'risk' ? ['danger', 'Em risco'] : h.risk === 'attention' ? ['warning', 'Atenção'] : ['success', 'Saudável'];
  return <span className={`badge ${cls}`} title={h.reasons.join(' · ') || undefined}>{label}</span>;
}

/** Notas internas sobre o cliente (só o painel central vê). */
function Notes({ tenantId }: { tenantId: number }) {
  const notes = useApi<any[]>(`/central/tenants/${tenantId}/notes`);
  const [text, setText] = useState('');
  const toast = useToast();
  const [add, busy] = useAction(async () => {
    try { await api(`/central/tenants/${tenantId}/notes`, { body: { text } }); setText(''); notes.reload(); } catch (e: any) { toast(e.message, 'error'); }
  });
  const del = async (id: number) => { try { await api(`/central/tenants/${tenantId}/notes/${id}`, { method: 'DELETE' }); notes.reload(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="card stack">
      <h2>Notas internas</h2>
      <div className="row"><input className="input" placeholder="Ex.: ligou pedindo impressora, prometi retorno na sexta" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && add()} />
        <button className="btn" disabled={busy || !text.trim()} onClick={add}>Anotar</button></div>
      {notes.data?.map((n) => <div key={n.id} className="row" style={{ alignItems: 'flex-start' }}><div style={{ flex: 1 }}>{n.text}<div className="faint">{n.admin_name ?? '—'} · {dateTime(n.at)}</div></div>
        <button className="btn ghost sm" onClick={() => window.confirm('Apagar esta nota?') && del(n.id)}>Apagar</button></div>)}
      {notes.data && !notes.data.length && <div className="faint">Nenhuma nota ainda.</div>}
    </div>
  );
}

/** Financeiro: números reais do Stripe. */
function FinancePanel({ tenants }: { tenants: any[] }) {
  const { data, error, loading, reload } = useApi<any>('/central/finance');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data?.configured) return <div className="notice warning">O Stripe ainda não está configurado no servidor.</div>;
  const name = (x: any) => x.tenant?.name ?? 'Cliente sem cadastro aqui';
  const wa = (x: any) => x.tenant?.contact_phone ? <a className="btn sm" target="_blank" rel="noopener" href={waLink(`Olá! Aqui é do Central.PDV. Vimos que o pagamento da assinatura do ${x.tenant.name} não foi aprovado. Pode atualizar o cartão em Administração › Assinatura?`, x.tenant.contact_phone)}>WhatsApp</a> : null;
  return (
    <div className="stack">
      <div className="metrics">
        <Metric label="Recebido neste mês" value={money(data.receivedThisMonthCents)} sub={`${data.invoicesThisMonth} pagamento(s) aprovados`} />
        <Metric label="Receita recorrente" value={money(data.mrrCents)} sub={`${data.activeCount} assinatura(s) ativa(s)`} />
        <Metric label="Pagamento atrasado" value={data.pastDue.length} sub="Cartão recusado" />
        <Metric label="Cancelaram neste mês" value={data.canceledThisMonth} sub={`de ${tenants.length} estabelecimento(s)`} />
      </div>
      <div className="card flush"><div style={{ padding: '14px 16px' }}><h2>Pagamento atrasado</h2></div>
        {!data.pastDue.length ? <Empty>Ninguém com pagamento atrasado.</Empty> : data.pastDue.map((x: any, i: number) => (
          <div key={i} className="list-item" style={{ cursor: 'default' }}><span><b>{name(x)}</b><div className="faint">{money(x.amountCents)}{x.since ? ` · desde ${date(x.since)}` : ''}</div></span><span className="spacer" />{wa(x)}</div>))}
      </div>
      <div className="card flush"><div style={{ padding: '14px 16px' }}><h2>Próximas cobranças (7 dias)</h2></div>
        {!data.upcoming.length ? <Empty>Nenhuma cobrança nos próximos 7 dias.</Empty> : data.upcoming.map((x: any, i: number) => (
          <div key={i} className="list-item" style={{ cursor: 'default' }}><span><b>{name(x)}</b><div className="faint">{date(x.at)}{x.cancelAtPeriodEnd ? ' · vai cancelar no fim do período' : ''}</div></span><span className="spacer" /><span className="num">{money(x.amountCents)}</span></div>))}
      </div>
    </div>
  );
}

const KIND: Record<string, [string, string]> = { maintenance: ['Manutenção', 'warning'], billing: ['Pagamento', 'danger'], news: ['Novidade', 'success'], info: ['Informação', ''] };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);

/** Avisos que aparecem no topo do sistema dos estabelecimentos. */
function NoticesPanel({ tenants }: { tenants: any[] }) {
  const list = useApi<any[]>('/central/notices');
  const toast = useToast();
  const [f, setF] = useState({ tenant_id: '', kind: 'maintenance', title: '', message: '', starts: localInput(new Date()), ends: localInput(new Date(Date.now() + 864e5)) });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const [save, busy] = useAction(async () => {
    try {
      await api('/central/notices', { body: { tenant_id: f.tenant_id ? Number(f.tenant_id) : null, kind: f.kind, title: f.title, message: f.message, starts_at: new Date(f.starts).toISOString(), ends_at: new Date(f.ends).toISOString() } });
      toast('Aviso publicado.', 'success'); setF({ ...f, title: '', message: '' }); list.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  });
  const end = async (id: number) => { try { await api(`/central/notices/${id}/end`, { body: {} }); list.reload(); } catch (e: any) { toast(e.message, 'error'); } };
  const nowIso = new Date().toISOString();
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Novo aviso</h2>
        <div className="faint">Aparece numa faixa no topo do sistema, inclusive para quem estiver com o sistema bloqueado. Avisos de vencimento do teste e da renovação já são automáticos.</div>
        <div className="filters">
          <select className="input" value={f.tenant_id} onChange={set('tenant_id')} aria-label="Para quem"><option value="">Todos os estabelecimentos</option>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select className="input" value={f.kind} onChange={set('kind')} aria-label="Tipo">{Object.entries(KIND).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <Field label="Título"><input className="input" maxLength={80} placeholder="Ex.: Manutenção no domingo" value={f.title} onChange={set('title')} /></Field>
        <Field label="Mensagem"><textarea className="input" rows={3} maxLength={400} placeholder="Ex.: Das 3h às 4h o sistema pode ficar lento. As vendas sem internet continuam funcionando." value={f.message} onChange={set('message')} /></Field>
        <div className="filters">
          <Field label="Começa"><input className="input" type="datetime-local" value={f.starts} onChange={set('starts')} /></Field>
          <Field label="Termina"><input className="input" type="datetime-local" value={f.ends} onChange={set('ends')} /></Field>
        </div>
        <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy || f.title.trim().length < 3 || f.message.trim().length < 3} onClick={save}>Publicar aviso</button></div>
      </div>
      <div className="card flush"><div style={{ padding: '14px 16px' }}><h2>Avisos</h2></div>
        {!list.data ? <Loading /> : !list.data.length ? <Empty>Nenhum aviso ainda.</Empty> : list.data.map((n) => {
          const live = n.starts_at <= nowIso && n.ends_at > nowIso, future = n.starts_at > nowIso;
          return <div key={n.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}><span className={`badge ${KIND[n.kind]?.[1] ?? ''}`}>{KIND[n.kind]?.[0]}</span> <b>{n.title}</b><div>{n.message}</div>
              <div className="faint">{n.tenant_name ?? 'Todos'} · {dateTime(n.starts_at)} até {dateTime(n.ends_at)} · {live ? 'no ar' : future ? 'agendado' : 'encerrado'}</div></span>
            {(live || future) && <button className="btn sm" onClick={() => end(n.id)}>Encerrar</button>}
          </div>;
        })}
      </div>
    </div>
  );
}

/** Novos estabelecimentos por mês (site × painel) e cancelamentos. */
function GrowthPanel() {
  const { data, error, reload } = useApi<any>('/central/growth');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const max = Math.max(1, ...data.months.map((m: any) => Math.max(m.site + m.central, m.canceled)));
  const label = (m: string) => new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' }).format(new Date(m + '-01T00:00:00Z')).replace('.', '');
  const sum = (k: string) => data.months.reduce((a: number, m: any) => a + m[k], 0);
  return (
    <div className="stack">
      <div className="metrics">
        <Metric label="Estabelecimentos" value={data.total} sub="No total" />
        <Metric label="Novos (12 meses)" value={sum('site') + sum('central')} sub={`${sum('site')} pelo site · ${sum('central')} por você`} />
        <Metric label="Cancelamentos (12 meses)" value={sum('canceled')} sub="Assinaturas canceladas" />
      </div>
      <div className="card stack">
        <div className="row wrap"><h2>Por mês</h2><span className="spacer" /><span className="legend-dot" style={{ background: 'var(--accent)' }} />Pelo site<span className="legend-dot" style={{ background: '#8b5cf6' }} />Por você<span className="legend-dot" style={{ background: 'var(--danger)' }} />Cancelados</div>
        <div className="growth">{data.months.map((m: any) => (
          <div key={m.month} className="g-col" title={`${m.site} pelo site · ${m.central} por você · ${m.canceled} cancelado(s)`}>
            <div className="g-bars">
              <div className="g-stack" style={{ height: `${((m.site + m.central) / max) * 100}%` }}><i style={{ flex: m.central, background: '#8b5cf6' }} /><i style={{ flex: m.site, background: 'var(--accent)' }} /></div>
              <div className="g-bar" style={{ height: `${(m.canceled / max) * 100}%`, background: 'var(--danger)' }} />
            </div>
            <div className="faint g-label">{label(m.month)}</div>
          </div>
        ))}</div>
      </div>
    </div>
  );
}

const ACTIONS: Record<string, string> = {
  'tenant.create': 'Criou estabelecimento', 'tenant.update': 'Alterou estabelecimento', 'tenant.modules': 'Mudou liberações', 'tenant.user_password': 'Redefiniu senha de usuário',
  'tenant.backup': 'Baixou cópia de segurança', 'notice.create': 'Publicou aviso', 'notice.end': 'Encerrou aviso', 'central.login': 'Entrou no painel', 'central.login_failed': 'Tentativa de login falhou',
  'central.totp_enabled': 'Ativou verificação em duas etapas', 'central.totp_disabled': 'Desativou verificação em duas etapas', 'central.totp_failed': 'Código de verificação errado', 'billing.subscription': 'Assinatura atualizada (Stripe)',
};

/** Tudo o que foi feito no painel central (e as mudanças de assinatura vindas do Stripe). */
function AuditPanel() {
  const { data, error, reload } = useApi<any[]>('/central/audit');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="card flush">{!data.length ? <Empty>Nada registrado ainda.</Empty> : (
      <table className="table responsive"><thead><tr><th>Quando</th><th>Quem</th><th>O quê</th><th>Estabelecimento</th></tr></thead><tbody>
        {data.map((a) => <tr key={a.id}><td data-label="Quando">{dateTime(a.at)}</td><td data-label="Quem">{a.admin_name ?? (a.action.startsWith('billing') ? 'Stripe' : '—')}</td>
          <td data-label="O quê">{ACTIONS[a.action] ?? a.action}</td><td data-label="Estabelecimento">{a.tenant_name ?? '—'}</td></tr>)}
      </tbody></table>
    )}</div>
  );
}
