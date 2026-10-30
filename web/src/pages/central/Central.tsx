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
  const { data, loading, error, reload } = useApi<any[]>('/central/tenants');
  const ov = useApi<any>('/central/overview');
  const [showErrors, setShowErrors] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const blocked = data?.filter((t) => !t.access.ok).length ?? 0;
  const isQuiet = (t: any) => t.access.ok && (!t.lastSaleAt || Date.now() - Date.parse(t.lastSaleAt) > 7 * 864e5);
  const quiet = data?.filter(isQuiet).length ?? 0;
  return (
    <div className="shell central-shell">
      <header className="topbar">
        <span className="brand">Central<span className="brand-dot">.</span>PDV</span><span className="central-tag">Administração da plataforma</span>
        <span className="spacer" /><span className="faint user-name">{me.admin.name}</span>
        <button className="btn ghost sm" onClick={() => setSecurity(true)}>Segurança</button>
        <button className="btn ghost sm" onClick={onLogout}>Sair</button>
      </header>
      <main className="content stack">
        <div className="page-head"><h1>Estabelecimentos</h1><span className="spacer" /><button className="btn primary" onClick={() => setCreating(true)}>Novo estabelecimento</button></div>
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
          {ov.data && <button className={`badge lg ${ov.data.errors24h ? 'danger' : 'success'} offline-pill`} onClick={() => setShowErrors(true)}>{ov.data.errors24h ? `${ov.data.errors24h} erro(s) nas últimas 24h` : 'Sem erros nas últimas 24h'}</button>}
        </div>}
        {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
          <div className="card flush">{!data?.length ? <Empty>Nenhum estabelecimento ainda.</Empty> : (
            <table className="table responsive"><thead><tr><th>Estabelecimento</th><th>Situação</th><th className="r">Usuários</th><th className="r">Vendas (30 dias)</th><th>Última venda</th></tr></thead><tbody>
              {data.map((t) => (
                <tr key={t.id} className="click" onClick={() => setSel(t)}>
                  <td data-label="Estabelecimento"><b>{t.name}</b><div className="faint">nº {t.id} · desde {date(t.created_at)}{t.signup_source === 'site' ? ' · pelo site' : ''}</div>
                    {t.contact_phone && <a className="faint" href={waLink(`Olá, ${String(t.contact_name ?? '').split(' ')[0]}! Aqui é do Central.PDV.`, t.contact_phone)} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{t.contact_name} · {t.contact_phone}</a>}</td>
                  <td data-label="Situação"><AccessBadge t={t} /></td>
                  <td data-label="Usuários" className="r num">{t.users}</td>
                  <td data-label="Vendas (30 dias)" className="r num">{t.salesLast30}</td>
                  <td data-label="Última venda">{t.lastSaleAt ? dateTime(t.lastSaleAt) : '—'}{isQuiet(t) && <div><span className="badge warning">parado</span></div>}</td>
                </tr>
              ))}
            </tbody></table>
          )}</div>
        )}
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
