import { describe, it, expect } from 'vitest';
import { setup, agent, PASS } from './helpers.js';

describe('primeiro acesso (passo a passo)', () => {
  it('guarda o tipo de negócio e informa o que falta no bootstrap', async () => {
    const { app } = await setup();
    const sup = await agent(app, 'super', true);
    await sup.post('/api/central/tenants', { name: 'Nova', exempt: true, admin: { name: 'Ana', username: 'ana.nova', password: PASS } });
    const ana = await agent(app, 'ana.nova');
    let ob = (await ana.get('/api/bootstrap')).body.onboarding;
    expect(ob).toMatchObject({ done: false, products: 0, team: 0, cancelCode: false, firstSale: false });
    expect((await ana.put('/api/settings', { business_type: 'padaria' })).status).toBe(400);
    expect((await ana.put('/api/settings', { business_type: 'mercearia', onboarding_done: '1' })).status).toBe(200);
    await ana.put('/api/settings/cancel-code', { code: '9090' });
    await ana.post('/api/products/bulk', { items: [{ name: 'Arroz 5kg', category: 'Mercearia', unit: 'PCT', price_cents: 2990 }] });
    ob = (await ana.get('/api/bootstrap')).body.onboarding;
    expect(ob).toMatchObject({ done: true, businessType: 'mercearia', products: 1, cancelCode: true });
  });
});
