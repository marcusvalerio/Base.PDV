import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { setup, agent, PASS } from './helpers.js';
import { totpAt, verifyTotp } from '../src/totp.js';

const now = () => totpAt(secretOf.s, Math.floor(Date.now() / 30000));
const secretOf = { s: '' };
const central = (app: any, body: any, ip: string) => request(app).post('/api/central/login').set('X-Requested-With', 'pdv').set('X-Forwarded-For', ip).send(body);

describe('verificação em duas etapas (painel central)', () => {
  it('confere o código do RFC 6238', () => {
    // Vetor de teste do RFC 6238 (SHA1, segredo "12345678901234567890" em base32, T = 59 s → 94287082, 6 últimos dígitos).
    expect(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
    expect(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 59_000)).toBe(1);
    expect(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '000000', 59_000)).toBeNull();
  });

  it('é opcional; depois de ativada, o login pede o código e não aceita reuso', async () => {
    const { app } = await setup();
    const sup = await agent(app, 'super', true);
    expect((await sup.get('/api/central/me')).body.totp).toBe(false);
    const b = await sup.post('/api/central/2fa/begin', {});
    secretOf.s = b.body.secret;
    expect(b.body.url).toMatch(/^otpauth:\/\/totp\//);
    expect((await sup.post('/api/central/2fa/enable', { code: '000000' })).status).toBe(400);
    expect((await sup.post('/api/central/2fa/enable', { code: now() })).status).toBe(200);
    expect((await sup.get('/api/central/me')).body.totp).toBe(true);

    const noCode = await central(app, { username: 'super', password: PASS }, '10.9.0.1');
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('TOTP_REQUIRED');
    // Mesmo código usado na ativação: recusado (não serve duas vezes).
    expect((await central(app, { username: 'super', password: PASS, code: now() }, '10.9.0.2')).status).toBe(401);
    // Senha errada nunca chega a pedir código.
    expect((await central(app, { username: 'super', password: 'senha-errada' }, '10.9.0.3')).body.error.code).not.toBe('TOTP_REQUIRED');
    // 30 s depois, o código novo entra.
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + 30_000);
    try {
      const ok = await central(app, { username: 'super', password: PASS, code: now() }, '10.9.0.4');
      expect(ok.status).toBe(200);
      expect(ok.headers['set-cookie'][0]).toMatch(/pdv_central=/);
    } finally { spy.mockRestore(); }
  });
});
