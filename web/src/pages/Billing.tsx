import { useApi, useAction } from '../lib/hooks';
import { api } from '../lib/api';
import { date, money } from '../lib/format';
import { Loading, ErrorState, useToast } from '../components/ui';
import { useSession } from '../components/session';
import { SystemFooter } from '../components/SystemFooter';
import { NoticeBar } from '../components/NoticeBar';
import { PixQr } from '../components/PixQr';

const STATUS: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  active: ['Em dia', 'success'], trialing: ['Em teste', 'success'], past_due: ['Pagamento recusado', 'danger'],
  unpaid: ['Não pago', 'danger'], canceled: ['Cancelada', 'danger'], incomplete: ['Pagamento pendente', 'warning'],
  incomplete_expired: ['Expirada', 'danger'], paused: ['Pausada', 'warning'],
};

export const PLANS = {
  essencial: { name: 'Essencial', items: ['Vendas, caixa, mesas e fiado', 'Estoque, inventário e relatórios', 'Pix pela chave (QR Code com o valor; o caixa confere no banco)'] },
  pro: { name: 'Pro', items: [] as string[] },
} as const;
type PlanKey = keyof typeof PLANS;

/** Os dois planos lado a lado: assinar, ou mudar de plano quem já assina. */
function PlanCards({ data, onChanged }: { data: any; onChanged: () => void }) {
  const toast = useToast();
  const { refreshBoot } = useSession();
  const valid = data.status === 'active' || data.status === 'trialing';
  const [pick, busy] = useAction(async (plan: PlanKey) => {
    try {
      if (valid && !window.confirm(`Mudar para o plano ${PLANS[plan].name}? A diferença é ajustada na próxima fatura.`)) return;
      const r = await api<{ url?: string; changed?: boolean }>(valid ? '/billing/plan' : '/billing/checkout', { body: { plan } });
      if (r.url) { window.location.href = r.url; return; }
      toast(`Plano ${PLANS[plan].name} ativado.`, 'success'); await refreshBoot(); onChanged();
    } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <div className="plans">
      {(Object.keys(PLANS) as PlanKey[]).map((k) => {
        const current = data.plan === k && (valid || data.exempt);
        // Plano Pro ainda não lançado: só "Em breve" para quem não está nele (o central pode liberar antes).
        const soon = k === 'pro' && data.plan !== 'pro';
        if (soon) return (
          <div key={k} className="card stack plan">
            <div className="row"><h2>{PLANS[k].name}</h2><span className="spacer" /><span className="badge accent">em breve</span></div>
            <span className="faint">Novidades chegando.</span>
          </div>
        );
        const off = k === 'pro' && !data.proAvailable;
        const price = data.prices?.[k];
        return (
          <div key={k} className={`card stack plan ${current ? 'current' : ''}`}>
            <div className="row"><h2>{PLANS[k].name}</h2><span className="spacer" />{current && <span className="badge success">seu plano</span>}</div>
            {price != null && <div><span className="total-big num" style={{ fontSize: 28 }}>{money(price)}</span><span className="muted"> /mês</span></div>}
            <ul className="plan-items">{PLANS[k].items.map((i) => <li key={i}>{i}</li>)}</ul>
            {data.exempt ? null : off ? <span className="faint">Em breve.</span>
              : !data.configured ? null
              : current ? null
              : <button className={`btn ${k === 'pro' ? 'primary' : ''} lg block`} disabled={busy} onClick={() => pick(k)}>{valid ? `Mudar para ${PLANS[k].name}` : `Assinar com cartão`}</button>}
          </div>
        );
      })}
    </div>
  );
}

/** Botões para assinar (Checkout) ou gerenciar pagamento (Portal do Stripe). */
function BillingActions({ data, plans = true }: { data: any; plans?: boolean }) {
  const toast = useToast();
  const [go, busy] = useAction(async (kind: 'checkout' | 'portal') => {
    try { const r = await api<{ url: string }>(`/billing/${kind}`, { body: { plan: data.plan || 'essencial' } }); window.location.href = r.url; } catch (e: any) { toast(e.message, 'error'); }
  });
  if (!data.configured) return <div className="notice warning">O pagamento online ainda não foi configurado. Fale com o suporte do Central.PDV.</div>;
  const valid = data.status === 'active' || data.status === 'trialing';
  return (
    <div className="row wrap">
      {!valid && !plans && <button className="btn primary lg" disabled={busy} onClick={() => go('checkout')}>{data.hasCustomer ? 'Assinar novamente' : 'Assinar agora'}</button>}
      {data.hasCustomer && <button className={`btn ${valid ? 'primary' : ''} lg`} disabled={busy} onClick={() => go('portal')}>Atualizar cartão e ver faturas</button>}
    </div>
  );
}

const HOWTO = '/media/como-assinar-7e4606f570.mp4';
/** "Saiba como assinar": vídeo de 1 minuto com o passo a passo do pagamento. */
function HowTo() {
  return (
    <a className="howto" href={HOWTO} target="_blank" rel="noopener">
      <span className="howto-play" aria-hidden>▶</span>
      <span><b>Saiba como assinar</b><span className="faint">Vídeo de 1 minuto, passo a passo</span></span>
    </a>
  );
}

/** Mensalidade por Pix direto: QR com o valor certo e "Já paguei" (o sistema libera na hora por 3 dias enquanto o pagamento é conferido). */
function PixPay({ onPaid }: { onPaid?: () => void }) {
  const toast = useToast();
  const { data, reload } = useApi<any>('/billing/pix');
  const [report, busy] = useAction(async () => {
    try { await api('/billing/pix/report', { body: {} }); toast('Aviso enviado! O sistema já está liberado enquanto conferimos.', 'success'); reload(); onPaid?.(); }
    catch (e: any) { toast(e.message, 'error'); }
  });
  if (!data?.available) return null;
  const paidOk = data.paidUntil && data.paidUntil > new Date().toISOString();
  return (
    <div className="card stack pix-pay">
      <div className="row wrap"><h2>Pagar com Pix</h2><span className="spacer" />{paidOk && <span className="badge success">pago até {date(data.paidUntil)}</span>}</div>
      {data.pending ? (
        <div className="notice success">Recebemos seu aviso de pagamento de <b>{money(data.pending.amount_cents)}</b>. O sistema está liberado{data.graceUntil ? ` até ${date(data.graceUntil)}` : ''} enquanto conferimos — depois de confirmado, vale por 30 dias.</div>
      ) : (<>
        <div className="row"><span className="muted">{data.kind === 'first' ? '1ª cobrança (instalação + 1º mês)' : 'Mensalidade (30 dias)'}</span><span className="spacer" /><b className="num" style={{ fontSize: 22 }}>{money(data.amountCents)}</b></div>
        {paidOk && <div className="faint">Pagando agora, os 30 dias são somados ao que ainda falta.</div>}
        <PixQr pix={data.pix} amountCents={data.amountCents} note="Abra o app do seu banco, escolha Pix › Ler QR Code (ou copie o código). O valor já vem preenchido. Depois de pagar, toque em Já paguei." />
        <button className="btn primary lg block" disabled={busy} onClick={report}>{busy ? 'Enviando…' : 'Já paguei'}</button>
      </>)}
    </div>
  );
}

/** Administração → Assinatura. */
export function BillingPage() {
  const { data, loading, error, reload } = useApi<any>('/billing/status');
  const ok = new URLSearchParams(location.search).get('ok');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const [label, tone] = data.exempt ? ['Isento (cortesia)', 'success'] as const : STATUS[data.status] ?? (data.trialEndsAt ? ['Período de teste', 'success'] as const : ['Sem assinatura', 'danger'] as const);
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="page-head"><h1>Assinatura</h1></div>
      {!data.exempt && !(data.status === 'active' || data.status === 'trialing') && <HowTo />}
      {ok && <div className="notice">Pagamento recebido pelo Stripe. A liberação acontece em instantes; se ainda aparecer bloqueado, toque em Atualizar.</div>}
      <div className="card stack">
        <div className="row wrap"><span className="muted">Situação</span><span className="spacer" /><span className={`badge lg ${tone}`}>{label}</span></div>
        {data.currentPeriodEnd && data.status === 'active' && <div className="row"><span className="muted">Próxima cobrança</span><span className="spacer" /><b>{date(data.currentPeriodEnd)}</b></div>}
        {data.trialEndsAt && !data.exempt && <div className="row"><span className="muted">Teste grátis até</span><span className="spacer" /><b>{date(data.trialEndsAt)}</b></div>}
        <div className="faint">Sem pagamento em dia o sistema fica fora do ar para todos do estabelecimento. Os dados ficam guardados e voltam assim que o pagamento é confirmado.</div>
        {!data.exempt && <BillingActions data={data} />}
        <div><button className="btn ghost sm" onClick={reload}>Atualizar</button></div>
      </div>
      {!data.exempt && !(data.status === 'active' || data.status === 'trialing') && <a className="btn ghost" style={{ alignSelf: 'flex-start' }} href="/media/como-assinar-7e4606f570.mp4" target="_blank" rel="noopener">▶ Ver como assinar (vídeo de 1 min)</a>}
      {!data.exempt && !(data.status === 'active' || data.status === 'trialing') && <PixPay onPaid={reload} />}
      <h2>Planos</h2>
      <PlanCards data={data} onChanged={reload} />
    </div>
  );
}

/** Tela mostrada quando a assinatura não está em dia (ou o estabelecimento foi suspenso). */
export function Blocked() {
  const { user, access, logout, refreshAccess } = useSession();
  const isAdmin = user?.role === 'ADMIN';
  const status = useApi<any>(isAdmin && access?.reason !== 'SUSPENDED' ? '/billing/status' : null);
  return (
    <div className="login">
      <div style={{ width: '100%', maxWidth: 460, marginBottom: 12, borderRadius: 10, overflow: 'hidden' }}><NoticeBar /></div>
      <div className="card stack" style={{ maxWidth: 460 }}>
        <span className="badge lg danger" style={{ alignSelf: 'flex-start' }}>Sistema fora do ar</span>
        <h1 style={{ margin: 0 }}>{access?.reason === 'SUSPENDED' ? 'Estabelecimento suspenso' : 'Assinatura não está em dia'}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {access?.reason === 'SUSPENDED' ? 'Fale com o suporte do Central.PDV para reativar.'
            : isAdmin ? 'Regularize o pagamento para liberar o sistema na hora. Seus dados continuam guardados.'
            : 'Peça ao administrador do estabelecimento para regularizar a assinatura.'}
        </p>
        {isAdmin && status.data && <BillingActions data={status.data} plans={false} />}
        {isAdmin && <HowTo />}
        {isAdmin && access?.reason !== 'SUSPENDED' && <PixPay onPaid={() => refreshAccess().catch(() => {})} />}
        <div className="row"><button className="btn ghost" onClick={() => refreshAccess().catch(() => {})}>Atualizar situação</button><span className="spacer" /><button className="btn ghost" onClick={logout}>Sair</button></div>
      </div>
      <SystemFooter />
    </div>
  );
}
