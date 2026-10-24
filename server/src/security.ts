import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/** Hash scrypt com sal aleatório: "scrypt$<salt>$<hash>". Usado para senhas e códigos de caixa. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const actual = scryptSync(secret, Buffer.from(s, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}
