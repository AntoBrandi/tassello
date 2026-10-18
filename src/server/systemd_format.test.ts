import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkUnit, journalLine, loadedUnits, ownUnit, serviceGlob, shownServices, unitFiles } from './systemd_format.ts';

test('names and globs become service globs', () => {
  assert.equal(serviceGlob('dieletrikbot'), 'dieletrikbot*.service');
  assert.equal(serviceGlob(' dieletrikbot-* '), 'dieletrikbot-*.service');
  assert.equal(serviceGlob('ssh.service'), 'ssh.service');
  assert.throws(() => serviceGlob('a; rm -rf ~'));
  assert.throws(() => serviceGlob(''));
});

test('units are checked', () => {
  assert.equal(checkUnit('dieletrikbot-laser.service'), 'dieletrikbot-laser.service');
  assert.throws(() => checkUnit('--help'));
  assert.throws(() => checkUnit('x.service; reboot'));
});

test('unit files leave out aliases and templates', () => {
  const output = [
    'dieletrikbot-controller.service         linked  enabled',
    'dieletrikbot-hardware-interface.service alias   -',
    'dieletrikbot-simulation.service         enabled enabled',
    'dieletrikbot-thing@.service             static  -',
    '',
  ].join('\n');
  assert.deepEqual(unitFiles(output), ['dieletrikbot-controller.service', 'dieletrikbot-simulation.service']);
  assert.deepEqual(loadedUnits('dieletrikbot-laser.service loaded active running Lidars\n'), ['dieletrikbot-laser.service']);
});

test('systemctl show blocks become services', () => {
  const output = [
    'Result=exit-code',
    'Id=dieletrikbot-laser.service',
    'Description=Dieletrikbot lidar drivers = scan merger',
    'LoadState=loaded',
    'ActiveState=failed',
    'SubState=failed',
    'UnitFileState=enabled',
    'StateChangeTimestamp=@1791900000',
    '',
    'Id=dieletrikbot-web.service',
    'ActiveState=active',
    'StateChangeTimestamp=',
  ].join('\n');
  const [laser, web] = shownServices(output, 'system', 'dieletrikbot-web.service');
  assert.deepEqual(laser, {
    unit: 'dieletrikbot-laser.service',
    scope: 'system',
    description: 'Dieletrikbot lidar drivers = scan merger',
    load: 'loaded',
    active: 'failed',
    sub: 'failed',
    result: 'exit-code',
    enabled: 'enabled',
    since: 1791900000000,
    self: false,
  });
  assert.equal(web.since, null);
  assert.equal(web.self, true);
});

test('the own unit comes from the cgroup', () => {
  assert.equal(
    ownUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dieletrikbot-web.service\n'),
    'dieletrikbot-web.service',
  );
  assert.equal(ownUnit('0::/system.slice/dieletrikbot-web.service\n'), 'dieletrikbot-web.service');
  assert.equal(ownUnit('0::/user.slice/user-1000.slice/session-2.scope\n'), null);
});

test('journal lines lose their date, host and process', () => {
  assert.equal(journalLine('2026-10-14T08:31:02+02:00 alien bash[1234]: tick 1'), '08:31:02 tick 1');
  assert.equal(
    journalLine('2026-10-14T08:31:02+0200 robot ros2[99]: [INFO] [1.2] [node]: up: ok'),
    '08:31:02 [INFO] [1.2] [node]: up: ok',
  );
  assert.equal(journalLine('-- No entries --'), '-- No entries --');
});
