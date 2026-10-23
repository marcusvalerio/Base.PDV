import { openDb, migrate } from '../db.js';
const db = openDb(process.env.DATABASE_PATH || './data/pdv.db');
console.log('Migrations aplicadas:', migrate(db).join(', ') || 'nenhuma pendente');
