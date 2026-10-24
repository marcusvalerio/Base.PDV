export const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Sao_Paulo';

/** Data local (YYYY-MM-DD) no fuso do estabelecimento. */
export function localDate(d: Date | string, tz = BUSINESS_TZ): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function offsetMinutes(date: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Instante UTC do início (00:00) do dia local informado. */
export function startOfLocalDay(day: string, tz = BUSINESS_TZ): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = offsetMinutes(guess, tz);
  const res = new Date(guess.getTime() - off * 60000);
  const off2 = offsetMinutes(res, tz);
  return off2 === off ? res : new Date(guess.getTime() - off2 * 60000);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

/** Intervalo [from, to] em dias locais (inclusivo) → [início UTC, fim exclusivo UTC]. */
export function rangeToUtc(from: string, to: string) {
  return { start: startOfLocalDay(from).toISOString(), end: startOfLocalDay(addDays(to, 1)).toISOString() };
}
