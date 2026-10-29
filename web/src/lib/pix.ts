/**
 * Pix "copia e cola" / QR Code estático com valor (padrão BR Code do Banco Central, EMV-QRCPS).
 * O dinheiro cai direto na conta da chave informada; o sistema não confirma o pagamento sozinho.
 */
const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Remove acentos e caracteres fora do permitido no BR Code. */
const clean = (s: string, max: number) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-@]/g, '').trim().slice(0, max).toUpperCase();

export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Normaliza a chave: telefone vira +55…; CPF/CNPJ só números; e-mail e aleatória como estão. */
export function normalizePixKey(key: string): string {
  const k = key.trim();
  if (/@/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
  const d = k.replace(/\D/g, '');
  if (k.startsWith('+')) return '+' + d;
  // Celular sem DDI: DDD + 9 + 8 dígitos e sem os pontos do CPF (CPF sem pontuação é tratado como CPF se não começar com DDD+9).
  if (d.length === 11 && /^[1-9]{2}9/.test(d) && !k.includes('.')) return '+55' + d;
  return d || k;
}

export function pixPayload(opts: { key: string; name: string; city: string; amountCents?: number; txid?: string }): string {
  const account = field('00', 'br.gov.bcb.pix') + field('01', normalizePixKey(opts.key));
  let p = field('00', '01') + field('26', account) + field('52', '0000') + field('53', '986');
  if (opts.amountCents && opts.amountCents > 0) p += field('54', (opts.amountCents / 100).toFixed(2));
  p += field('58', 'BR') + field('59', clean(opts.name, 25) || 'RECEBEDOR') + field('60', clean(opts.city, 15) || 'BRASIL');
  p += field('62', field('05', (opts.txid ?? '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'));
  p += '6304';
  return p + crc16(p);
}
