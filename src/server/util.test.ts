import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isSecret, keepSecret, ownPage, secretsUnder, toJson } from './util.ts';

test('toJson makes typed arrays and BigInt JSON friendly', () => {
  const message = {
    name: ['a', 'b'],
    position: Float64Array.from([1.5, -2]),
    data: Uint8Array.from([1, 2]),
    stamp: { sec: 3n, nanosec: 4 },
    nested: [{ values: BigInt64Array.from([5n]) }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(toJson(message))), {
    name: ['a', 'b'],
    position: [1.5, -2],
    data: [1, 2],
    stamp: { sec: 3, nanosec: 4 },
    nested: [{ values: [5] }],
  });
});

test('ownPage: the dashboard\'s pages, directly or through a proxy, not other sites\'', () => {
  assert.equal(ownPage({ host: 'robot.local:8080', origin: 'http://robot.local:8080' }), true);
  assert.equal(ownPage({ host: 'ROBOT.local', origin: 'http://robot.local' }), true);
  assert.equal(ownPage({ host: '[::1]:8080', origin: 'http://[::1]:8080' }), true);
  // npm run dev: Vite forwards the page's Host
  assert.equal(ownPage({ host: 'localhost:5173', origin: 'http://localhost:5173' }), true);
  assert.equal(
    ownPage({ host: 'localhost:8080', origin: 'https://robot.example.com', 'x-forwarded-host': 'robot.example.com' }),
    true,
  );
  // Not a browser
  assert.equal(ownPage({ host: 'robot.local:8080' }), true);
  assert.equal(ownPage({ host: 'robot.local:8080', origin: 'https://evil.example' }), false);
  assert.equal(ownPage({ host: 'robot.local:8080', origin: 'http://robot.local:9090' }), false);
  assert.equal(ownPage({ host: 'robot.local:8080', origin: 'null' }), false);
});

test('secret folders: their files, and links to them, are secret', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tassello-secret-'));
  try {
    const secret = path.join(root, 'data', 'auth');
    await mkdir(secret, { recursive: true });
    await writeFile(path.join(secret, 'users.json'), '{}');
    await writeFile(path.join(root, 'notes.txt'), 'hi');
    await symlink(path.join(secret, 'users.json'), path.join(root, 'innocent.yaml'));
    keepSecret(secret);
    assert.equal(await isSecret(path.join(secret, 'users.json')), true);
    assert.equal(await isSecret(secret), true);
    assert.equal(await isSecret(path.join(root, 'innocent.yaml')), true);
    assert.equal(await isSecret(path.join(root, 'notes.txt')), false);
    assert.equal(await isSecret(`${secret}-not`), false);
    assert.deepEqual(secretsUnder(root), [path.join('data', 'auth')]);
    assert.deepEqual(secretsUnder(path.join(root, 'elsewhere')), []);
  } finally {
    await rm(root, { recursive: true });
  }
});
