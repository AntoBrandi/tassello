// Passwords, hashed with scrypt (Node.js's own, no native module) at OWASP's
// recommended cost: N=2^15, r=8, p=3, 32 MiB a hash, a few tenths of a second
// on a Raspberry Pi. The hash names its parameters, so that a later cost
// applies to each password when next verified (needsRehash).
//
//   scrypt$<N>$<r>$<p>$<salt, base64>$<hash, base64>

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const COST = { N: 2 ** 15, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Above 128 * N * r, which scrypt needs
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, { ...options, maxmem: MAX_MEMORY }, (e, key) =>
      e ? reject(e) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string, cost = COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join('$');
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(hash: string): Parsed | null {
  const [scheme, N, r, p, salt, key] = hash.split('$');
  const numbers = [N, r, p].map(Number);
  if (scheme !== 'scrypt' || !numbers.every((n) => Number.isInteger(n) && n > 0) || !salt || !key) {
    return null;
  }
  return { N: numbers[0], r: numbers[1], p: numbers[2], salt: Buffer.from(salt, 'base64'), key: Buffer.from(key, 'base64') };
}

// In constant time for a given hash; false for a hash it cannot read
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parse(hash);
  if (!parsed || parsed.key.length !== KEY_BYTES) {
    return false;
  }
  const key = await derive(password, parsed.salt, { N: parsed.N, r: parsed.r, p: parsed.p });
  return timingSafeEqual(key, parsed.key);
}

// Made with another cost than today's
export function needsRehash(hash: string): boolean {
  const parsed = parse(hash);
  return !parsed || parsed.N !== COST.N || parsed.r !== COST.r || parsed.p !== COST.p;
}

let dummy: Promise<string> | null = null;

// Takes as long as verifying a user's password, for the names of no user: a
// sign-in does not tell which usernames exist by how long it takes
export async function verifyNothing(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
  return false;
}
