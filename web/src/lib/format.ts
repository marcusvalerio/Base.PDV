export type Unit = 'UN' | 'PCT' | 'L' | 'KG';
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents: number | null | undefined) => (cents == null ? '—' : brl.format(cents / 100));
export const pct = (v: number | null | undefined, digits = 0) => (v == null ? '—' : `${(v * 100).toFixed(digits).replace('.', ',')}%`);
export const UNIT_LABEL: Record<Unit, string> = { UN: 'unidade', PCT: 'pacote', L: 'litro', KG: 'kg' };
export const UNIT_SHORT: Record<Unit, string> = { UN: 'un', PCT: 'pct', L: 'L', KG: 'kg' };
export const isFractional = (u: Unit) => u === 'L' || u === 'KG';

/** Quantidade em milésimos → texto amigável (ex.: 300 mL, 1,5 L, 3 un). */
export function qty(milli: number, unit: Unit): string {
  if (unit === 'L') return Math.abs(milli) < 1000 ? `${milli} mL` : `${fmtNum(milli / 1000)} L`;
  if (unit === 'KG') return Math.abs(milli) < 1000 ? `${milli} g` : `${fmtNum(milli / 1000)} kg`;
  return `${fmtNum(milli / 1000)} ${UNIT_SHORT[unit]}`;
}
export const fmtNum = (n: number, max = 3) => n.toLocaleString('pt-BR', { maximumFractionDigits: max });

/** "12,50" | "12.5" | "1.234,56" → centavos. Retorna null se inválido. */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(/\s|R\$/g, '');
  if (!t) return null;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d{0,2})?$/.test(norm)) return null;
  return Math.round(Number(norm) * 100);
}
export const centsToInput = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

/** Converte texto de quantidade na unidade do produto para milésimos. Aceita "0,5", "300ml", "2". */
export function parseQty(s: string, unit: Unit): number | null {
  const t = s.trim().toLowerCase().replace(/\s/g, '');
  if (!t) return null;
  const m = t.match(/^(\d+(?:[.,]\d+)?)(ml|l|g|kg)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const suf = m[2];
  let milli = suf === 'ml' || suf === 'g' ? n : n * 1000;
  milli = Math.round(milli);
  if (milli <= 0) return null;
  if (!isFractional(unit) && milli % 1000 !== 0) return null;
  return milli;
}

export const dateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const date = (d: string) => (d.length === 10 ? new Date(d + 'T12:00:00') : new Date(d)).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
export const todayISO = () => new Date().toLocaleDateString('en-CA');

/** Média (ex.: por dia) com no máximo 1 casa decimal: "13,7 un", "671 mL". */
export function avgQty(milli: number, unit: Unit): string {
  if ((unit === 'L' || unit === 'KG') && Math.abs(milli) < 1000) return `${Math.round(milli)} ${unit === 'L' ? 'mL' : 'g'}`;
  return `${fmtNum(milli / 1000, 1)} ${unit === 'L' ? 'L' : unit === 'KG' ? 'kg' : UNIT_SHORT[unit]}`;
}
