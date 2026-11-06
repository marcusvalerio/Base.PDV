import { useEffect, useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { money, qty } from '../lib/format';
import { ProductPicker, Stepper, CheckoutModal, CheckoutResult, Product, surchargeUnits, previewSurcharge } from '../components/pos';
import { enqueueSale, ownerOf } from '../lib/offline';
import { printSaleReceipt, getPrinter } from '../lib/print';
import { useSession } from '../components/session';
import { Modal, useToast, Empty, Field } from '../components/ui';
import { parseMoney, centsToInput } from '../lib/format';
import { useAction } from '../lib/hooks';
import { RegisterGate } from '../components/RegisterGate';
import { ProductArt } from '../components/ProductArt';

/** price: preço só desta venda (autorizado com o código de cancelamento). */
interface Line { product: Product; qtyMilli: number; price?: number }
const STORE = 'pdv.cart';
const unitPrice = (l: Line) => l.price ?? l.product.price_cents;
const lineTotal = (l: Line) => Math.round(unitPrice(l) * l.qtyMilli / 1000);

function loadCart(): Line[] {
  try { return JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch { return []; }
}

export default function Pos() {
  return <RegisterGate><PosInner /></RegisterGate>;
}

function PosInner() {
  const [cart, setCart] = useState<Line[]>(loadCart);
  const [checkout, setCheckout] = useState(false);
  const [mobileCart, setMobileCart] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // Autorização da mudança de preço (vale para esta venda): código e motivo, conferidos de novo ao registrar.
  const [priceAuth, setPriceAuth] = useState<{ code: string; reason: string } | null>(null);
  const [pricing, setPricing] = useState<number | null>(null);
  const key = useRef<string>(newKey());
  const toast = useToast();
  const { user, boot } = useSession();
  // Mantém no aparelho a lista completa de produtos para vender sem internet.
  useEffect(() => { if (navigator.onLine) api('/products').catch(() => {}); }, []);
  useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify(cart)); } catch { /* sem armazenamento */ } }, [cart]);

  const add = (p: Product, m: number) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id && (p.unit === 'UN' || p.unit === 'PCT'));
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qtyMilli: l.qtyMilli + m } : l));
      return [...c, { product: p, qtyMilli: m }];
    });
    toast(`${p.name} adicionado`);
  };
  const setQty = (i: number, v: number) => setCart((c) => (v <= 0 ? c.filter((_, j) => j !== i) : c.map((l, j) => (j === i ? { ...l, qtyMilli: v } : l))));
  const total = cart.reduce((a, l) => a + lineTotal(l), 0);
  const count = cart.length;

  const openCheckout = () => { key.current = newKey(); setError(null); setCheckout(true); setMobileCart(false); };
  const [confirm, busy] = useAction(async (r: CheckoutResult) => {
    setError(null);
    const changed = cart.some((l) => l.price != null && l.price !== l.product.price_cents);
    const body = { items: cart.map((l) => ({ productId: l.product.id, qtyMilli: l.qtyMilli, ...(l.price != null && l.price !== l.product.price_cents ? { unitPriceCents: l.price } : {}) })), ...(changed && priceAuth ? { priceAuth } : {}), ...r };
    const kind = boot?.paymentMethods.find((m) => m.code === r.paymentMethodCode)?.kind;
    const saveOffline = () => {
      // Sem internet: guarda a venda no aparelho; o total e o troco são uma prévia (o servidor confirma ao enviar).
      const units = surchargeUnits(cart.map((l) => ({ unit: l.product.unit, qtyMilli: l.qtyMilli })));
      const totalCents = total + previewSurcharge(boot, r.paymentMethodCode, total, units);
      const method = boot?.paymentMethods.find((m) => m.code === r.paymentMethodCode)?.name ?? '';
      enqueueSale({ key: key.current, owner: ownerOf(user)!, body, at: new Date().toISOString(), totalCents, label: `${method} · ${cart.map((l) => `${qty(l.qtyMilli, l.product.unit)} ${l.product.name}`).join(', ')}` });
      setCart([]); setPriceAuth(null); setCheckout(false);
      setDone({ offline: true, total_cents: totalCents, payment_method: method, change_cents: r.receivedCents != null ? r.receivedCents - totalCents : null,
        items: cart.map((l) => ({ qty_milli: l.qtyMilli, unit: l.product.unit, product_name: l.product.name })) });
    };
    if (!navigator.onLine && kind !== 'CREDIT') return saveOffline();
    try {
      const sale = await api('/sales', { body: { idempotencyKey: key.current, ...body } });
      setCart([]); setPriceAuth(null); setCheckout(false); setDone(sale);
      const pr = getPrinter();
      if (pr.auto && pr.width) printSaleReceipt(sale, { storeName: boot?.storeName, width: pr.width });
    } catch (e: any) {
      if (e?.code === 'NETWORK' && kind !== 'CREDIT') return saveOffline();
      // Mantém a mesma chave: tentar de novo não duplica a venda.
      setError(e.message);
    }
  });

  const cartView = (
    <>
      <div className="cart-list">
        {!cart.length ? <Empty>Nenhum produto no pedido.<br />Toque em um produto para adicionar.</Empty> : cart.map((l, i) => (
          <div className="cart-line with-art" key={i}>
            <ProductArt size="sm" image={l.product.image_url} category={l.product.category} name={l.product.name} />
            <b>{l.product.name}</b><b className="num">{money(lineTotal(l))}</b>
            {l.price != null && l.price !== l.product.price_cents && <span className="price-changed">de <s>{money(l.product.price_cents)}</s> por <b>{money(l.price)}</b>{l.product.unit === 'UN' || l.product.unit === 'PCT' ? '' : `/${l.product.unit === 'KG' ? 'kg' : 'L'}`}</span>}
            <Stepper value={l.qtyMilli} unit={l.product.unit} onChange={(v) => setQty(i, v)} />
            <div className="row" style={{ gap: 4 }}>
              <button className="btn ghost sm" onClick={() => setPricing(i)} disabled={!navigator.onLine} title={navigator.onLine ? '' : 'Precisa de internet'}>Alterar preço</button>
              <button className="btn ghost sm danger" onClick={() => setQty(i, 0)}>Remover</button>
            </div>
          </div>
        ))}
      </div>
      <div className="cart-total stack">
        <div className="row"><span className="muted">Total</span><span className="spacer" /><span className="total-big num">{money(total)}</span></div>
        <button className="btn primary lg block" disabled={!count} onClick={openCheckout}>Cobrar</button>
        {count > 0 && <button className="btn ghost block" onClick={() => confirmClear() && setCart([])}>Limpar pedido</button>}
      </div>
    </>
  );

  return (
    <div className="pos">
      <div className="stack">
        <ProductPicker onPick={add} />
      </div>
      <aside className="card flush pos-cart"><div className="row" style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}><h2>Pedido</h2><span className="spacer" /><span className="faint">{count} {count === 1 ? 'item' : 'itens'}</span></div>{cartView}</aside>
      <div className="mobile-cart-bar">
        <button className="btn lg" style={{ flex: 1 }} onClick={() => setMobileCart(true)}>Ver pedido ({count})</button>
        <button className="btn primary lg" style={{ flex: 1 }} disabled={!count} onClick={openCheckout}>Cobrar {money(total)}</button>
      </div>
      {mobileCart && <Modal title="Pedido" onClose={() => setMobileCart(false)}><div className="card flush">{cartView}</div></Modal>}
      {checkout && <CheckoutModal title="Pagamento" subtotalCents={total} units={surchargeUnits(cart.map((l) => ({ unit: l.product.unit, qtyMilli: l.qtyMilli })))} busy={busy} error={error} onClose={() => !busy && setCheckout(false)} onConfirm={confirm} />}
      {done && (
        <Modal title={done.offline ? "Venda guardada" : "Venda registrada"} onClose={() => setDone(null)} footer={<><button className="btn lg" onClick={() => printSaleReceipt(done, { storeName: boot?.storeName, width: getPrinter().width || '80' })}>Imprimir</button><button className="btn primary lg" style={{ flex: 1 }} autoFocus onClick={() => setDone(null)}>Nova venda</button></>}>
          {done.offline
            ? <div className="notice warning">Venda guardada no aparelho (sem internet) — {done.payment_method}. Ela será enviada sozinha quando a conexão voltar.</div>
            : <div className="notice success">Venda nº {done.id} concluída — {done.payment_method}{done.customer_name ? ` · ${done.customer_name}` : ''}.</div>}
          <div className="row"><span className="muted">Total</span><span className="spacer" /><b className="num" style={{ fontSize: 22 }}>{money(done.total_cents)}</b></div>
          {done.change_cents != null && <div className="row"><span className="muted">Troco</span><span className="spacer" /><b className="total-big num">{money(done.change_cents)}</b></div>}
          <div className="faint">{done.items.map((i: any) => `${qty(i.qty_milli, i.unit)} ${i.product_name}`).join(' · ')}</div>
        </Modal>
      )}
      {pricing != null && cart[pricing] && <PriceModal line={cart[pricing]} auth={priceAuth} onClose={() => setPricing(null)}
        onApply={(price, auth) => { setCart((c) => c.map((l, j) => (j === pricing ? { ...l, price } : l))); if (auth) setPriceAuth(auth); setPricing(null); }} />}
    </div>
  );
}

const confirmClear = () => window.confirm('Remover todos os produtos do pedido?');

/** Mudar o preço de um item só nesta venda: novo valor ou desconto, motivo e código de cancelamento. */
function PriceModal({ line, auth, onClose, onApply }: { line: Line; auth: { code: string; reason: string } | null; onClose: () => void; onApply: (price: number | undefined, auth: { code: string; reason: string } | null) => void }) {
  const list = line.product.price_cents;
  const [val, setVal] = useState(centsToInput(line.price ?? list));
  const [reason, setReason] = useState(auth?.reason ?? '');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const per = line.product.unit === 'UN' || line.product.unit === 'PCT' ? 'unidade' : line.product.unit === 'KG' ? 'kg' : 'litro';
  const price = parseMoney(val);
  const pct = (p: number) => setVal(centsToInput(Math.round(list * (100 - p) / 100)));
  const [apply, busy] = useAction(async () => {
    setErr(null);
    if (price == null) return setErr('Valor inválido.');
    if (price === list) return onApply(undefined, null);
    if (reason.trim().length < 3) return setErr('Informe o motivo.');
    try { await api('/sales/price-auth', { body: { code } }); onApply(price, { code, reason: reason.trim() }); }
    catch (e: any) { setErr(e.message); }
  });
  return (
    <Modal title={`Preço · ${line.product.name}`} onClose={onClose} footer={<>
      {line.price != null && <button className="btn" onClick={() => onApply(undefined, null)}>Voltar ao preço normal</button>}
      <span className="spacer" />
      <button className="btn primary" disabled={busy || price == null} onClick={apply}>Aplicar</button></>}>
      <div className="row"><span className="muted">Preço do cadastro</span><span className="spacer" /><b className="num">{money(list)} / {per}</b></div>
      <Field label={`Novo preço por ${per} (só nesta venda)`}>
        <input className="input lg num" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
      </Field>
      <div className="row wrap">{[5, 10, 15, 20].map((p) => <button key={p} className="chip" onClick={() => pct(p)}>−{p}%</button>)}</div>
      {price != null && price !== list && <div className="faint">Total deste item: <b className="num">{money(Math.round(price * line.qtyMilli / 1000))}</b> (era {money(Math.round(list * line.qtyMilli / 1000))})</div>}
      {price != null && price !== list && <>
        <Field label="Motivo"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cliente fiel, produto amassado" maxLength={200} /></Field>
        <Field label="Código de cancelamento"><input className="input num" type="password" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <div className="faint">O cadastro do produto não muda. A mudança fica registrada na Auditoria com o motivo.</div>
      </>}
      {err && <div className="notice danger">{err}</div>}
    </Modal>
  );
}
