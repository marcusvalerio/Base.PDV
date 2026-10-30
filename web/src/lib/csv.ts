/**
 * Exporta uma lista para planilha (CSV no padrão do Excel em português: separador ";", vírgula decimal, UTF-8 com BOM).
 */
export type Col<T> = [header: string, value: (row: T) => string | number | null | undefined];

const TZ = 'America/Sao_Paulo';
export const csvDate = (iso?: string | null) => (iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '');
export const csvMoney = (cents?: number | null) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));
export const csvQty = (milli?: number | null) => (milli == null ? '' : String(milli / 1000).replace('.', ','));

const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  // Texto digitado (nome de cliente, produto…) começando com = + - @ viraria fórmula no Excel: neutraliza com apóstrofo.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCsv<T>(filename: string, rows: T[], cols: Col<T>[]) {
  const lines = [cols.map(([h]) => cell(h)).join(';'), ...rows.map((r) => cols.map(([, f]) => cell(f(r))).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
