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

/** Papel das etiquetas: térmica (rolo) ou folha A4 de etiquetas adesivas 63,5 × 38,1 mm (3 × 7, ex.: Pimaco A4256). */
export type LabelPaper = '58' | '80' | 'a4';

/** Etiquetas com nome, preço e código de barras EAN-13 (lidas no caixa pelo leitor ou pela câmera). */
export function printLabels(p: { name: string; price_cents?: number | null; unit?: string }, code: string, svg: string, opts: { copies: number; paper: LabelPaper; price: boolean; storeName?: string }) {
  const one = `<div class="lb"><div class="nm">${esc(p.name)}</div>${opts.price && p.price_cents != null ? `<div class="pr">${money(p.price_cents)}${p.unit && p.unit !== 'UN' ? `<small>/${p.unit === 'KG' ? 'kg' : p.unit === 'L' ? 'L' : esc(p.unit)}</small>` : ''}</div>` : ''}<div class="bc">${svg}</div></div>`;
  const n = Math.max(1, Math.min(500, Math.floor(opts.copies)));
  const a4 = opts.paper === 'a4';
  const page = a4 ? '@page { size: A4; margin: 15mm 7mm; }' : `@page { size: ${opts.paper}mm auto; margin: 2mm; }`;
  const w = a4 ? '63.5mm' : opts.paper === '58' ? '48mm' : '72mm';
  const css = `${page}
    * { box-sizing: border-box; } body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .grid { display: ${a4 ? 'grid' : 'block'}; grid-template-columns: repeat(3, 63.5mm); grid-auto-rows: 38.1mm; column-gap: 2.5mm; }
    .lb { width: ${w}; ${a4 ? 'height: 38.1mm;' : ''} padding: ${a4 ? '2mm 3mm' : '1.5mm 0 3mm'}; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6mm; overflow: hidden;
      ${a4 ? '' : 'border-bottom: 1px dashed #000; break-inside: avoid; page-break-inside: avoid;'} }
    .nm { font-size: ${a4 ? '9pt' : '10pt'}; font-weight: 700; text-align: center; line-height: 1.15; max-height: 2.4em; overflow: hidden; }
    .pr { font-size: ${a4 ? '12pt' : '16pt'}; font-weight: 800; line-height: 1.1; } .pr small { font-size: .55em; font-weight: 600; }
    .bc { width: ${a4 ? '40mm' : opts.paper === '58' ? '44mm' : '56mm'}; } .bc svg { width: 100%; height: auto; display: block; }`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Etiquetas ${esc(code)}</title><style>${css}</style></head><body><div class="grid">${one.repeat(n)}</div></body></html>`;
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  Object.assign(f.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(f);
  const d = f.contentWindow!.document;
  d.open(); d.write(html); d.close();
  setTimeout(() => { f.contentWindow!.focus(); f.contentWindow!.print(); setTimeout(() => f.remove(), 2000); }, 200);
}
