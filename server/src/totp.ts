import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Código de 6 dígitos que muda a cada 30 s (TOTP, RFC 6238), compatível com Google Authenticator, Microsoft Authenticator etc.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): string {
  let bits = '', out = '';
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string): Buffer {
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error('Segredo TOTP inválido.');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Confere o código aceitando 30 s de diferença no relógio. Devolve o passo usado (para impedir reuso) ou null. */
export function verifyTotp(secret: string, code: string, at = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(at / 30000);
  for (const step of [now, now - 1, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent('Central.PDV:' + account)}?secret=${secret}&issuer=${encodeURIComponent('Central.PDV')}&algorithm=SHA1&digits=6&period=30`;
