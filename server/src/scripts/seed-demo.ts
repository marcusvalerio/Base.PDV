/**
 * Servidor de DEMONSTRAÇÃO: Postgres em memória com dados fictícios (produtos, clientes e 30 dias de vendas).
 * Nada é gravado no Neon. Uso: PDV_DEMO_PASSWORD=... PDV_DEMO_CASH_CODE=2468 npm run demo
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { memoryDb, migrate, DB } from '../db.js';
import { createApp } from '../app.js';
import { createUser } from '../services/users.js';
import { createProduct } from '../services/products.js';
import { createCustomer } from '../services/customers.js';
import { setSetting } from '../services/settings.js';
import { hashSecret } from '../security.js';
import { setModules, MODULES } from '../services/modules.js';
import { openRegister } from '../services/cash.js';
import { createSale } from '../services/sales.js';
import { registerEntry } from '../services/stock.js';
import { addDays, localDate } from '../tz.js';

export async function seedDemo(db: DB, pass: string, code: string) {
const admin = await createUser(db, { name: 'Admin Demo', username: 'admin', password: pass, role: 'ADMIN' }, null);
await createUser(db, { name: 'Operadora Demo', username: 'caixa', password: pass, role: 'OPERADOR' }, admin);
const sup = await createUser(db, { name: 'Super Demo', username: 'super', password: pass, role: 'ADMIN', superAdmin: true }, null);
await setModules(db, Object.fromEntries(Object.keys(MODULES).map((k) => [k, true])), sup);
await setSetting(db, 'shared_cash_code_hash', hashSecret(code), admin);
await setSetting(db, 'cancel_code_hash', hashSecret(process.env.PDV_DEMO_CANCEL_CODE || code), admin);

const cats = new Map((await db.all('SELECT id, name FROM categories')).map((c) => [c.name, c.id]));
const cat = (n: string) => cats.get(n);
const P = [
  ['Cerveja Lata 350ml', 'Cervejas', 'UN', 600, 380, 120], ['Cerveja Long Neck', 'Cervejas', 'UN', 900, 560, 60],
  ['Cerveja 600ml', 'Cervejas', 'UN', 1200, 780, 48], ['Refrigerante Lata', 'Refrigerantes', 'UN', 550, 300, 72],
  ['Refrigerante 2L', 'Refrigerantes', 'UN', 1100, 720, 24], ['Chopp Pilsen', 'Chopp', 'L', 2400, 1100, 50000],
  ['Água 500ml', 'Bebidas em geral', 'UN', 350, 120, 48], ['Biscoito Recheado', 'Biscoitos', 'PCT', 450, 260, 40],
  ['Salgadinho', 'Alimentos', 'PCT', 700, 380, 30], ['Porção de Fritas', 'Alimentos', 'UN', 2500, null, 0],
  ['Arroz 5kg', 'Mercearia', 'PCT', 2990, 2300, 10], ['Feijão 1kg', 'Mercearia', 'PCT', 899, 650, 15],
] as const;
const ids: number[] = [];
for (const [i, [name, c, unit, price, cost, stock]] of P.entries()) ids.push(await createProduct(db, {
  name, category_id: cat(c), unit, price_cents: price, cost_cents: cost, internal_code: String(100 + i),
  min_stock_milli: unit === 'L' ? 20000 : 10000, barcode: `78900000${String(100 + i)}`, initial_stock_milli: (stock as number) * (unit === 'L' ? 1 : 1000) * 10,
}, admin));
await registerEntry(db, { productId: ids[7], qtyMilli: 20000, expiryDate: addDays(localDate(new Date()), 9) }, admin);
const customers: number[] = [];
for (const n of ['Cliente A', 'Cliente B', 'Cliente C']) customers.push(await createCustomer(db, { name: n }, admin));

await openRegister(db, { code, openingFloatCents: 10000 }, admin);
const methods = ['DINHEIRO', 'PIX', 'PIX', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'FIADO'];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const today = localDate(new Date());
for (let d = 29; d >= 0; d--) {
  const n = 8 + Math.floor(rnd() * 12);
  for (let k = 0; k < n; k++) {
    const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
      const i = Math.floor(rnd() * rnd() * ids.length);
      return { productId: ids[i], qtyMilli: P[i][2] === 'L' ? 300 * (1 + Math.floor(rnd() * 3)) : 1000 * (1 + Math.floor(rnd() * 3)) };
    });
    const m = methods[Math.floor(rnd() * methods.length)];
    const sale = await createSale(db, { idempotencyKey: randomUUID(), paymentMethodCode: m, items, customerId: m === 'FIADO' ? customers[k % 3] : null }, admin);
    const at = new Date(Date.parse(addDays(today, -d) + 'T12:00:00-03:00') + Math.floor(rnd() * 10) * 3600e3).toISOString();
    await db.run('UPDATE sales SET created_at = ? WHERE id = ?', [at, sale.id]);
  }
}
}

const pass = process.env.PDV_DEMO_PASSWORD;
const code = process.env.PDV_DEMO_CASH_CODE;
if (!pass || pass.length < 8 || !code) {
  console.error('Defina PDV_DEMO_PASSWORD (mín. 8) e PDV_DEMO_CASH_CODE (4-8 dígitos).');
  process.exit(1);
}
const db = await memoryDb();
await migrate(db);
await seedDemo(db, pass, code);
const port = Number(process.env.PORT || 3001);
createApp(db, { staticDir: join(process.cwd(), 'dist') }).listen(port, () => console.log(`DEMO em http://localhost:${port} — usuários: super / admin / caixa (dados fictícios em memória)`));
