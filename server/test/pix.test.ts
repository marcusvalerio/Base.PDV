import { describe, it, expect } from 'vitest';
import { crc16, pixPayload, normalizePixKey } from '../../web/src/lib/pix.js';

describe('Pix copia e cola', () => {
  it('CRC16-CCITT do padrão', () => { expect(crc16('123456789')).toBe('29B1'); });
  it('monta o código com valor, nome e cidade', () => {
    const p = pixPayload({ key: 'loja@exemplo.com', name: 'Bar do Zé', city: 'São Paulo', amountCents: 1550, txid: 'V123' });
    expect(p.startsWith('000201')).toBe(true);
    expect(p).toContain('0014br.gov.bcb.pix0116loja@exemplo.com');
    expect(p).toContain('540515.50');
    expect(p).toContain('5909BAR DO ZE');
    expect(p).toContain('6009SAO PAULO');
    expect(p).toContain('62080504V123');
    expect(p.slice(-8, -4)).toBe('6304');
    expect(crc16(p.slice(0, -4))).toBe(p.slice(-4));
  });
  it('normaliza chaves', () => {
    expect(normalizePixKey('11 98765-4321')).toBe('+5511987654321');
    expect(normalizePixKey('123.456.789-09')).toBe('12345678909');
    expect(normalizePixKey('12.345.678/0001-90')).toBe('12345678000190');
    expect(normalizePixKey('Loja@Exemplo.com')).toBe('loja@exemplo.com');
  });
});
