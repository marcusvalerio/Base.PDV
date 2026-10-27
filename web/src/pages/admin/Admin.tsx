import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi, useAction, useDebounced } from '../../lib/hooks';
import { money, dateTime, centsToInput, parseMoney, qty } from '../../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from '../../components/ui';
import { CustomerModal } from '../Fiado';
import { CashSummary } from '../../components/CashSummary';
import { useSession } from '../../components/session';
import { SaleModal } from '../../components/CancelSale';

export function Customers() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, loading, error, reload } = useApi<any[]>(`/customers?all=1&q=${encodeURIComponent(dq)}`);
  const [sel, setSel] = useState<number | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const total = (data ?? []).reduce((a, c) => a + c.balance_cents, 0);
  return (
    <div className="stack">
      <div className="page-head"><h1>Clientes</h1><span className="spacer" /><span className="muted">Fiado pendente: <b className="num">{money(total)}</b></span><button className="btn primary" onClick={() => setEdit({})}>Novo cliente</button></div>
      <input className="input" placeholder="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} />
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush">{!data?.length ? <Empty>Nenhum cliente.</Empty> : (
          <table className="table responsive"><thead><tr><th>Cliente</th><th>Telefone</th><th className="r">Saldo</th><th>Situação</th><th /></tr></thead><tbody>
            {data.map((c) => (
              <tr key={c.id}><td data-label="Cliente"><b>{c.name}</b>{c.notes && <div className="faint">{c.notes}</div>}</td><td data-label="Telefone">{c.phone ?? '—'}</td>
                <td data-label="Saldo" className="r num">{c.balance_cents > 0 ? <span className="badge warning">{money(c.balance_cents)}</span> : money(0)}</td>
                <td data-label="Situação">{c.active ? 'ativo' : <span className="badge">inativo</span>}</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}><button className="btn sm" onClick={() => setSel(c.id)}>Extrato</button><button className="btn sm ghost" onClick={() => setEdit(c)}>Editar</button></div></td></tr>
            ))}
          </tbody></table>
        )}</div>
      )}
      {sel && <CustomerModal id={sel} onClose={() => { setSel(null); reload(); }} />}
      {edit && <CustomerForm c={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function CustomerForm({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: c.name ?? '', phone: c.phone ?? '', notes: c.notes ?? '', active: c.active === undefined ? true : !!c.active });
  const toast = useToast();
  const [save, busy] = useAction(async () => {
    try {
      if (c.id) await api(`/customers/${c.id}`, { method: 'PATCH', body: { ...f, phone: f.phone || null, notes: f.notes || null } });
      else await api('/customers', { body: { name: f.name, phone: f.phone || null, notes: f.notes || null } });
      onSaved();
    } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title={c.id ? 'Editar cliente' : 'Novo cliente'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || f.name.trim().length < 2} onClick={save}>Salvar</button></>}>
      <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label="Telefone"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="Observações"><textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {c.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo (pode comprar a prazo)</label>}
    </Modal>
  );
}

export function Sales() {
  const { data, loading, error, reload } = useApi<any[]>('/sales');
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div className="stack">
      <div className="page-head"><h1>Vendas</h1><span className="faint">Últimas 200</span></div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush">{!data?.length ? <Empty>Nenhuma venda.</Empty> : (
          <table className="table responsive"><thead><tr><th>Nº</th><th>Data</th><th>Operador</th><th>Forma</th><th>Origem</th><th className="r">Total</th></tr></thead><tbody>
            {data.map((s) => (
              <tr key={s.id} className="click" onClick={() => setSel(s.id)}><td data-label="Nº">{s.id}</td><td data-label="Data">{dateTime(s.created_at)}</td><td data-label="Operador">{s.user_name}</td>
                <td data-label="Forma">{s.payment_method}{s.customer_name ? ` · ${s.customer_name}` : ''}</td><td data-label="Origem">{s.tab_label ?? 'Balcão'}</td>
                <td data-label="Total" className="r num">{s.status === 'CANCELLED' ? <span className="badge danger">cancelada</span> : money(s.total_cents)}</td></tr>
            ))}
          </tbody></table>
        )}</div>
      )}
      {sel && <SaleModal id={sel} onClose={() => setSel(null)} onChanged={reload} />}
    </div>
  );
}

export function OpenRegisters({ onSelect }: { onSelect?: (id: number) => void }) {
  const { data, loading } = useApi<any[]>('/cash/active');
  if (loading && !data) return <Loading />;
  return (
    <div className="card flush">
      <div style={{ padding: '14px 16px' }}><h2>Caixas abertos agora ({data?.length ?? 0})</h2></div>
      {!data?.length ? <Empty>Nenhum caixa aberto.</Empty> : (
        <table className="table responsive"><thead><tr><th>Operador</th><th>Aberto desde</th><th className="r">Vendas</th><th className="r">Faturamento</th><th className="r">Fiado recebido</th><th className="r">Dinheiro esperado</th></tr></thead><tbody>
          {data.map((r) => (
            <tr key={r.id} className={onSelect ? 'click' : ''} onClick={() => onSelect?.(r.id)}><td data-label="Operador"><b>{r.openedByName}</b></td><td data-label="Aberto desde">{dateTime(r.openedAt)}</td>
              <td data-label="Vendas" className="r num">{r.salesCount}</td><td data-label="Faturamento" className="r num">{money(r.salesTotalCents)}</td>
              <td data-label="Fiado recebido" className="r num">{money(r.receiptsTotalCents)}</td><td data-label="Dinheiro esperado" className="r num">{money(r.expectedCashCents)}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

export function Registers() {
  const { data, loading, error, reload } = useApi<any[]>('/cash');
  const [sel, setSel] = useState<number | null>(null);
  const detail = useApi<any>(sel ? `/cash/${sel}/closing` : null, [sel]);
  return (
    <div className="stack">
      <div className="page-head"><h1>Caixas</h1><span className="spacer" /><button className="btn sm" onClick={reload}>Atualizar</button></div>
      <OpenRegisters onSelect={setSel} />
      <h2>Histórico</h2>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush">{!data?.length ? <Empty>Nenhum caixa registrado.</Empty> : (
          <table className="table responsive"><thead><tr><th>Nº</th><th>Abertura</th><th>Fechamento</th><th className="r">Esperado</th><th className="r">Contado</th><th className="r">Diferença</th></tr></thead><tbody>
            {data.map((r) => (
              <tr key={r.id} className="click" onClick={() => setSel(r.id)}><td data-label="Nº">{r.id}</td><td data-label="Abertura">{dateTime(r.opened_at)} · {r.opened_by_name}</td>
                <td data-label="Fechamento">{r.closed_at ? `${dateTime(r.closed_at)} · ${r.closed_by_name}` : <span className="badge success">aberto</span>}</td>
                <td data-label="Esperado" className="r num">{money(r.expected_cash_cents)}</td><td data-label="Contado" className="r num">{money(r.counted_cash_cents)}</td>
                <td data-label="Diferença" className="r num">{r.counted_cash_cents == null ? '—' : <span className={r.counted_cash_cents - r.expected_cash_cents < 0 ? 'down' : ''}>{money(r.counted_cash_cents - r.expected_cash_cents)}</span>}</td></tr>
            ))}
          </tbody></table>
        )}</div>
      )}
      {sel && <Modal wide title={`Caixa nº ${sel}`} onClose={() => setSel(null)}>{detail.data ? <CashSummary s={detail.data} /> : <Loading />}</Modal>}
    </div>
  );
}

export function Users() {
  const { data, loading, error, reload } = useApi<any[]>('/users');
  const { boot, user } = useSession();
  const [edit, setEdit] = useState<any>(null);
  const [codeFor, setCodeFor] = useState<any>(null);
  return (
    <div className="stack">
      <div className="page-head"><h1>Usuários</h1><span className="spacer" /><button className="btn primary" onClick={() => setEdit({})}>Novo usuário</button></div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card flush"><table className="table responsive"><thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Situação</th>{boot?.cashCodeMode === 'INDIVIDUAL' && <th>Código de caixa</th>}<th /></tr></thead><tbody>
          {data!.map((u) => (
            <tr key={u.id}><td data-label="Nome"><b>{u.name}</b>{u.id === user?.id && <span className="faint"> (você)</span>}</td><td data-label="Login">{u.username}</td>
              <td data-label="Perfil">{u.is_super_admin ? <span className="badge accent">Super admin</span> : u.role === 'ADMIN' ? <span className="badge accent">Administrador</span> : 'Operador'}</td>
              <td data-label="Situação">{u.active ? <span className="badge success">ativo</span> : <span className="badge danger">bloqueado</span>}</td>
              {boot?.cashCodeMode === 'INDIVIDUAL' && <td data-label="Código de caixa">{u.has_cash_code ? 'definido' : <span className="badge warning">não definido</span>}</td>}
              <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                {boot?.cashCodeMode === 'INDIVIDUAL' && <button className="btn sm" onClick={() => setCodeFor(u)}>Código</button>}
                {(!u.is_super_admin || user?.superAdmin) && <button className="btn sm" onClick={() => setEdit(u)}>Editar</button>}</div></td></tr>
          ))}
        </tbody></table></div>
      )}
      {edit && <UserForm u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {codeFor && <CodeModal title={`Código de caixa de ${codeFor.name}`} path={`/users/${codeFor.id}/cash-code`} onClose={() => { setCodeFor(null); reload(); }} />}
    </div>
  );
}

function UserForm({ u, onClose, onSaved }: { u: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !u.id;
  const { user } = useSession();
  const [superAdmin, setSuper] = useState(false);
  const [f, setF] = useState({ name: u.name ?? '', username: u.username ?? '', password: '', role: u.role ?? 'OPERADOR', active: u.active === undefined ? true : !!u.active });
  const [err, setErr] = useState<string | null>(null);
  const [save, busy] = useAction(async () => {
    setErr(null);
    try {
      if (isNew) await api('/users', { body: { ...f, superAdmin } });
      else await api(`/users/${u.id}`, { method: 'PATCH', body: { name: f.name, role: f.role, active: f.active, ...(f.password ? { password: f.password } : {}) } });
      onSaved();
    } catch (e: any) { setErr(e.message); }
  });
  return (
    <Modal title={isNew ? 'Novo usuário' : `Editar ${u.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || f.name.trim().length < 2 || (isNew && (f.username.length < 3 || f.password.length < 8)) || (!!f.password && f.password.length < 8)} onClick={save}>Salvar</button></>}>
      <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      {isNew && <Field label="Login" hint="Letras, números, ponto, hífen ou sublinhado."><input className="input" autoCapitalize="none" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>}
      <Field label={isNew ? 'Senha' : 'Nova senha (deixe em branco para manter)'} hint="Mínimo de 8 caracteres. Trocar a senha encerra as sessões abertas."><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <Field label="Perfil"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="OPERADOR">Operador (PDV)</option><option value="ADMIN">Administrador</option></select></Field>
      {isNew && user?.superAdmin && f.role === 'ADMIN' && <label className="check"><input type="checkbox" checked={superAdmin} onChange={(e) => setSuper(e.target.checked)} /> Super administrador (libera módulos)</label>}
      {!isNew && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo (desmarque para bloquear o acesso)</label>}
      {err && <div className="notice danger">{err}</div>}
    </Modal>
  );
}

function CodeModal({ title, path, onClose }: { title: string; path: string; onClose: () => void }) {
  const [code, setCode] = useState('');
  const toast = useToast();
  const [save, busy] = useAction(async () => {
    try { await api(path, { method: 'PUT', body: { code } }); toast('Código salvo.', 'success'); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !/^\d{4,8}$/.test(code)} onClick={save}>Salvar</button></>}>
      <Field label="Novo código (4 a 8 dígitos)" hint="O código é armazenado de forma protegida e não pode ser consultado depois."><input className="input lg" type="password" inputMode="numeric" autoComplete="new-password" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
    </Modal>
  );
}

export function Settings() {
  const { data, loading, error, reload, setData } = useApi<any>('/settings');
  const cats = useApi<any[]>('/categories');
  const { refreshBoot, user } = useSession();
  const [f, setF] = useState<any>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [newCat, setNewCat] = useState('');
  const toast = useToast();
  const cardIn = (mode: string, val: string) => { const n = Number(val || 0); if (!n) return ''; return mode === 'UNIT' ? centsToInput(n) : String(n / 100).replace('.', ','); };
  const cardOut = (mode: string, txt: string): number | null => { const t = String(txt ?? '').trim(); if (!t) return 0; if (mode === 'UNIT') return parseMoney(t); const n = Number(t.replace('%', '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null; };
  const v = f ?? (data && { ...data, surcharge: centsToInput(Number(data.fiado_surcharge_cents)),
    debitTxt: cardIn(data.card_debit_surcharge_mode, data.card_debit_surcharge_value), creditTxt: cardIn(data.card_credit_surcharge_mode, data.card_credit_surcharge_value) });
  const [save, busy] = useAction(async () => {
    const s = parseMoney(v.surcharge);
    if (s == null) return toast('Acréscimo do fiado inválido.', 'error');
    const deb = cardOut(v.card_debit_surcharge_mode, v.debitTxt), cre = cardOut(v.card_credit_surcharge_mode, v.creditTxt);
    if (deb == null || cre == null) return toast('Acréscimo do cartão inválido.', 'error');
    try {
      setData(await api('/settings', { method: 'PUT', body: { store_name: v.store_name ?? '', store_logo_url: v.store_logo_url ?? '', ...(user?.superAdmin ? { contact_whatsapp: v.contact_whatsapp ?? '' } : {}), fiado_surcharge_cents: s, card_debit_surcharge_mode: v.card_debit_surcharge_mode, card_debit_surcharge_value: deb, card_credit_surcharge_mode: v.card_credit_surcharge_mode, card_credit_surcharge_value: cre, cash_code_mode: v.cash_code_mode, expiry_alert_days: v.expiry_alert_days, restock_lead_time_days: v.restock_lead_time_days, restock_safety_days: v.restock_safety_days, allow_negative_stock: v.allow_negative_stock, inventory_accuracy_target: String(v.inventory_accuracy_target ?? '').replace(',', '.') } }));
      setF(null); await refreshBoot(); toast('Configurações salvas.', 'success');
    } catch (e: any) { toast(e.message, 'error'); }
  });
  const [addCat] = useAction(async () => {
    try { await api('/categories', { body: { name: newCat } }); setNewCat(''); cats.reload(); refreshBoot(); } catch (e: any) { toast(e.message, 'error'); }
  });
  const toggleCat = async (c: any) => { try { await api(`/categories/${c.id}`, { method: 'PATCH', body: { active: !c.active } }); cats.reload(); refreshBoot(); } catch (e: any) { toast(e.message, 'error'); } };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const set = (k: string) => (e: any) => setF({ ...v, [k]: e.target.type === 'checkbox' ? String(e.target.checked) : e.target.value });
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head"><h1>Configurações</h1></div>
      <div className="card stack">
        <h2>Estabelecimento</h2>
        <Field label="Nome do estabelecimento" hint="Aparece no topo do sistema e na tela de entrada.">
          <input className="input" style={{ maxWidth: 360 }} maxLength={60} placeholder="Ex.: Bar do Zé" value={v.store_name ?? ''} onChange={set('store_name')} />
        </Field>
        <Field label="Logo ou foto (link https)" hint="Cole o link de uma imagem. Vazio = sem logo.">
          <div className="row"><input className="input" inputMode="url" placeholder="https://…" value={v.store_logo_url ?? ''} onChange={set('store_logo_url')} />{v.store_logo_url && /^https:\/\//.test(v.store_logo_url) && <img className="store-logo lg" src={v.store_logo_url} alt="Prévia da logo" />}</div>
        </Field>
        {user?.superAdmin && <Field label="WhatsApp de contato da página de apresentação" hint="DDD + número. Aparece como botão em /conheca. Vazio = sem botão.">
          <input className="input num" style={{ maxWidth: 240 }} inputMode="tel" placeholder="(11) 99999-9999" value={v.contact_whatsapp ?? ''} onChange={set('contact_whatsapp')} />
        </Field>}
      </div>
      <div className="card stack">
        <h2>Venda a prazo (fiado)</h2>
        <Field label="Acréscimo por unidade vendida a prazo (R$)" hint="Ex.: R$ 0,50 → 3 cervejas + 1 salgadinho = R$ 2,00. Chopp e produtos por kg contam 1 por item. Vale só para novas vendas; dívidas já registradas não mudam.">
          <input className="input num" style={{ maxWidth: 160 }} inputMode="decimal" value={v.surcharge} onChange={set('surcharge')} />
        </Field>
      </div>
      <div className="card stack">
        <h2>Cartão</h2>
        <div className="faint">Acréscimo aplicado quando a venda é paga no débito ou no crédito. Deixe em branco para não cobrar acréscimo. O valor aparece para a operadora antes de confirmar.</div>
        {(['debit', 'credit'] as const).map((k) => {
          const modeKey = `card_${k}_surcharge_mode`, txtKey = k === 'debit' ? 'debitTxt' : 'creditTxt';
          return (
            <div key={k} className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end' }}>
              <Field label={k === 'debit' ? 'Débito: tipo de acréscimo' : 'Crédito: tipo de acréscimo'}>
                <select className="input" value={v[modeKey]} onChange={(e) => setF({ ...v, [modeKey]: e.target.value, [txtKey]: '' })}>
                  <option value="PERCENT">% sobre o total</option><option value="UNIT">R$ por unidade (igual ao fiado)</option>
                </select>
              </Field>
              <Field label={v[modeKey] === 'UNIT' ? 'Valor por unidade (R$)' : 'Percentual (%)'}>
                <input className="input num" inputMode="decimal" placeholder={v[modeKey] === 'UNIT' ? '0,00' : 'ex.: 3,5'} value={v[txtKey]} onChange={set(txtKey)} />
              </Field>
            </div>
          );
        })}
      </div>
      <div className="card stack">
        <h2>Caixa</h2>
        <Field label="Código para abrir e fechar o caixa">
          <select className="input" style={{ maxWidth: 360 }} value={v.cash_code_mode} onChange={set('cash_code_mode')}>
            <option value="SHARED">Código único do estabelecimento</option><option value="INDIVIDUAL">Código individual por usuário</option>
          </select>
        </Field>
        {v.cash_code_mode === 'SHARED' && <div className="row wrap"><span className={`badge ${data.shared_cash_code_configured ? 'success' : 'warning'}`}>{data.shared_cash_code_configured ? 'Código definido' : 'Código não definido'}</span><button className="btn sm" onClick={() => setCodeOpen(true)}>{data.shared_cash_code_configured ? 'Trocar código' : 'Definir código'}</button></div>}
        {v.cash_code_mode === 'INDIVIDUAL' && <div className="faint">Defina o código de cada pessoa em Usuários.</div>}
      </div>
      <div className="card stack">
        <h2>Cancelamento de vendas</h2>
        <div className="faint">Código único pedido para cancelar qualquer venda (inclusive de mesas, cujos itens voltam para a mesa). Use um código diferente do caixa se só pessoas de confiança puderem cancelar.</div>
        <div className="row wrap"><span className={`badge ${data.cancel_code_configured ? 'success' : 'warning'}`}>{data.cancel_code_configured ? 'Código definido' : 'Código não definido'}</span><button className="btn sm" onClick={() => setCancelOpen(true)}>{data.cancel_code_configured ? 'Trocar código' : 'Definir código'}</button></div>
      </div>
      <div className="card stack">
        <h2>Estoque e reposição</h2>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <Field label="Alertar validade com (dias)"><input className="input num" inputMode="numeric" value={v.expiry_alert_days} onChange={set('expiry_alert_days')} /></Field>
          <Field label="Prazo de reposição (dias)" hint="Vazio = não informado."><input className="input num" inputMode="numeric" value={v.restock_lead_time_days} onChange={set('restock_lead_time_days')} /></Field>
          <Field label="Reserva de segurança (dias)" hint="Vazio = sem reserva."><input className="input num" inputMode="numeric" value={v.restock_safety_days} onChange={set('restock_safety_days')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={v.allow_negative_stock === 'true'} onChange={set('allow_negative_stock')} /> Permitir vender mesmo sem estoque registrado (o estoque fica negativo e aparece nos alertas)</label>
      </div>
      <div className="card stack">
        <h2>Inventário</h2>
        <Field label="Meta de acuracidade por item (%)" hint="Ex.: 98. Cada inventário concluído é comparado com esta meta. Vazio = sem meta.">
          <input className="input num" style={{ maxWidth: 160 }} inputMode="decimal" value={v.inventory_accuracy_target} onChange={set('inventory_accuracy_target')} />
        </Field>
      </div>
      <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy || !f} onClick={save}>Salvar configurações</button></div>
      <div className="card stack">
        <h2>Categorias</h2>
        <div className="row wrap">{cats.data?.map((c) => <button key={c.id} className={`chip ${c.active ? '' : ''}`} style={{ opacity: c.active ? 1 : 0.5 }} onClick={() => toggleCat(c)} title={c.active ? 'Clique para desativar' : 'Clique para reativar'}>{c.name}{!c.active && ' (inativa)'}</button>)}</div>
        <div className="row"><input className="input" placeholder="Nova categoria" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><button className="btn" disabled={!newCat.trim()} onClick={addCat}>Adicionar</button></div>
        <div className="faint">Clique em uma categoria para ativar ou desativar.</div>
      </div>
      {cancelOpen && <CodeModal title="Código de cancelamento" path="/settings/cancel-code" onClose={() => { setCancelOpen(false); reload(); }} />}
      {codeOpen && <CodeModal title="Código único do caixa" path="/settings/cash-code" onClose={() => { setCodeOpen(false); reload(); }} />}
    </div>
  );
}

export function Audit() {
  const { data, loading } = useApi<any[]>('/audit');
  return (
    <div className="stack">
      <div className="page-head"><h1>Auditoria</h1><span className="faint">Últimos 300 registros</span></div>
      {loading && !data ? <Loading /> : <div className="card flush">{!data?.length ? <Empty>Sem registros.</Empty> : (
        <table className="table responsive"><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>
          {data.map((a) => <tr key={a.id}><td data-label="Quando">{dateTime(a.at)}</td><td data-label="Usuário">{a.user_name ?? '—'}</td><td data-label="Ação"><code>{a.action}</code>{a.entity_id ? ` #${a.entity_id}` : ''}</td><td data-label="Detalhes" className="faint" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.details_json}</td></tr>)}
        </tbody></table>
      )}</div>}
    </div>
  );
}

export function Modules() {
  const { user, refreshBoot } = useSession();
  const { data, loading, error, reload, setData } = useApi<any>('/modules');
  const toast = useToast();
  const [toggle] = useAction(async (k: string, v: boolean) => {
    try { setData(await api('/modules', { method: 'PUT', body: { [k]: v } })); await refreshBoot(); toast(v ? 'Módulo liberado.' : 'Módulo bloqueado.', 'success'); } catch (e: any) { toast(e.message, 'error'); }
  });
  if (!user?.superAdmin) return <div className="notice">Somente o super administrador acessa esta tela.</div>;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack" style={{ maxWidth: 680 }}>
      <div className="page-head"><h1>Liberações</h1></div>
      <div className="faint">Os módulos abaixo só aparecem e funcionam (inclusive pela API) depois de liberados aqui. Vender, Caixa, Produtos, Vendas, Caixas, Usuários e Configurações estão sempre disponíveis.</div>
      <div className="card flush">
        {Object.entries(data.labels as Record<string, string>).map(([k, label]) => (
          <label key={k} className="list-item" style={{ cursor: 'pointer' }}>
            <span><b>{label}</b></span><span className="spacer" />
            <span className={`badge ${data.modules[k] ? 'success' : ''}`}>{data.modules[k] ? 'liberado' : 'bloqueado'}</span>
            <input type="checkbox" style={{ width: 22, height: 22 }} checked={!!data.modules[k]} onChange={(e) => toggle(k, e.target.checked)} aria-label={`Liberar ${label}`} />
          </label>
        ))}
      </div>
    </div>
  );
}
