import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi, useDebounced, useAction } from '../lib/hooks';
import { money, qty, parseQty, isFractional, Unit, parseMoney, UNIT_SHORT } from '../lib/format';
import { Modal, Loading, ErrorState, Empty, Field, useToast } from './ui';
import { useSession } from './session';
import { useHidScanner, CameraButton } from './scanner';
import { ProductArt } from './ProductArt';

export interface Product { id: number; name: string; image_url?: string | null; unit: Unit; price_cents: number; stock_milli: number; category_id: number; category: string; barcode: string | null; internal_code: string | null }

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
  const toast = useToast();
  /** Leitura de código (coletor, câmera ou Enter no campo): busca exata no servidor. */
  const byCode = async (code: string) => {
    try {
      const p = await api<Product>(`/products/by-code/${encodeURIComponent(code.trim())}`);
      if (!(p as any).active) return toast(`"${p.name}" está inativo.`, 'error');
      pick(p);
      setQ('');
      return true;
    } catch (e: any) { return false; }
  };
  useHidScanner((code) => { byCode(code).then((ok) => ok === false && toast(`Código ${code} não cadastrado.`, 'error')); });
  const onKey = async (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !q.trim()) return;
    if (await byCode(q)) return;
    if (data?.length === 1) { pick(data[0]); setQ(''); }
    else if (/^\d{6,}$/.test(q.trim())) toast(`Código ${q.trim()} não cadastrado.`, 'error');
  };

  return (
    <div className="stack">
      <div className="row">
        <input ref={input} className="input lg" placeholder="Buscar produto ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Buscar produto" />
        <CameraButton onScan={(c) => { byCode(c).then((ok) => ok === false && toast(`Código ${c} não cadastrado.`, 'error')); }} />
      </div>
      <div className="chips">
        <button className={`chip ${cat === null ? 'active' : ''}`} onClick={() => setCat(null)}>Todos</button>
        {boot?.categories.map((c) => <button key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <Empty>Nenhum produto encontrado.</Empty> : (
        <div className="tiles">
          {data.map((p) => (
            <button key={p.id} className="tile" onClick={() => pick(p)}>
              <ProductArt image={p.image_url} category={p.category} />
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
      <Field group label={isL ? 'Outra quantidade (ex.: 700ml ou 0,7)' : 'Outra quantidade (ex.: 350g ou 0,35)'}>
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
/** Unidades que contam para acréscimos: cada unidade/pacote conta 1; chopp/kg contam 1 por item. Igual ao servidor. */
export const surchargeUnits = (lines: { unit: Unit; qtyMilli: number }[]) => lines.reduce((a, l) => a + (isFractional(l.unit) ? 1 : Math.round(l.qtyMilli / 1000)), 0);

/** Prévia do acréscimo (o valor final é sempre calculado no servidor). */
function previewSurcharge(boot: any, code: string | null, subtotal: number, units: number) {
  if (!code || !boot) return 0;
  if (code === 'FIADO') return (boot.fiadoSurchargeCents ?? 0) * units;
  const c = boot.cardSurcharge?.[code];
  if (!c || !c.value) return 0;
  return c.mode === 'UNIT' ? c.value * units : Math.round((subtotal * c.value) / 10000);
}

export function CheckoutModal({ title, subtotalCents, units, onClose, onConfirm, busy, error }: {
  title: string; subtotalCents: number; units: number; onClose: () => void; onConfirm: (r: CheckoutResult) => void; busy: boolean; error?: string | null;
}) {
  const { boot } = useSession();
  const [method, setMethod] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [received, setReceived] = useState('');
  const pm = boot?.paymentMethods.find((m) => m.code === method);
  const cards = boot?.paymentMethods.filter((m) => m.kind === 'CARD') ?? [];
  const others = boot?.paymentMethods.filter((m) => m.kind !== 'CARD') ?? [];
  const surcharge = previewSurcharge(boot, method, subtotalCents, units);
  const cardHint = (code: string) => { const v = previewSurcharge(boot, code, subtotalCents, units); return v > 0 ? `+ ${money(v)}` : 'sem acréscimo'; };
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
      {surcharge > 0 && <div className="notice">Inclui acréscimo {pm?.kind === 'CREDIT' ? 'da venda a prazo' : `do ${pm?.name.toLowerCase()}`}: {money(surcharge)} (produtos: {money(subtotalCents)}).</div>}
      <div className="pay-grid">
        {others.filter((m) => m.kind !== 'CREDIT').map((m) => <button key={m.code} className={`pay-btn ${method === m.code ? 'active' : ''}`} onClick={() => { setMethod(m.code); setCardOpen(false); }} aria-pressed={method === m.code}>{m.name}</button>)}
        {cards.length > 0 && <button className={`pay-btn ${pm?.kind === 'CARD' || cardOpen ? 'active' : ''}`} onClick={() => { setCardOpen(true); if (pm?.kind !== 'CARD') setMethod(null); }} aria-pressed={pm?.kind === 'CARD'}>Cartão</button>}
        {others.filter((m) => m.kind === 'CREDIT').map((m) => <button key={m.code} className={`pay-btn ${method === m.code ? 'active' : ''}`} onClick={() => { setMethod(m.code); setCardOpen(false); }} aria-pressed={method === m.code}>{m.name}</button>)}
      </div>
      {(cardOpen || pm?.kind === 'CARD') && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 13, fontWeight: 550 }}>Débito ou crédito?</span>
          <div className="pay-grid">
            {cards.map((m) => (
              <button key={m.code} className={`pay-btn ${method === m.code ? 'active' : ''}`} onClick={() => setMethod(m.code)} aria-pressed={method === m.code}>
                {m.code === 'CARTAO_DEBITO' ? 'Débito' : m.code === 'CARTAO_CREDITO' ? 'Crédito' : m.name}
                <div className="faint num" style={{ fontWeight: 500 }}>{cardHint(m.code)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
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
      {pm?.kind === 'CREDIT' && <Field group label="Cliente"><CustomerPicker value={customer} onChange={setCustomer} /></Field>}
      {error && <div className="notice danger">{error}</div>}
    </Modal>
  );
}
