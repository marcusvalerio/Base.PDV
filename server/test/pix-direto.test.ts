import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup, agent, PASS } from './helpers.js';

async function bloqueado() {
  const s = await setup();
  const sup = await agent(s.app, 'super', true);
  const tid = (await sup.post('/api/central/tenants', { name: 'Loja Pix', admin: { name: 'Dono', username: 'dono.pix', password: PASS } })).body.id;
  const dono = await agent(s.app, 'dono.pix');
  return { ...s, sup, tid, dono };
}

describe('mensalidade por Pix direto', () => {
  it('sem chave configurada não aparece; operador e estabelecimento não mexem na configuração', async () => {
    const { dono, op, app } = await bloqueado();
    expect((await dono.get('/api/billing/pix')).body.available).toBe(false);
    expect((await dono.post('/api/billing/pix/report')).status).toBe(400);
    expect((await op.get('/api/billing/pix')).status).toBe(403);
    expect((await request(app).get('/api/central/pix/settings')).status).toBe(401);
  });

  it('1ª cobrança R$ 250 → "Já paguei" libera 3 dias → confirmado libera 30 dias → depois mensalidade R$ 80', async () => {
    const { sup, dono, base, tid } = await bloqueado();
    expect((await sup.put('/api/central/pix/settings', { pix_key: '123e4567-e89b-12d3-a456-426614174000', pix_name: 'MARCUS VALERIO', pix_city: 'SAO PAULO', first_cents: 25000, monthly_cents: 8000 })).status).toBe(200);
    expect((await dono.get('/api/products')).status).toBe(402);
    const st = (await dono.get('/api/billing/pix')).body;
    expect(st).toMatchObject({ available: true, kind: 'first', amountCents: 25000, pix: { name: 'MARCUS VALERIO' } });
    expect((await dono.post('/api/billing/pix/report')).status).toBe(200);
    expect((await dono.get('/api/products')).status).toBe(200);           // carência
    expect((await dono.post('/api/billing/pix/report')).status).toBe(409); // não duplica
    const pend = (await sup.get('/api/central/pix/pending')).body;
    expect(pend).toHaveLength(1); expect(pend[0]).toMatchObject({ tenant_id: tid, amount_cents: 25000 });
    const c = await sup.post(`/api/central/pix/${pend[0].id}/confirm`);
    const dias = (Date.parse(c.body.paidUntil) - Date.now()) / 864e5; expect(dias).toBeGreaterThan(29.9); expect(dias).toBeLessThanOrEqual(30);
    expect((await sup.post(`/api/central/pix/${pend[0].id}/confirm`)).status).toBe(409);
    expect((await dono.get('/api/billing/pix')).body).toMatchObject({ kind: 'monthly', amountCents: 8000, pending: null });
    // perto do vencimento: aviso com botão "Pagar agora"
    await base.run('UPDATE tenants SET paid_until = ? WHERE id = ?', [new Date(Date.now() + 2 * 864e5).toISOString(), tid]);
    const n = (await dono.get('/api/notices')).body.find((x: any) => String(x.id).startsWith('auto-pix'));
    expect(n.action).toMatchObject({ label: 'Pagar agora' });
    // vencido: bloqueia
    await base.run('UPDATE tenants SET paid_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), tid]);
    expect((await dono.get('/api/products')).status).toBe(402);
  });

  it('recusado no painel: tira a carência e bloqueia de novo', async () => {
    const { sup, dono } = await bloqueado();
    await sup.put('/api/central/pix/settings', { pix_key: 'chave-teste', pix_name: 'MARCUS VALERIO', pix_city: 'SAO PAULO', first_cents: 25000, monthly_cents: 8000 });
    await dono.post('/api/billing/pix/report');
    expect((await dono.get('/api/products')).status).toBe(200);
    const id = (await sup.get('/api/central/pix/pending')).body[0].id;
    await sup.post(`/api/central/pix/${id}/reject`);
    expect((await dono.get('/api/products')).status).toBe(402);
  });
});
