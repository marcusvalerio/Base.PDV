import { describe, it, expect, afterEach } from 'vitest';
import { setup, agent, PASS } from './helpers.js';

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('painel central: avisos, notas, saúde, histórico e crescimento', () => {
  afterEach(() => { for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']) delete process.env[k]; });

  it('aviso para todos e para um estabelecimento aparece só no período; encerrar tira do ar', async () => {
    const { app, admin, tenantId } = await setup();
    const sup = await agent(app, 'super', true);
    const outro = (await sup.post('/api/central/tenants', { name: 'Outra Loja', admin: { name: 'Dona', username: 'dona.outra', password: PASS } })).body.id;
    const all = await sup.post('/api/central/notices', { tenant_id: null, kind: 'maintenance', title: 'Manutenção domingo', message: 'Das 3h às 4h.', starts_at: iso(-1000), ends_at: iso(864e5) });
    expect(all.status).toBe(201);
    await sup.post('/api/central/notices', { tenant_id: outro, kind: 'news', title: 'Só para a outra', message: 'Oi.', starts_at: iso(-1000), ends_at: iso(864e5) });
    await sup.post('/api/central/notices', { tenant_id: null, kind: 'info', title: 'Futuro', message: 'Ainda não.', starts_at: iso(3600e3), ends_at: iso(864e5) });
    const mine = (await admin.get('/api/notices')).body;
    expect(mine.map((n: any) => n.title)).toEqual(['Manutenção domingo']);
    expect((await sup.post('/api/central/notices', { tenant_id: null, kind: 'info', title: 'Errado', message: 'Fim antes.', starts_at: iso(1000), ends_at: iso(-1000) })).status).toBe(400);
    await sup.post(`/api/central/notices/${all.body.id}/end`);
    expect((await admin.get('/api/notices')).body).toEqual([]);
    expect((await sup.get('/api/central/notices')).body.length).toBe(3);
    expect(tenantId).toBeTruthy();
  });

  it('aviso automático do fim do teste grátis, também com o sistema liberado só pelo teste', async () => {
    const { app } = await setup();
    const sup = await agent(app, 'super', true);
    await sup.post('/api/central/tenants', { name: 'Em Teste', trialDays: 3, admin: { name: 'Tes', username: 'tes.te', password: PASS } });
    const t = await agent(app, 'tes.te');
    const n = (await t.get('/api/notices')).body;
    expect(n[0].kind).toBe('billing');
    expect(n[0].title).toMatch(/teste grátis termina em 3 dias/);
  });

  it('notas internas, saúde do cliente, histórico e crescimento', async () => {
    const { app, tenantId } = await setup();
    const sup = await agent(app, 'super', true);
    expect((await sup.post(`/api/central/tenants/${tenantId}/notes`, { text: 'Ligou pedindo impressora.' })).status).toBe(201);
    const notes = (await sup.get(`/api/central/tenants/${tenantId}/notes`)).body;
    expect(notes[0].text).toBe('Ligou pedindo impressora.');
    expect(notes[0].admin_name).toBe('Super Teste');
    expect((await sup.del(`/api/central/tenants/${tenantId}/notes/${notes[0].id}`)).status).toBe(200);
    expect((await sup.get(`/api/central/tenants/${tenantId}/notes`)).body).toEqual([]);

    const list = (await sup.get('/api/central/tenants')).body;
    const h = list.find((t: any) => t.id === tenantId).health;
    expect(h.steps.map((s: any) => s.key)).toEqual(['products', 'team', 'cash', 'sale', 'paid']);
    expect(h.steps.find((s: any) => s.key === 'team').done).toBe(true);
    expect(h.steps.find((s: any) => s.key === 'sale').done).toBe(false);

    await sup.post('/api/central/notices', { tenant_id: null, kind: 'info', title: 'Teste', message: 'Oi.', starts_at: iso(-1000), ends_at: iso(1000e3) });
    const log = (await sup.get('/api/central/audit')).body;
    expect(log[0].action).toBe('notice.create');
    expect(log[0].admin_name).toBe('Super Teste');

    const g = (await sup.get('/api/central/growth')).body;
    expect(g.months).toHaveLength(12);
    expect(g.months[11].central).toBeGreaterThanOrEqual(1);
  });

  it('estabelecimento não acessa as rotas do painel', async () => {
    const { admin } = await setup();
    expect((await admin.get('/api/central/finance')).status).toBe(401);
    expect((await admin.get('/api/central/audit')).status).toBe(401);
  });

  it('financeiro lê o Stripe: recebido no mês, mensalidade recorrente, atrasados e próximas cobranças', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_1';
    const soon = Math.floor(Date.now() / 1000) + 2 * 86400;
    const fake = (async (url: string) => {
      const u = new URL(url);
      const data = u.pathname.endsWith('/invoices') ? [{ id: 'in_1', amount_paid: 25000 }, { id: 'in_2', amount_paid: 8000 }]
        : u.searchParams.get('status') === 'active' ? [{ id: 'sub_a', customer: 'cus_a', items: { data: [{ price: { unit_amount: 8000 }, quantity: 1, current_period_end: soon }] } }]
        : [{ id: 'sub_b', customer: 'cus_b', items: { data: [{ price: { unit_amount: 8000 }, quantity: 1, current_period_end: soon - 9 * 86400 }] } }];
      return new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const { app, base, tenantId } = await setup({ fetch: fake });
    await base.run("UPDATE tenants SET stripe_customer_id = 'cus_a' WHERE id = ?", [tenantId]);
    const sup = await agent(app, 'super', true);
    const f = (await sup.get('/api/central/finance')).body;
    expect(f.receivedThisMonthCents).toBe(33000);
    expect(f.mrrCents).toBe(8000);
    expect(f.pastDue).toHaveLength(1);
    expect(f.upcoming[0].tenant.name).toBe('Loja Teste');
  });
});
