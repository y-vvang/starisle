import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP scrypt guidance: N=2^16, r=8, p=2 (trades lower memory than p=1, comparable work).
// Scrypt memory requirement: 128*N*r = 128*65536*8 ≈ 67MB.
// Set maxmem=128MB for headroom above theoretical minimum (~67MB).
export const N = 65536, R = 8, P = 2;
const KEYLEN = 32, MAXMEM = 128 * 1024 * 1024;

const derive = (plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(plain, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });

export async function hash(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(String(plain), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verify(plain: string, stored: string | null | undefined): Promise<boolean> {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(String(plain), salt, +n, +r, +p);
    // 长度不等时 timingSafeEqual 会抛,先挡掉
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
