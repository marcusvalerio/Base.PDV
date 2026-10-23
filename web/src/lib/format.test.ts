import { describe, it, expect } from 'vitest';
import { parseMoney, parseQty, qty } from './format';

describe('formatação', () => {
  it('interpreta dinheiro em formato brasileiro', () => {
    expect(parseMoney('12,50')).toBe(1250);
    expect(parseMoney('R$ 1.234,56')).toBe(123456);
    expect(parseMoney('20')).toBe(2000);
    expect(parseMoney('abc')).toBeNull();
  });
  it('converte volumes e unidades', () => {
    expect(parseQty('300ml', 'L')).toBe(300);
    expect(parseQty('0,5', 'L')).toBe(500);
    expect(parseQty('1.5', 'L')).toBe(1500);
    expect(parseQty('2', 'UN')).toBe(2000);
    expect(parseQty('1,5', 'UN')).toBeNull();
    expect(qty(300, 'L')).toBe('300 mL');
    expect(qty(1500, 'L')).toBe('1,5 L');
    expect(qty(3000, 'UN')).toBe('3 un');
  });
});
