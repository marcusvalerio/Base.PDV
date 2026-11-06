/**
 * Código de barras EAN-13 (o mesmo dos produtos de mercado).
 * - Gera códigos internos da loja na faixa reservada pela GS1 para uso interno (começam com "2"):
 *   nunca coincidem com o código de fábrica de um produto.
 * - Desenha o código em SVG para imprimir etiquetas (lido por qualquer leitor ou pela câmera).
 */

/** Dígito verificador do EAN-13 a partir dos 12 primeiros dígitos. */
export function ean13Check(d12: string): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d12[i]) * (i % 2 ? 3 : 1);
  return (10 - (s % 10)) % 10;
}

/** EAN-13 válido (13 dígitos com verificador certo). */
export const isEan13 = (c: string) => /^\d{13}$/.test(c) && ean13Check(c.slice(0, 12)) === Number(c[12]);

/** Aceita EAN-13 ou UPC-A (12 dígitos, vira EAN-13 com 0 na frente). Outros formatos: null. */
export function toEan13(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  if (isEan13(c)) return c;
  if (/^\d{12}$/.test(c) && isEan13('0' + c)) return '0' + c;
  return null;
}

/** Novo código interno: "20" + 10 dígitos aleatórios + verificador. */
export function newInternalEan(): string {
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  const body = '20' + String(r[0] % 100000).padStart(5, '0') + String(r[1] % 100000).padStart(5, '0');
  return body + ean13Check(body);
}

export const isInternalEan = (c: string | null | undefined) => !!c && isEan13(c) && c.startsWith('2');

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Sequência de módulos (1 = barra) do EAN-13: 95 módulos. */
function modules(code: string): string {
  const first = Number(code[0]);
  let m = '101';
  for (let i = 1; i <= 6; i++) m += (PARITY[first][i - 1] === 'L' ? L : G)[Number(code[i])];
  m += '01010';
  for (let i = 7; i <= 12; i++) m += R[Number(code[i])];
  return m + '101';
}

/**
 * SVG do código (com os números embaixo). Tamanho em módulos; quem usa define a largura real em mm.
 * Margem branca de 9 módulos de cada lado (exigida para a leitura).
 */
export function ean13Svg(code: string): string {
  const m = modules(code);
  const quiet = 9, h = 52, guardH = 58, W = 95 + quiet * 2;
  const guards = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  let bars = '';
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== '1') continue;
    let j = i; while (j + 1 < m.length && m[j + 1] === '1' && guards.has(j + 1) === guards.has(i)) j++;
    bars += `<rect x="${quiet + i}" y="0" width="${j - i + 1}" height="${guards.has(i) ? guardH : h}"/>`;
    i = j;
  }
  const t = (x: number, s: string) => `<text x="${x}" y="67" text-anchor="middle">${s}</text>`;
  const digits = t(quiet - 4, code[0]) + t(quiet + 3 + 21, code.slice(1, 7)) + t(quiet + 50 + 21, code.slice(7));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 70" shape-rendering="crispEdges"><g fill="#000">${bars}</g>`
    + `<g font-family="ui-monospace,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="#000">${digits}</g></svg>`;
}
