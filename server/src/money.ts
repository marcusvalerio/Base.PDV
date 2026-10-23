export type Unit = 'UN' | 'PCT' | 'L' | 'KG';
export const UNITS: Unit[] = ['UN', 'PCT', 'L', 'KG'];
/** Unidades que aceitam quantidades fracionadas (ex.: 0,3 L de chopp). */
export const FRACTIONAL_UNITS: Unit[] = ['L', 'KG'];

/** Valor da linha: preço por unidade × quantidade (em milésimos), arredondado ao centavo (meio para cima). */
export function lineTotal(unitPriceCents: number, qtyMilli: number): number {
  return Math.round((unitPriceCents * qtyMilli) / 1000);
}

export function assertQty(unit: Unit, qtyMilli: number) {
  if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) throw new Error('Quantidade inválida.');
  if (!FRACTIONAL_UNITS.includes(unit) && qtyMilli % 1000 !== 0) {
    throw new Error('Este produto só pode ser vendido em quantidades inteiras.');
  }
}
