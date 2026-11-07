import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DASHBOARD_CLIENT_HEADER } from '../shared/protocol.ts';
import { Auth, parseCookies, Throttle } from './auth.ts';
import { HttpError } from './panels.ts';
import { UserStore } from './users.ts';

const PASSWORD = 'a long enough passphrase';

interface Setup {
  auth: Auth;
  users: UserStore;
  url: string;
  warnings: string[];
  dir: string;
}

// An Auth behind a server: /api/auth/... and /api/watch (a viewer's),
// /api/drive (an operator's)
async function withAuth(
  run: (setup: Setup) => Promise<void>,
  options: { enabled?: boolean; idleHours?: number; dir?: string; anonymousRole?: 'viewer' | null } = {},
): Promise<void> {
  const dir = options.dir ?? (await mkdtemp(path.join(tmpdir(), 'tassello-auth-')));
  const warnings: string[] = [];
  const logger = { debug() {}, info() {}, warn: (text: string) => warnings.push(text), error() {} };
  const users = new UserStore(path.join(dir, 'users.json'));
  const auth = new Auth({
    enabled: options.enabled ?? true,
    users,
    dir,
    port: 8080,
    tls: false,
    idleHours: options.idleHours ?? 12,
    hostname: 'robot',
    logger,
    anonymousRole: options.anonymousRole,
  });
  await auth.init();
  const server: Server = createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname.split('/').slice(1);
    const answer =
      route[1] === 'auth'
        ? auth.handle(req, res, route.slice(2))
        : auth.require(req, route[1] === 'drive' ? 'operator' : 'viewer').then((identity) => {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(identity.user));
          });
    answer.catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json', ...(e instanceof HttpError ? e.headers : {}) });
      res.end(JSON.stringify({ error: String((e as Error).message) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ auth, users, url, warnings, dir });
  } finally {
    server.close();
    await auth.stop();
    if (!options.dir) {
      await rm(dir, { recursive: true });
    }
  }
}

// A browser of the dashboard: its cookie, and the header of its pages
class Browser {
  cookie = '';
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${this.base}${route}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { [DASHBOARD_CLIENT_HEADER]: '' }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = response.headers.get('set-cookie');
    if (set) {
      this.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    }
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  login(username: string, password = PASSWORD) {
    return this.call('POST', '/api/auth/login', { username, password });
  }
}

test('Throttle lets a few failures go, then doubles the wait', () => {
  const throttle = new Throttle(3);
  for (let i = 0; i < 3; i++) {
    assert.equal(throttle.waitMs('ada', 1000), 0);
    throttle.fail('ada', 1000);
  }
  assert.equal(throttle.waitMs('ada', 1000), 1000);
  throttle.fail('ada', 1000);
  assert.equal(throttle.waitMs('ada', 1000), 2000);
  assert.equal(throttle.waitMs('ada', 3500), 0);
  assert.equal(throttle.waitMs('bob', 1000), 0);
  throttle.succeed('ada');
  assert.equal(throttle.waitMs('ada', 1000), 0);
});

test('parseCookies keeps the first of a name', () => {
  const cookies = parseCookies('a=1; b = 2 ;a=3; junk; c=x=y');
  assert.deepEqual([...cookies], [['a', '1'], ['b', '2'], ['c', 'x=y']]);
  assert.equal(parseCookies(undefined).size, 0);
});

test('without sign-in, everyone is an administrator', async () => {
  await withAuth(
    async ({ url }) => {
      const browser = new Browser(url);
      const { body } = await browser.call('GET', '/api/auth/session');
      assert.equal(body.enabled, false);
      assert.equal(body.user.role, 'admin');
      assert.equal((await browser.call('GET', '/api/drive')).status, 200);
      assert.equal((await browser.login('ada')).status, 404);
    },
    { enabled: false },
  );
});

test('a robot without users gets admin, whose made password is changed first', async () => {
  await withAuth(async ({ auth, url, warnings, dir }) => {
    const file = path.join(dir, 'initial-admin-password');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const password = (await readFile(file, 'utf8')).trim();
    assert.match(password, /^[A-Za-z0-9_-]{16}$/);
    // The log says where, never what
    assert.match(warnings.join('\n'), /initial-admin-password/);
    assert.equal(warnings.join('\n').includes(password), false);

    const browser = new Browser(url);
    const signedIn = await browser.login('admin', password);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.mustChangePassword, true);
    assert.equal((await browser.call('GET', '/api/auth/session')).body.mustChangePassword, true);
    // Nothing else until then
    assert.equal((await browser.call('GET', '/api/watch')).status, 403);
    const upgrade = await auth.verifyUpgrade({
      headers: { host: 'robot', origin: 'http://robot', cookie: browser.cookie },
      socket: { remoteAddress: '10.0.0.2' },
    } as never);
    assert.deepEqual(upgrade, { status: 403, reason: 'Choose a new password first' });

    const same = await browser.call('POST', '/api/auth/password', { current: password, password });
    assert.equal(same.status, 400);
    const changed = await browser.call('POST', '/api/auth/password', { current: password, password: PASSWORD });
    assert.equal(changed.status, 204);
    assert.equal((await browser.call('GET', '/api/drive')).status, 200);
    assert.equal((await browser.call('GET', '/api/auth/session')).body.mustChangePassword, false);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  });
});

test('TASSELLO_ADMIN_PASSWORD gives admin its first password, not to be changed', async () => {
  process.env.TASSELLO_ADMIN_PASSWORD = 'fleet provisioning secret';
  try {
    await withAuth(async ({ url, dir }) => {
      await assert.rejects(stat(path.join(dir, 'initial-admin-password')), { code: 'ENOENT' });
      const browser = new Browser(url);
      const signedIn = await browser.login('admin', 'fleet provisioning secret');
      assert.equal(signedIn.body.mustChangePassword, false);
      assert.equal((await browser.call('GET', '/api/drive')).status, 200);
    });
    process.env.TASSELLO_ADMIN_PASSWORD = 'short';
    await assert.rejects(withAuth(async () => {}), /TASSELLO_ADMIN_PASSWORD: At least 12/);
  } finally {
    delete process.env.TASSELLO_ADMIN_PASSWORD;
  }
});

test('signing in gives a session cookie only the server reads', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'operator', password: PASSWORD });
    const browser = new Browser(url);
    assert.equal((await browser.call('GET', '/api/watch')).status, 401);
    const { status, headers, body } = await browser.login('ADA');
    assert.equal(status, 200);
    assert.deepEqual(body.user, { username: 'ada', displayName: 'ada', role: 'operator', provider: 'local' });
    const cookie = headers.get('set-cookie') ?? '';
    assert.match(cookie, /^tassello_session_8080=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    assert.equal((await browser.call('GET', '/api/drive')).status, 200);
    assert.equal((await browser.call('GET', '/api/auth/session')).body.user.username, 'ada');

    const proxied = await new Browser(url).call('POST', '/api/auth/login', { username: 'ada', password: PASSWORD }, { 'X-Forwarded-Proto': 'https' });
    assert.match(proxied.headers.get('set-cookie') ?? '', /; Secure$/);
  });
});

test('wrong usernames and passwords get the same answer, and slow down', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const browser = new Browser(url);
    const unknown = await browser.login('nobody');
    const wrong = await browser.login('ada', 'not the password');
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
    // Five for a username: the one above, then four
    for (let i = 0; i < 4; i++) {
      assert.equal((await browser.login('ada', 'not the password')).status, 401);
    }
    const throttled = await browser.login('ada');
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
    assert.equal(browser.cookie, '');
  });
});

test('a disabled user cannot sign in, and their sessions end', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    await users.add({ username: 'bob', role: 'viewer', password: PASSWORD });
    const bob = new Browser(url);
    await bob.login('bob');
    const ada = new Browser(url);
    await ada.login('ada');
    assert.equal((await ada.call('PATCH', '/api/auth/users/bob', { disabled: true })).status, 200);
    assert.equal((await bob.call('GET', '/api/watch')).status, 401);
    assert.equal((await bob.login('bob')).status, 401);
  });
});

test('changes come from the dashboard’s pages only', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: PASSWORD }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

test('--anonymous-role viewer: watching without signing in, operating signed in', async () => {
  await withAuth(
    async ({ url, users }) => {
      await users.add({ username: 'ada', role: 'operator', password: PASSWORD });
      const guest = new Browser(url);
      const { body } = await guest.call('GET', '/api/auth/session');
      assert.equal(body.anonymous, true);
      assert.equal(body.user.role, 'viewer');
      assert.equal((await guest.call('GET', '/api/watch')).status, 200);
      const refused = await guest.call('GET', '/api/drive');
      assert.equal(refused.status, 403);
      // A guest has no password to change
      assert.equal((await guest.call('POST', '/api/auth/password', { current: 'x', password: 'y' })).status, 401);

      const ada = new Browser(url);
      await ada.login('ada');
      const signedIn = (await ada.call('GET', '/api/auth/session')).body;
      assert.equal(signedIn.anonymous, false);
      assert.equal(signedIn.user.username, 'ada');
      assert.equal((await ada.call('GET', '/api/drive')).status, 200);
      // Signed out: a guest again
      await ada.call('POST', '/api/auth/logout');
      assert.equal((await ada.call('GET', '/api/auth/session')).body.anonymous, true);
    },
    { anonymousRole: 'viewer' },
  );
});

test('signing out ends the session', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const browser = new Browser(url);
    await browser.login('ada');
    const cookie = browser.cookie;
    assert.equal((await browser.call('POST', '/api/auth/logout')).status, 204);
    assert.equal(browser.cookie, '');
    browser.cookie = cookie;
    assert.equal((await browser.call('GET', '/api/watch')).status, 401);
  });
});

test('a new password ends the other sessions, not this one', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const phone = new Browser(url);
    await phone.login('ada');
    const laptop = new Browser(url);
    await laptop.login('ada');
    const wrong = await laptop.call('POST', '/api/auth/password', { current: 'nope', password: 'brand new passphrase' });
    assert.equal(wrong.status, 403);
    const changed = await laptop.call('POST', '/api/auth/password', { current: PASSWORD, password: 'brand new passphrase' });
    assert.equal(changed.status, 204);
    assert.equal((await laptop.call('GET', '/api/watch')).status, 200);
    assert.equal((await phone.call('GET', '/api/watch')).status, 401);
    assert.equal((await new Browser(url).login('ada', 'brand new passphrase')).status, 200);
  });
});

test('roles: users are managed by administrators, operators drive', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const admin = new Browser(url);
    await admin.login('ada');
    const added = await admin.call('POST', '/api/auth/users', { username: 'vic', role: 'viewer', password: PASSWORD, displayName: 'Vic' });
    assert.equal(added.status, 201);
    assert.equal(added.body.password, undefined);
    const listed = await admin.call('GET', '/api/auth/users');
    assert.deepEqual(listed.body.map((u: { username: string }) => u.username), ['ada', 'admin', 'vic']);
    assert.equal(JSON.stringify(listed.body).includes('scrypt'), false);

    // A password an administrator made: theirs to choose first
    const viewer = new Browser(url);
    assert.equal((await viewer.login('vic')).body.mustChangePassword, true);
    assert.equal((await viewer.call('GET', '/api/watch')).status, 403);
    await viewer.call('POST', '/api/auth/password', { current: PASSWORD, password: 'their own passphrase' });
    assert.equal((await viewer.call('GET', '/api/watch')).status, 200);
    assert.equal((await viewer.call('GET', '/api/drive')).status, 403);
    assert.equal((await viewer.call('GET', '/api/auth/users')).status, 403);
    assert.equal((await viewer.call('POST', '/api/auth/users', { username: 'eve', role: 'admin', password: PASSWORD })).status, 403);

    // Their next requests are an operator's
    await admin.call('PATCH', '/api/auth/users/vic', { role: 'operator' });
    assert.equal((await viewer.call('GET', '/api/drive')).status, 200);
    assert.equal((await admin.call('DELETE', '/api/auth/users/admin')).status, 204);
    assert.equal((await admin.call('PATCH', '/api/auth/users/ada', { role: 'viewer' })).status, 409);
    assert.equal((await admin.call('DELETE', '/api/auth/users/vic')).status, 204);
    assert.equal((await viewer.call('GET', '/api/watch')).status, 401);
  });
});

test('sessions outlive a restart of the server', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-auth-'));
  try {
    let cookie = '';
    await withAuth(
      async ({ url, users }) => {
        await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
        const browser = new Browser(url);
        await browser.login('ada');
        cookie = browser.cookie;
      },
      { dir },
    );
    await withAuth(
      async ({ url }) => {
        const browser = new Browser(url);
        browser.cookie = cookie;
        assert.equal((await browser.call('GET', '/api/watch')).status, 200);
      },
      { dir },
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('an idle session ends', async () => {
  await withAuth(
    async ({ url, users }) => {
      await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
      const browser = new Browser(url);
      await browser.login('ada');
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal((await browser.call('GET', '/api/watch')).status, 401);
    },
    // 36 ms
    { idleHours: 0.00001 },
  );
});

test('tampered cookies are refused', async () => {
  await withAuth(async ({ url, users }) => {
    await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
    const browser = new Browser(url);
    await browser.login('ada');
    browser.cookie = `${browser.cookie.slice(0, -2)}xx`;
    assert.equal((await browser.call('GET', '/api/watch')).status, 401);
    browser.cookie = `tassello_session_8080=${'a'.repeat(500)}`;
    assert.equal((await browser.call('GET', '/api/watch')).status, 401);
  });
});

test('WebSockets open for signed-in users of the dashboard’s own pages', async () => {
  await withAuth(async ({ auth, url, users }) => {
    await users.add({ username: 'ada', role: 'viewer', password: PASSWORD });
    const browser = new Browser(url);
    await browser.login('ada');
    const upgrade = (headers: Record<string, string>) =>
      auth.verifyUpgrade({ headers: { host: 'robot:8080', ...headers }, socket: { remoteAddress: '10.0.0.2' } } as never);

    const ok = await upgrade({ origin: 'http://robot:8080', cookie: browser.cookie });
    assert.ok('user' in ok && ok.user.username === 'ada');
    assert.deepEqual(await upgrade({ origin: 'http://robot:8080' }), { status: 401, reason: 'Sign in first' });
    // Another site's page, even with the cookie a browser would not send
    assert.equal(((await upgrade({ origin: 'http://evil.example', cookie: browser.cookie })) as { status: number }).status, 403);
    assert.equal(((await upgrade({ origin: 'null', cookie: browser.cookie })) as { status: number }).status, 403);
    // Behind a proxy, the host it was reached at
    const proxied = await upgrade({ origin: 'https://robots.example', 'x-forwarded-host': 'robots.example', cookie: browser.cookie });
    assert.ok('user' in proxied);
  });
});
