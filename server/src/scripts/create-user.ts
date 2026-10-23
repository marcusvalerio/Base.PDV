/**
 * Cria um usuário sem senha fixa no código.
 * Uso: npm run create-admin -- --name "Fulano" --username fulano [--role OPERADOR]
 * A senha é lida da variável PDV_PASSWORD ou digitada no terminal.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { openDb } from '../db.js';
import { createUser, Role } from '../services/users.js';

const { values } = parseArgs({ options: { name: { type: 'string' }, username: { type: 'string' }, role: { type: 'string', default: 'ADMIN' } } });
if (!values.name || !values.username) {
  console.error('Uso: npm run create-admin -- --name "Nome" --username login [--role ADMIN|OPERADOR]');
  process.exit(1);
}
let password = process.env.PDV_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Senha (mín. 8 caracteres): ');
  rl.close();
}
const db = openDb(process.env.DATABASE_PATH || './data/pdv.db');
const id = createUser(db, { name: values.name, username: values.username, password, role: values.role as Role }, null);
console.log(`Usuário #${id} (${values.role}) criado.`);
