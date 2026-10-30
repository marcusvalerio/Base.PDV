import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup, PASS } from './helpers.js';

const login = (app: any, username: string, password: string, ip = '10.0.0.1', path = '/api/auth/login') =>
  request(app).post(path).set('X-Requested-With', 'pdv').set('X-Forwarded-For', ip).send({ username, password });

describe('segurança: tentativas de senha', () => {
  it('bloqueia o login após 5 senhas erradas, inclusive a senha certa, e não afeta outro usuário', async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++) expect((await login(app, 'op', 'errada-' + i)).status).toBe(401);
    expect((await login(app, 'op', PASS)).status).toBe(429);
    expect((await login(app, 'admin', PASS)).status).toBe(200);
  });

  it('ataque distribuído (vários IPs) no mesmo login também bloqueia', async () => {
    const { app } = await setup();
    for (let i = 0; i < 20; i++) await login(app, 'op', 'errada', `10.1.0.${i}`);
    expect((await login(app, 'op', PASS, '10.2.0.1')).status).toBe(429);
  });

  it('painel central também tem limite', async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++) expect((await login(app, 'super', 'errada-senha', '10.3.0.1', '/api/central/login')).status).toBe(401);
    expect((await login(app, 'super', PASS, '10.3.0.1', '/api/central/login')).status).toBe(429);
  });

  it('login certo zera a contagem do IP', async () => {
    const { app } = await setup();
    for (let i = 0; i < 4; i++) await login(app, 'op', 'errada', '10.4.0.1');
    expect((await login(app, 'op', PASS, '10.4.0.1')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(app, 'op', 'errada', '10.4.0.1')).status).toBe(401);
  });
});
