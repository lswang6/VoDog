import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import { loadConfig } from './config.js';

const db = createDb(loadConfig().DATABASE_URL);
try {
  const schemas=await Promise.all([
    new URL('./schema.sql',import.meta.url),
    new URL('./transcription/schema.sql',import.meta.url),
  ].map(async url=>readFile(fileURLToPath(url),'utf8')));
  await db.query(schemas.join('\n'));
  console.log('database schema is current');
} finally { await db.end(); }
