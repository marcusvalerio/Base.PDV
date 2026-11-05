import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup, agent, product, PASS } from './helpers.js';
import { createTenant } from '../src/services/platform.js';
import { tenantAware, tenantStore, withSchema } from '../src/db.js';

/** Dois estabelecimentos no mesmo banco: nada de um pode aparecer, mudar ou ser usado pelo outro. */
async function twoTenants() {
  const s = await setup();
  const tidB = await createTenant(s.base, { name: 'Loja B', admin: { name: 'Dono B', username: 'dono.b', password: PASS }, exempt: true }, null);
  const b = await agent(s.app, 'dono.b');
  return { ...s, tidB, b };
}

describe('isolamento entre estabelecimentos', () => {
  it('produtos, configurações e usuários de A não aparecem para B', async () => {
    const { admin, b } = await twoTenants();
    const pid = await product(admin, { name: 'Segredo da Loja A' });
    const list = await b.get('/api/products');
    expect(JSON.stringify(list.body)).not.toContain('Segredo da Loja A');
    const users = await b.get('/api/users');
    expect(JSON.stringify(users.body)).not.toContain('Operadora Teste');
    expect([403, 404]).toContain((await b.patch(`/api/products/${pid}`, { name: 'hack' })).status);
    const again = await admin.get('/api/products');
    expect(JSON.stringify(again.body)).not.toContain('hack');
  });

  it('trocar o número do estabelecimento no cookie não dá acesso ao outro', async () => {
    const { app, tenantId, tidB } = await twoTenants();
    const res = await request(app).post('/api/auth/login').set('X-Requested-With', 'pdv').send({ username: 'dono.b', password: PASS });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const forged = cookie.replace(`=${tidB}.`, `=${tenantId}.`);
    expect(forged).not.toBe(cookie);
    expect((await request(app).get('/api/products').set('Cookie', forged)).status).toBe(401);
    // Sessão inválida: nem a tela pública revela o nome do estabelecimento do cookie.
    const info = await request(app).get('/api/public/info').set('Cookie', forged);
    expect(info.body.storeName).toBe('');
  });

  it('conexão liberada recusa consulta atrasada (não roda no schema de outro estabelecimento)', async () => {
    const { base, schema } = await twoTenants();
    const db = tenantAware(base);
    let late: Promise<unknown> | undefined;
    await withSchema(base, schema, async () => { late = new Promise((r) => setTimeout(r, 5)).then(() => db.all('SELECT * FROM users')); });
    await expect(late).rejects.toThrow(/liberada/);
    expect(tenantStore.getStore()).toBeUndefined();
  });
});
