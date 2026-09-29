import { createHash, randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
const scrypt = (password: string, salt: Buffer, length: number, options: Parameters<typeof rawScrypt>[3]) =>
  new Promise<Buffer>((resolve, reject) => rawScrypt(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key)));

export const opaqueToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [name, n, r, p, salt64, key64] = encoded.split('$');
  if (name !== 'scrypt' || !n || !r || !p || !salt64 || !key64) return false;
  const expected = Buffer.from(key64, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt64, 'base64url'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const requestFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
