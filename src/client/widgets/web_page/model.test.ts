import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAddress, shortAddress } from './model.ts';

const page = new URL('http://robot.local:8080/#/teleoperation');
const secure = new URL('https://robot.example.com/#/teleoperation');

test('addresses as typed, and without a scheme over HTTP', () => {
  assert.deepEqual(resolveAddress('https://grafana.example.com/d/robot', page), {
    kind: 'page',
    url: 'https://grafana.example.com/d/robot',
  });
  assert.deepEqual(resolveAddress(' 192.168.1.20:8081/status ', page), { kind: 'page', url: 'http://192.168.1.20:8081/status' });
  assert.deepEqual(resolveAddress('localhost:3000', page), { kind: 'page', url: 'http://localhost:3000/' });
  assert.deepEqual(resolveAddress('router.lan', page), { kind: 'page', url: 'http://router.lan/' });
});

test('a port alone is on the host the dashboard was opened by', () => {
  assert.deepEqual(resolveAddress(':8765/', page), { kind: 'page', url: 'http://robot.local:8765/' });
  assert.deepEqual(resolveAddress(':3000/d/robot?kiosk', new URL('http://10.0.0.5:8080/')), {
    kind: 'page',
    url: 'http://10.0.0.5:3000/d/robot?kiosk',
  });
  assert.deepEqual(resolveAddress(':9000', new URL('http://[fe80::1]:8080/')), { kind: 'page', url: 'http://[fe80::1]:9000/' });
});

test('a path is on the dashboard’s server, but not the dashboard itself', () => {
  assert.deepEqual(resolveAddress('/grafana/', page), { kind: 'page', url: 'http://robot.local:8080/grafana/' });
  assert.equal(resolveAddress('/', page).kind, 'blocked');
  assert.equal(resolveAddress(':8080/#/navigation', page).kind, 'blocked');
});

test('only web pages', () => {
  for (const address of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://robot.local/']) {
    assert.equal(resolveAddress(address, page).kind, 'invalid', address);
  }
  assert.equal(resolveAddress('http://exa mple.com', page).kind, 'invalid');
  assert.equal(resolveAddress(':99999', page).kind, 'invalid');
});

test('an HTTPS dashboard cannot show http:// pages, but its own machine’s', () => {
  const blocked = resolveAddress('http://192.168.1.20/', secure);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.kind === 'blocked' && blocked.url, 'http://192.168.1.20/');
  assert.equal(resolveAddress('https://192.168.1.20/', secure).kind, 'page');
  assert.equal(resolveAddress(':3000', secure).kind, 'page');
  assert.equal(resolveAddress('http://localhost:3000', secure).kind, 'page');
});

test('short addresses', () => {
  assert.equal(shortAddress('http://robot.local:8765/'), 'robot.local:8765');
  assert.equal(shortAddress('https://grafana.example.com/d/robot?kiosk'), 'grafana.example.com/d/robot?kiosk');
});
