import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app.ts';
import { openDatabase } from './db.ts';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = process.env.DATABASE_PATH ?? 'data/hiscores.db';

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const app = await buildApp({
  db,
  trustProxy: process.env.TRUST_PROXY === 'true',
  submitRateLimit: Number(process.env.SUBMIT_RATE_LIMIT ?? 12),
});

const close = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ port, host });
