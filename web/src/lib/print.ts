import { money, qty, Unit } from './format';

/**
 * Impressão em impressora térmica (58 ou 80 mm) pelo próprio navegador.
 * Funciona com impressoras instaladas no computador/tablet (USB, Bluetooth ou rede) — escolha a impressora uma vez no diálogo.
 */
const TZ = 'America/Sao_Paulo';
const when = (iso?: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(iso ? new Date(iso) : new Date());
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export type PaperWidth = '58' | '80';

function printHtml(body: string, width: PaperWidth) {
  const mm = width === '58' ? 48 : 72; // área útil
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Comprovante</title><style>
    @page { size: ${width}mm auto; margin: 2mm; }
    * { box-sizing: border-box; }
    body { margin: 0; width: ${mm}mm; font: ${width === '58' ? 11 : 12}px/1.35 ui-monospace, Menlo, Consolas, monospace; color: #000; }
    h1 { font-size: 1.25em; text-align: center; margin: 0 0 2px; }
    .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .row span:first-child { overflow-wrap: anywhere; }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
    .big { font-size: 1.35em; font-weight: 700; }
  </style></head><body>${body}</body></html>`;
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  Object.assign(f.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(f);
  const d = f.contentWindow!.document;
  d.open(); d.write(html); d.close();
  setTimeout(() => { f.contentWindow!.focus(); f.contentWindow!.print(); setTimeout(() => f.remove(), 1500); }, 150);
}

const items = (list: { qty_milli: number; unit: Unit; product_name: string; total_cents?: number }[]) =>
  list.map((i) => `<div class="row"><span>${esc(qty(i.qty_milli, i.unit))} ${esc(i.product_name)}</span>${i.total_cents != null ? `<span>${money(i.total_cents)}</span>` : ''}</div>`).join('');

/** Comprovante de venda (não fiscal). */
export function printSaleReceipt(sale: any, opts: { storeName?: string; width: PaperWidth }) {
  const body = `
    <h1>${esc(opts.storeName || 'Central.PDV')}</h1>
    <div class="c">${sale.offline ? 'Venda guardada (sem internet)' : `Venda nº ${esc(sale.id)}`}</div>
    <div class="c">${when(sale.created_at)}</div><hr>
    ${items(sale.items)}<hr>
    ${sale.surcharge_cents > 0 ? `<div class="row"><span>Produtos</span><span>${money(sale.subtotal_cents)}</span></div><div class="row"><span>Acréscimo</span><span>${money(sale.surcharge_cents)}</span></div>` : ''}
    <div class="row big"><span>TOTAL</span><span>${money(sale.total_cents)}</span></div>
    <div class="row"><span>${esc(sale.payment_method)}${sale.customer_name ? ` · ${esc(sale.customer_name)}` : ''}</span></div>
    ${sale.received_cents != null ? `<div class="row"><span>Recebido</span><span>${money(sale.received_cents)}</span></div>` : ''}
    ${sale.change_cents ? `<div class="row b"><span>Troco</span><span>${money(sale.change_cents)}</span></div>` : ''}
    <hr><div class="c">${sale.user_name ? `Atendido por ${esc(sale.user_name)}<br>` : ''}Obrigado e volte sempre!</div>
    <div class="c" style="font-size:.85em;margin-top:4px">Não é documento fiscal</div>`;
  printHtml(body, opts.width);
}

/** Conta da mesa (pré-conta, para o cliente conferir antes de pagar). */
export function printTabBill(tab: any, opts: { storeName?: string; width: PaperWidth; personId?: number | null }) {
  const people = (tab.people as any[]).filter((p) => opts.personId == null || p.id === opts.personId);
  let total = 0;
  const blocks = people.map((p) => {
    const pend = (p.items as any[]).filter((i) => i.status === 'PENDING');
    if (!pend.length) return '';
    const sub = pend.reduce((a, i) => a + i.total_cents, 0);
    total += sub;
    return `<div class="b">${esc(p.name)}</div>${items(pend)}<div class="row b"><span>Subtotal</span><span>${money(sub)}</span></div><hr>`;
  }).join('');
  const body = `
    <h1>${esc(opts.storeName || 'Central.PDV')}</h1>
    <div class="c b">${esc(tab.label)} — conferência</div><div class="c">${when()}</div><hr>
    ${blocks || '<div class="c">Nada em aberto.</div><hr>'}
    <div class="row big"><span>TOTAL</span><span>${money(total)}</span></div>
    <div class="c" style="font-size:.85em;margin-top:4px">Acréscimos de cartão/fiado são somados no pagamento.<br>Não é documento fiscal</div>`;
  printHtml(body, opts.width);
}

/** Impressora configurada neste aparelho (cada computador/tablet tem a sua). */
const KEY = 'pdv.printer';
export function getPrinter(): { width: PaperWidth | ''; auto: boolean } {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return { width: v.width === '58' || v.width === '80' ? v.width : '', auto: !!v.auto }; } catch { return { width: '', auto: false }; }
}
export function setPrinter(v: { width: PaperWidth | ''; auto: boolean }) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* sem armazenamento */ }
}
