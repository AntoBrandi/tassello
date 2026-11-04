import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isNotAllowed, notAllowedMessage, passwordProblem, requiredRole, roleAtLeast } from './auth.ts';
import type { ClientMessage } from './protocol.ts';

const message = (value: object) => value as ClientMessage;

test('each role can do what those below it can', () => {
  assert.equal(roleAtLeast('admin', 'viewer'), true);
  assert.equal(roleAtLeast('operator', 'operator'), true);
  assert.equal(roleAtLeast('operator', 'admin'), false);
  assert.equal(roleAtLeast('viewer', 'operator'), false);
});

test('watching is a viewer’s, driving an operator’s, the system an administrator’s', () => {
  assert.equal(requiredRole(message({ type: 'image.subscribe' })), 'viewer');
  assert.equal(requiredRole(message({ type: 'twist' })), 'operator');
  assert.equal(requiredRole(message({ type: 'params.set' })), 'operator');
  assert.equal(requiredRole(message({ type: 'terminal.open' })), 'admin');
  assert.equal(requiredRole(message({ type: 'terminal.input' })), 'admin');
  assert.equal(requiredRole(message({ type: 'bt.file.save' })), 'admin');
});

test('some actions need more than others of the same message', () => {
  assert.equal(requiredRole(message({ type: 'network.action', request: { action: 'rescan' } })), 'operator');
  assert.equal(requiredRole(message({ type: 'network.action', request: { action: 'delete' } })), 'admin');
  assert.equal(requiredRole(message({ type: 'bags.action', request: { action: 'record' } })), 'operator');
  assert.equal(requiredRole(message({ type: 'bags.action', request: { action: 'delete' } })), 'admin');
});

test('unknown messages need an administrator', () => {
  assert.equal(requiredRole(message({ type: 'something.new' })), 'admin');
  assert.equal(requiredRole(message({ type: 'toString' })), 'admin');
});

test('passwords: long, not the username, not a repeated or common one', () => {
  assert.equal(passwordProblem('correct horse battery staple', 'ada'), null);
  assert.equal(passwordProblem('ünïcödé pässwörd', 'ada'), null);
  assert.match(passwordProblem('short', 'ada') ?? '', /At least 12/);
  assert.match(passwordProblem('x'.repeat(300), 'ada') ?? '', /At most/);
  assert.match(passwordProblem('my name is ADA ok', 'ada') ?? '', /username/);
  assert.match(passwordProblem('abababababababab', 'ada') ?? '', /repetitive/);
  assert.match(passwordProblem('password123456', 'ada') ?? '', /common/);
  assert.match(passwordProblem('Password1234!', 'ada') ?? '', /common/);
});

test('refusals for the role say so, and are told apart', () => {
  assert.equal(notAllowedMessage('operator'), 'Not allowed for your role: it takes an operator');
  assert.equal(notAllowedMessage('admin'), 'Not allowed for your role: it takes an administrator');
  assert.equal(isNotAllowed(notAllowedMessage('viewer')), true);
  assert.equal(isNotAllowed('Service /x is not available'), false);
});

test('the viewer streams of 0.10 to 0.18 are a viewer’s', () => {
  for (const type of ['octomap.subscribe', 'points.subscribe', 'tf.frames', 'twistmux.subscribe'] as const) {
    assert.equal(requiredRole({ type } as ClientMessage), 'viewer', type);
  }
  // Each plugin handler says its own role
  assert.equal(requiredRole({ type: 'plugin.request' } as ClientMessage), 'viewer');
});
