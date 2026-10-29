import { describe, it, expect } from 'vitest';
import { directUrl } from '../src/db.js';

describe('endereço do banco', () => {
  it('troca o endereço "-pooler" do Neon pelo direto (o search_path do estabelecimento não pode se perder)', () => {
    expect(directUrl('postgresql://u:p@ep-abc-123-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require'))
      .toBe('postgresql://u:p@ep-abc-123.sa-east-1.aws.neon.tech/neondb?sslmode=require');
    expect(directUrl('postgresql://u:p@ep-abc-123.sa-east-1.aws.neon.tech/neondb')).toBe('postgresql://u:p@ep-abc-123.sa-east-1.aws.neon.tech/neondb');
  });
});
