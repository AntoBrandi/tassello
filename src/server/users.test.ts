import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { verifyPassword } from './passwords.ts';
import { publicUser, UserStore } from './users.ts';

async function withStore(run: (store: UserStore, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-users-'));
  const file = path.join(dir, 'auth', 'users.json');
  const store = new UserStore(file);
  try {
    await store.load();
    await run(store, file);
  } finally {
    await rm(dir, { recursive: true });
  }
}

const PASSWORD = 'a long enough passphrase';

test('users are added, kept hashed in a file only its owner reads', async () => {
  await withStore(async (store, file) => {
    assert.equal(store.isEmpty(), true);
    const ada = await store.add({ username: ' Ada ', displayName: 'Ada L.', role: 'admin', password: PASSWORD });
    assert.equal(ada.username, 'ada');
    assert.equal(store.get('ADA')?.displayName, 'Ada L.');
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /passphrase/);
    assert.equal(await verifyPassword(PASSWORD, store.get('ada')!.password), true);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal('password' in publicUser(ada), false);
  });
});

test('usernames, roles and passwords are checked', async () => {
  await withStore(async (store) => {
    await assert.rejects(store.add({ username: 'no spaces', role: 'admin', password: PASSWORD }), /username/);
    await assert.rejects(store.add({ username: 'bob', role: 'root' as 'admin', password: PASSWORD }), /role/);
    await assert.rejects(store.add({ username: 'bob', role: 'admin', password: 'short' }), /At least 12/);
    await assert.rejects(store.add({ username: 'bob', role: 'admin', password: 'bob is my name ok' }), /username/);
    await store.add({ username: 'bob', role: 'admin', password: PASSWORD });
    await assert.rejects(store.add({ username: 'BOB', role: 'viewer', password: PASSWORD }), /exists already/);
  });
});

test('the last administrator who can sign in stays', async () => {
  await withStore(async (store) => {
    await store.add({ username: 'ada', role: 'admin', password: PASSWORD });
    await store.add({ username: 'bob', role: 'operator', password: PASSWORD });
    await assert.rejects(store.update('ada', { role: 'operator' }), /administrator left/);
    await assert.rejects(store.update('ada', { disabled: true }), /administrator left/);
    await assert.rejects(store.remove('ada'), /administrator left/);
    assert.equal(store.get('ada')?.role, 'admin');
    await store.update('bob', { role: 'admin' });
    await store.update('ada', { disabled: true });
    assert.equal(store.get('ada')?.disabled, true);
  });
});

test('a new password changes passwordChanged', async () => {
  await withStore(async (store) => {
    const before = await store.add({ username: 'ada', role: 'admin', password: PASSWORD });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await store.update('ada', { password: 'another long passphrase' });
    assert.notEqual(after.passwordChanged, before.passwordChanged);
    assert.equal(await verifyPassword('another long passphrase', after.password), true);
  });
});

test('changes made by another process are read again and told', async () => {
  await withStore(async (store, file) => {
    await store.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const changed: string[] = [];
    store.on('changed', (name) => changed.push(name));
    const other = new UserStore(file);
    await other.load();
    await other.update('ada', { role: 'admin', displayName: 'Ada Lovelace' });
    await other.add({ username: 'bob', role: 'viewer', password: PASSWORD });
    await store.reload(true);
    assert.equal(store.get('ada')?.displayName, 'Ada Lovelace');
    assert.equal(store.get('bob')?.role, 'viewer');
    assert.deepEqual(changed.sort(), ['ada', 'bob']);
  });
});

test('a broken entry of the file is left out', async () => {
  await withStore(async (store, file) => {
    await writeFile(file, JSON.stringify({ version: 1, users: [{ username: 'x' }, null, { username: 'ok', role: 'viewer', password: 'h' }] }));
    await store.reload(true);
    assert.deepEqual(store.list().map((u) => u.username), ['ok']);
  });
});
