import { useApi, useAction } from '../lib/hooks';
import { api } from '../lib/api';
import { date } from '../lib/format';
import { Loading, ErrorState, useToast } from '../components/ui';
import { useSession } from '../components/session';
import { SystemFooter } from '../components/SystemFooter';
import { NoticeBar } from '../components/NoticeBar';

const STATUS: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  active: ['Em dia', 'success'], trialing: ['Em teste', 'success'], past_due: ['Pagamento recusado', 'danger'],
  unpaid: ['Não pago', 'danger'], canceled: ['Cancelada', 'danger'], incomplete: ['Pagamento pendente', 'warning'],
  incomplete_expired: ['Expirada', 'danger'], paused: ['Pausada', 'warning'],
};

/** Botões para assinar (Checkout) ou gerenciar pagamento (Portal do Stripe). */
function BillingActions({ data }: { data: any }) {
  const toast = useToast();
  const [go, busy] = useAction(async (kind: 'checkout' | 'portal') => {
    try { const r = await api<{ url: string }>(`/billing/${kind}`, { body: {} }); window.location.href = r.url; } catch (e: any) { toast(e.message, 'error'); }
  });
  if (!data.configured) return <div className="notice warning">O pagamento online ainda não foi configurado. Fale com o suporte do Central.PDV.</div>;
  const valid = data.status === 'active' || data.status === 'trialing';
  return (
    <div className="row wrap">
      {!valid && <button className="btn primary lg" disabled={busy} onClick={() => go('checkout')}>{data.hasCustomer ? 'Assinar novamente' : 'Assinar agora'}</button>}
      {data.hasCustomer && <button className={`btn ${valid ? 'primary' : ''} lg`} disabled={busy} onClick={() => go('portal')}>Atualizar cartão e ver faturas</button>}
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
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-head"><h1>Assinatura</h1></div>
      {ok && <div className="notice">Pagamento recebido pelo Stripe. A liberação acontece em instantes; se ainda aparecer bloqueado, toque em Atualizar.</div>}
      <div className="card stack">
        <div className="row wrap"><span className="muted">Situação</span><span className="spacer" /><span className={`badge lg ${tone}`}>{label}</span></div>
        {data.currentPeriodEnd && data.status === 'active' && <div className="row"><span className="muted">Próxima cobrança</span><span className="spacer" /><b>{date(data.currentPeriodEnd)}</b></div>}
        {data.trialEndsAt && !data.exempt && <div className="row"><span className="muted">Teste grátis até</span><span className="spacer" /><b>{date(data.trialEndsAt)}</b></div>}
        <div className="faint">Sem pagamento em dia o sistema fica fora do ar para todos do estabelecimento. Os dados ficam guardados e voltam assim que o pagamento é confirmado.</div>
        {!data.exempt && <BillingActions data={data} />}
        <div><button className="btn ghost sm" onClick={reload}>Atualizar</button></div>
      </div>
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
        {isAdmin && status.data && <BillingActions data={status.data} />}
        <div className="row"><button className="btn ghost" onClick={() => refreshAccess().catch(() => {})}>Já paguei, verificar</button><span className="spacer" /><button className="btn ghost" onClick={logout}>Sair</button></div>
      </div>
      <SystemFooter />
    </div>
  );
}
