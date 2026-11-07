import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DASHBOARD_CLIENT_HEADER } from '../shared/protocol.ts';
import { Auth } from './auth.ts';
import { apiRole, createRequestHandler } from './http.ts';
import { checkFrameAncestors, frameHeaders } from './util.ts';
import { PanelStore } from './panels.ts';
import type { PluginHost } from './plugins.ts';
import { UserStore } from './users.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const PASSWORD = 'a long enough passphrase';

test('apiRole: watching is a viewer’s, the files an operator’s, changes an administrator’s', () => {
  assert.equal(apiRole('GET', ['panels']), 'viewer');
  assert.equal(apiRole('GET', ['panels', 'drive']), 'viewer');
  assert.equal(apiRole('PUT', ['panels', 'drive']), 'admin');
  assert.equal(apiRole('DELETE', ['panels', 'drive']), 'admin');
  assert.equal(apiRole('GET', ['files']), 'viewer');
  assert.equal(apiRole('GET', ['files', 'list']), 'operator');
  assert.equal(apiRole('GET', ['fs', 'list']), 'operator');
  assert.equal(apiRole('POST', ['fs', 'op']), 'admin');
  assert.equal(apiRole('PUT', ['fs', 'text']), 'admin');
  assert.equal(apiRole('POST', ['uploads']), 'operator');
});

test('the server: its page for anyone, the API for its users by role, never framed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-http-'));
  const www = path.join(dir, 'www');
  await mkdir(www);
  await writeFile(path.join(www, 'index.html'), '<!doctype html><title>Tassello</title>');
  const store = new PanelStore(path.join(dir, 'panels'), [], silent);
  await store.init();
  const users = new UserStore(path.join(dir, 'auth', 'users.json'));
  const auth = new Auth({ enabled: true, users, dir: path.join(dir, 'auth'), port: 8080, tls: false, idleHours: 12, hostname: 'robot', logger: silent });
  await auth.init();
  await users.add({ username: 'ada', role: 'admin', password: PASSWORD });
  await users.add({ username: 'vic', role: 'viewer', password: PASSWORD });
  const plugins = { info: () => [], clientDir: () => null } as unknown as PluginHost;
  const server = createServer(
    createRequestHandler({ store, wwwDir: www, topics: () => [], uploadsDir: path.join(dir, 'images'), plugins, auth, tls: false, logger: silent }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (username: string) => {
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [DASHBOARD_CLIENT_HEADER]: '' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    return (response.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const panel = { name: 'Drive', widgets: [] };
  const put = (cookie: string, headers: Record<string, string> = { [DASHBOARD_CLIENT_HEADER]: '' }) =>
    fetch(`${url}/api/panels/drive`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(panel) });

  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('strict-transport-security'), null);

    assert.equal((await fetch(`${url}/api/panels`)).status, 401);
    assert.equal((await fetch(`${url}/plugins/x/index.js`)).status, 401);

    const viewer = await signIn('vic');
    assert.equal((await fetch(`${url}/api/panels`, { headers: { Cookie: viewer } })).status, 200);
    assert.equal((await put(viewer)).status, 403);
    assert.equal((await fetch(`${url}/api/fs/list?path=/`, { headers: { Cookie: viewer } })).status, 403);

    const admin = await signIn('ada');
    // Without the dashboard's header: another site's form
    assert.equal((await put(admin, {})).status, 403);
    assert.equal((await put(admin)).status, 200);
    assert.equal((await store.get('drive'))?.name, 'Drive');

    // Panels for operators: hidden from viewers, as if there were none
    await store.save('arm', { name: 'Arm', minRole: 'operator' }, null);
    const list = async (cookie: string) =>
      ((await (await fetch(`${url}/api/panels`, { headers: { Cookie: cookie } })).json()) as { id: string }[]).map((p) => p.id);
    assert.deepEqual(await list(viewer), ['drive']);
    assert.deepEqual(await list(admin), ['arm', 'drive']);
    assert.equal((await fetch(`${url}/api/panels/arm`, { headers: { Cookie: viewer } })).status, 404);
    assert.equal((await fetch(`${url}/api/panels/arm`, { headers: { Cookie: admin } })).status, 200);
  } finally {
    server.close();
    await auth.stop();
    await rm(dir, { recursive: true });
  }
});

test('--frame-ancestors: nobody by default, else the sites given, without X-Frame-Options', () => {
  assert.deepEqual(frameHeaders("'none'"), { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
  assert.deepEqual(frameHeaders("'self' https://ops.example.com"), {
    'Content-Security-Policy': "frame-ancestors 'self' https://ops.example.com",
  });
  assert.equal(checkFrameAncestors(" 'self'   https://*.example.com:8443 "), "'self' https://*.example.com:8443");
  assert.equal(checkFrameAncestors("'none'"), "'none'");
  assert.throws(() => checkFrameAncestors(''), /empty/);
  // No other directive slipped in
  assert.throws(() => checkFrameAncestors("'self'; script-src *"), /is not/);
  assert.throws(() => checkFrameAncestors("'unsafe-inline'"), /is not/);
  assert.throws(() => checkFrameAncestors("'none' 'self'"), /is not/);
});
