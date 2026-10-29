import { useEffect, useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { money, qty } from '../lib/format';
import { ProductPicker, Stepper, CheckoutModal, CheckoutResult, Product, surchargeUnits, previewSurcharge } from '../components/pos';
import { enqueueSale, ownerOf } from '../lib/offline';
import { useSession } from '../components/session';
import { Modal, useToast, Empty } from '../components/ui';
import { useAction } from '../lib/hooks';
import { RegisterGate } from '../components/RegisterGate';
import { ProductArt } from '../components/ProductArt';

interface Line { product: Product; qtyMilli: number }
const STORE = 'pdv.cart';
const lineTotal = (l: Line) => Math.round(l.product.price_cents * l.qtyMilli / 1000);

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
    const body = { items: cart.map((l) => ({ productId: l.product.id, qtyMilli: l.qtyMilli })), ...r };
    const kind = boot?.paymentMethods.find((m) => m.code === r.paymentMethodCode)?.kind;
    const saveOffline = () => {
      // Sem internet: guarda a venda no aparelho; o total e o troco são uma prévia (o servidor confirma ao enviar).
      const units = surchargeUnits(cart.map((l) => ({ unit: l.product.unit, qtyMilli: l.qtyMilli })));
      const totalCents = total + previewSurcharge(boot, r.paymentMethodCode, total, units);
      const method = boot?.paymentMethods.find((m) => m.code === r.paymentMethodCode)?.name ?? '';
      enqueueSale({ key: key.current, owner: ownerOf(user)!, body, at: new Date().toISOString(), totalCents, label: `${method} · ${cart.map((l) => `${qty(l.qtyMilli, l.product.unit)} ${l.product.name}`).join(', ')}` });
      setCart([]); setCheckout(false);
      setDone({ offline: true, total_cents: totalCents, payment_method: method, change_cents: r.receivedCents != null ? r.receivedCents - totalCents : null,
        items: cart.map((l) => ({ qty_milli: l.qtyMilli, unit: l.product.unit, product_name: l.product.name })) });
    };
    if (!navigator.onLine && kind !== 'CREDIT') return saveOffline();
    try {
      const sale = await api('/sales', { body: { idempotencyKey: key.current, ...body } });
      setCart([]); setCheckout(false); setDone(sale);
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
            <Stepper value={l.qtyMilli} unit={l.product.unit} onChange={(v) => setQty(i, v)} />
            <button className="btn ghost sm danger" onClick={() => setQty(i, 0)}>Remover</button>
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
        <Modal title={done.offline ? "Venda guardada" : "Venda registrada"} onClose={() => setDone(null)} footer={<button className="btn primary lg block" autoFocus onClick={() => setDone(null)}>Nova venda</button>}>
          {done.offline
            ? <div className="notice warning">Venda guardada no aparelho (sem internet) — {done.payment_method}. Ela será enviada sozinha quando a conexão voltar.</div>
            : <div className="notice success">Venda nº {done.id} concluída — {done.payment_method}{done.customer_name ? ` · ${done.customer_name}` : ''}.</div>}
          <div className="row"><span className="muted">Total</span><span className="spacer" /><b className="num" style={{ fontSize: 22 }}>{money(done.total_cents)}</b></div>
          {done.change_cents != null && <div className="row"><span className="muted">Troco</span><span className="spacer" /><b className="total-big num">{money(done.change_cents)}</b></div>}
          <div className="faint">{done.items.map((i: any) => `${qty(i.qty_milli, i.unit)} ${i.product_name}`).join(' · ')}</div>
        </Modal>
      )}
    </div>
  );
}

const confirmClear = () => window.confirm('Remover todos os produtos do pedido?');
