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

/**
 * Unidades que contam para o acréscimo do fiado: cada unidade/pacote vendido conta 1;
 * produtos por volume ou peso (chopp, kg) contam 1 por item lançado.
 */
export function surchargeUnits(unit: Unit, qtyMilli: number): number {
  return FRACTIONAL_UNITS.includes(unit) ? 1 : Math.round(qtyMilli / 1000);
}
