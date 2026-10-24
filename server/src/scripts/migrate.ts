import { openDb, migrate } from '../db.js';
if (!process.env.DATABASE_URL) { console.error('Defina DATABASE_URL (string de conexão do Neon).'); process.exit(1); }
const db = await openDb();
console.log('Migrations aplicadas:', (await migrate(db)).join(', ') || 'nenhuma pendente');
await db.close();
