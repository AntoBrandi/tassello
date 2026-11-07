import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashPassword, needsRehash, verifyNothing, verifyPassword } from './passwords.ts';

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };

test('a password verifies against its hash, another does not', async () => {
  const hash = await hashPassword('correct horse battery', CHEAP);
  assert.match(hash, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterY', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('each hash has its own salt', async () => {
  const [a, b] = await Promise.all([hashPassword('same password', CHEAP), hashPassword('same password', CHEAP)]);
  assert.notEqual(a, b);
});

test('passwords are compared as Unicode normalizes them', async () => {
  const hash = await hashPassword('café au lait!', CHEAP);
  assert.equal(await verifyPassword('café au lait!', hash), true);
});

test('hashes it cannot read verify nothing', async () => {
  for (const hash of ['', 'plain', 'bcrypt$x', 'scrypt$0$8$1$c2FsdA==$a2V5', 'scrypt$1024$8$1$c2FsdA==$c2hvcnQ=']) {
    assert.equal(await verifyPassword('anything', hash), false);
  }
});

test('hashes of another cost are to be made again', async () => {
  assert.equal(needsRehash(await hashPassword('x', CHEAP)), true);
  assert.equal(needsRehash(await hashPassword('x')), false);
  assert.equal(needsRehash('garbage'), true);
});

test('verifyNothing never succeeds', async () => {
  assert.equal(await verifyNothing('whatever'), false);
});
