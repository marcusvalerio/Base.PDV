import { openDb } from './db.js';
import { createApp } from './app.js';
import { join } from 'node:path';

const db = openDb(process.env.DATABASE_PATH || './data/pdv.db');
const app = createApp(db, { cookieSecure: process.env.COOKIE_SECURE === 'true', staticDir: join(process.cwd(), 'dist') });
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`API do PDV em http://localhost:${port}`));
