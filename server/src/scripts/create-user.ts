/**
 * Cria um administrador central (painel /central) sem senha fixa no código.
 * Uso: npm run create-admin -- --name "Fulano" --username fulano
 * A senha é lida da variável PDV_PASSWORD ou digitada no terminal.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { openDb } from '../db.js';
import { createPlatformAdmin } from '../services/platform.js';

const { values } = parseArgs({ options: { name: { type: 'string' }, username: { type: 'string' } } });
if (!values.name || !values.username) {
  console.error('Uso: npm run create-admin -- --name "Nome" --username login');
  process.exit(1);
}
let password = process.env.PDV_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Senha (mín. 8 caracteres): ');
  rl.close();
}
if (!process.env.DATABASE_URL) { console.error('Defina DATABASE_URL (string de conexão do Neon).'); process.exit(1); }
const db = await openDb();
const id = await createPlatformAdmin(db, { name: values.name, username: values.username, password });
console.log(`Administrador central #${id} criado. Entre em /central.`);
await db.close();
