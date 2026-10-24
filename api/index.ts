/**
 * Entrada serverless para a Vercel: a mesma API Express, com o banco aberto uma vez por instância.
 * O frontend (dist/) é servido como estático pela própria Vercel (ver vercel.json).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDb } from '../server/src/db.js';
import { createApp } from '../server/src/app.js';

let appPromise: Promise<ReturnType<typeof createApp>> | null = null;
function getApp() {
  if (!appPromise) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada na Vercel.');
    appPromise = openDb(process.env.DATABASE_URL).then((db) => createApp(db, { cookieSecure: process.env.COOKIE_SECURE !== 'false' }));
    appPromise.catch(() => { appPromise = null; });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await getApp();
    (app as any)(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    const msg = e instanceof Error && e.message.startsWith('DATABASE_URL') ? e.message : 'Servidor indisponível: verifique a configuração do banco.';
    res.end(JSON.stringify({ error: { code: 'BOOT', message: msg } }));
  }
}
