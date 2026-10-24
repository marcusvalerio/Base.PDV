import { useEffect, useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { money, qty } from '../lib/format';
import { ProductPicker, Stepper, CheckoutModal, CheckoutResult, Product, surchargeUnits } from '../components/pos';
import { Modal, useToast, Empty } from '../components/ui';
import { useAction } from '../lib/hooks';
import { RegisterGate } from '../components/RegisterGate';

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
    try {
      const sale = await api('/sales', { body: { idempotencyKey: key.current, items: cart.map((l) => ({ productId: l.product.id, qtyMilli: l.qtyMilli })), ...r } });
      setCart([]); setCheckout(false); setDone(sale);
    } catch (e: any) {
      // Mantém a mesma chave: tentar de novo não duplica a venda.
      setError(e.message);
    }
  });

  const cartView = (
    <>
      <div className="cart-list">
        {!cart.length ? <Empty>Nenhum produto no pedido.<br />Toque em um produto para adicionar.</Empty> : cart.map((l, i) => (
          <div className="cart-line" key={i}>
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
        <Modal title="Venda registrada" onClose={() => setDone(null)} footer={<button className="btn primary lg block" autoFocus onClick={() => setDone(null)}>Nova venda</button>}>
          <div className="notice success">Venda nº {done.id} concluída — {done.payment_method}{done.customer_name ? ` · ${done.customer_name}` : ''}.</div>
          <div className="row"><span className="muted">Total</span><span className="spacer" /><b className="num" style={{ fontSize: 22 }}>{money(done.total_cents)}</b></div>
          {done.change_cents != null && <div className="row"><span className="muted">Troco</span><span className="spacer" /><b className="total-big num">{money(done.change_cents)}</b></div>}
          <div className="faint">{done.items.map((i: any) => `${qty(i.qty_milli, i.unit)} ${i.product_name}`).join(' · ')}</div>
        </Modal>
      )}
    </div>
  );
}

const confirmClear = () => window.confirm('Remover todos os produtos do pedido?');
