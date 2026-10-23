import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi, useDebounced, useAction } from '../lib/hooks';
import { money, qty, parseQty, isFractional, Unit, parseMoney, UNIT_SHORT } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from './ui';
import { useSession } from './session';

export interface Product { id: number; name: string; unit: Unit; price_cents: number; stock_milli: number; category_id: number; category: string; barcode: string | null; internal_code: string | null }

/** Busca e seleção de produtos. Enter com código de barras/código interno adiciona direto. */
export function ProductPicker({ onPick }: { onPick: (p: Product, qtyMilli: number) => void }) {
  const { boot } = useSession();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<number | null>(null);
  const dq = useDebounced(q, 150);
  const { data, loading, error, reload } = useApi<Product[]>(`/products?${new URLSearchParams({ ...(dq ? { q: dq } : {}), ...(cat ? { categoryId: String(cat) } : {}) })}`, []);
  const [volumeFor, setVolumeFor] = useState<Product | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const pick = (p: Product) => {
    if (isFractional(p.unit)) setVolumeFor(p);
    else onPick(p, 1000);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !data?.length) return;
    const exact = data.find((p) => p.barcode === q.trim() || p.internal_code === q.trim());
    const target = exact ?? (data.length === 1 ? data[0] : null);
    if (target) { pick(target); setQ(''); }
  };

  return (
    <div className="stack">
      <input ref={input} className="input lg" placeholder="Buscar produto ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Buscar produto" />
      <div className="chips">
        <button className={`chip ${cat === null ? 'active' : ''}`} onClick={() => setCat(null)}>Todos</button>
        {boot?.categories.map((c) => <button key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <Empty>Nenhum produto encontrado.</Empty> : (
        <div className="tiles">
          {data.map((p) => (
            <button key={p.id} className="tile" onClick={() => pick(p)}>
              <span className="name">{p.name}</span>
              <span className="faint">{p.category}{p.stock_milli <= 0 ? ' · sem estoque' : ''}</span>
              <span className="price num">{money(p.price_cents)}{p.unit !== 'UN' && <span className="faint"> / {UNIT_SHORT[p.unit]}</span>}</span>
            </button>
          ))}
        </div>
      )}
      {volumeFor && <VolumeModal product={volumeFor} onClose={() => setVolumeFor(null)} onConfirm={(m) => { onPick(volumeFor, m); setVolumeFor(null); }} />}
    </div>
  );
}

const VOLUME_PRESETS = [300, 400, 500, 1000, 1500, 2000];

/** Seleção de volume para chopp (ou peso), com valor calculado automaticamente. */
export function VolumeModal({ product, onClose, onConfirm }: { product: Product; onClose: () => void; onConfirm: (milli: number) => void }) {
  const [custom, setCustom] = useState('');
  const milli = parseQty(custom, product.unit);
  const isL = product.unit === 'L';
  return (
    <Modal title={product.name} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>Preço: {money(product.price_cents)} por {isL ? 'litro' : 'kg'}. Escolha a quantidade:</p>
      <div className="pay-grid">
        {(isL ? VOLUME_PRESETS : [100, 250, 500, 1000]).map((m) => (
          <button key={m} className="pay-btn" onClick={() => onConfirm(m)}>
            {qty(m, product.unit)}<div className="faint num">{money(Math.round(product.price_cents * m / 1000))}</div>
          </button>
        ))}
      </div>
      <Field label={isL ? 'Outra quantidade (ex.: 700ml ou 0,7)' : 'Outra quantidade (ex.: 350g ou 0,35)'}>
        <div className="row">
          <input className="input" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && milli && onConfirm(milli)} />
          <button className="btn primary" disabled={!milli} onClick={() => milli && onConfirm(milli)}>Adicionar</button>
        </div>
      </Field>
      {custom && (milli ? <div className="notice">{qty(milli, product.unit)} = <b>{money(Math.round(product.price_cents * milli / 1000))}</b></div> : <div className="error-text">Quantidade inválida.</div>)}
    </Modal>
  );
}

export function Stepper({ value, unit, onChange }: { value: number; unit: Unit; onChange: (v: number) => void }) {
  const step = isFractional(unit) ? 100 : 1000;
  return (
    <div className="stepper">
      <button aria-label="Diminuir" onClick={() => onChange(value - step)}>−</button>
      <span className="num">{qty(value, unit)}</span>
      <button aria-label="Aumentar" onClick={() => onChange(value + step)}>+</button>
    </div>
  );
}

interface Customer { id: number; name: string; phone: string | null; balance_cents: number }

export function CustomerPicker({ value, onChange }: { value: Customer | null; onChange: (c: Customer | null) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const { data, loading, reload } = useApi<Customer[]>(`/customers?q=${encodeURIComponent(dq)}`, []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const toast = useToast();
  const [create, busy] = useAction(async () => {
    try {
      const r = await api<{ id: number }>('/customers', { body: { name, phone: phone || null } });
      onChange({ id: r.id, name, phone, balance_cents: 0 });
      setCreating(false);
      reload();
    } catch (e: any) { toast(e.message, 'error'); }
  });
  if (value) {
    return (
      <div className="notice row"><div><b>{value.name}</b><div className="faint">Saldo atual: {money(value.balance_cents)}</div></div><span className="spacer" /><button className="btn sm" onClick={() => onChange(null)}>Trocar</button></div>
    );
  }
  if (creating) {
    return (
      <div className="stack card">
        <Field label="Nome do cliente"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Telefone (opcional)"><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <div className="row"><button className="btn" onClick={() => setCreating(false)}>Voltar</button><button className="btn primary" disabled={busy || name.trim().length < 2} onClick={create}>Cadastrar cliente</button></div>
      </div>
    );
  }
  return (
    <div className="stack">
      <input className="input" placeholder="Buscar cliente pelo nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="card flush" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {loading && !data ? <Loading /> : !data?.length ? <Empty>Nenhum cliente encontrado.</Empty> : data.map((c) => (
          <button key={c.id} className="list-item" onClick={() => onChange(c)}>
            <span><b>{c.name}</b>{c.phone && <span className="faint"> · {c.phone}</span>}</span><span className="spacer" />
            <span className="faint num">{c.balance_cents > 0 ? `deve ${money(c.balance_cents)}` : 'sem débito'}</span>
          </button>
        ))}
      </div>
      <button className="btn" onClick={() => { setName(q); setCreating(true); }}>+ Novo cliente</button>
    </div>
  );
}

export interface CheckoutResult { paymentMethodCode: string; customerId: number | null; receivedCents: number | null }

/** Etapa de pagamento: forma, cliente (fiado), valor recebido e troco. */
export function CheckoutModal({ title, subtotalCents, onClose, onConfirm, busy, error }: {
  title: string; subtotalCents: number; onClose: () => void; onConfirm: (r: CheckoutResult) => void; busy: boolean; error?: string | null;
}) {
  const { boot } = useSession();
  const [method, setMethod] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [received, setReceived] = useState('');
  const pm = boot?.paymentMethods.find((m) => m.code === method);
  const surcharge = pm?.kind === 'CREDIT' ? boot?.fiadoSurchargeCents ?? 0 : 0;
  const total = subtotalCents + surcharge;
  const receivedCents = parseMoney(received);
  const change = receivedCents != null ? receivedCents - total : null;
  const quick = useMemo(() => {
    const opts = new Set<number>([total]);
    for (const b of [500, 1000, 2000, 5000, 10000, 20000]) if (b > total) opts.add(Math.ceil(total / b) * b);
    return [...opts].sort((a, b) => a - b).slice(0, 4);
  }, [total]);
  const canConfirm = !!pm && !busy && (pm.kind !== 'CREDIT' || !!customer) && (pm.kind !== 'CASH' || (receivedCents != null && receivedCents >= total));
  const confirm = () => canConfirm && onConfirm({ paymentMethodCode: pm!.code, customerId: customer?.id ?? null, receivedCents: pm!.kind === 'CASH' ? receivedCents : null });

  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn lg" onClick={onClose} disabled={busy}>Voltar</button>
      <button className="btn primary lg" onClick={confirm} disabled={!canConfirm}>{busy ? 'Registrando…' : `Confirmar ${money(total)}`}</button>
    </>}>
      <div className="row"><span className="muted">Total a pagar</span><span className="spacer" /><span className="total-big num">{money(total)}</span></div>
      {surcharge > 0 && <div className="notice">Inclui acréscimo de venda a prazo: {money(surcharge)} (produtos: {money(subtotalCents)}).</div>}
      <div className="pay-grid">
        {boot?.paymentMethods.map((m) => <button key={m.code} className={`pay-btn ${method === m.code ? 'active' : ''}`} onClick={() => setMethod(m.code)} aria-pressed={method === m.code}>{m.name}</button>)}
      </div>
      {pm?.kind === 'CASH' && (
        <div className="stack">
          <Field label="Valor recebido do cliente">
            <input className="input lg num" inputMode="decimal" placeholder="0,00" value={received} onChange={(e) => setReceived(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && confirm()} />
          </Field>
          <div className="row wrap">{quick.map((v) => <button key={v} className="btn" onClick={() => setReceived((v / 100).toFixed(2).replace('.', ','))}>{v === total ? 'Valor exato' : money(v)}</button>)}</div>
          {change != null && (change >= 0
            ? <div className="notice success row"><span>Troco a devolver</span><span className="spacer" /><b className="total-big num" style={{ fontSize: 28 }}>{money(change)}</b></div>
            : <div className="notice danger">Faltam {money(-change)}.</div>)}
        </div>
      )}
      {pm?.kind === 'CREDIT' && <Field label="Cliente"><CustomerPicker value={customer} onChange={setCustomer} /></Field>}
      {error && <div className="notice danger">{error}</div>}
    </Modal>
  );
}
