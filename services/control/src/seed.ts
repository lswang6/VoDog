import { createDb } from './db.js';
import { loadConfig } from './config.js';
import { hashPassword, tokenHash } from './security.js';

const email = process.env.TEST_USERNAME ?? process.env.TEST_USER_EMAIL;
const password = process.env.TEST_PASSWORD ?? process.env.TEST_USER_PASSWORD;
if (!email || !password) throw new Error('TEST_USERNAME and TEST_PASSWORD are required');
const db = createDb(loadConfig().DATABASE_URL);
try {
  await db.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role`,
    [email.toLowerCase(), await hashPassword(password), process.env.TEST_USER_ROLE === 'admin' ? 'admin' : 'user']);
  if (process.env.SEED_GATEWAY_ID && process.env.SEED_GATEWAY_TOKEN) {
    await db.query(`INSERT INTO gateways(id,name) VALUES($1,'Pixel gateway') ON CONFLICT(id) DO NOTHING`, [process.env.SEED_GATEWAY_ID]);
    await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label) VALUES($1,$2,'seed') ON CONFLICT(secret_hash) DO NOTHING`,
      [process.env.SEED_GATEWAY_ID, tokenHash(process.env.SEED_GATEWAY_TOKEN)]);
  }
  console.log('environment-provided seed applied');
} finally { await db.end(); }
