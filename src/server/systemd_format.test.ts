import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkUnit,
  journalLine,
  loadedUnits,
  ownUnit,
  serviceGlob,
  showTimestamp,
  shownServices,
  unitFiles,
} from './systemd_format.ts';

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
    'StateChangeTimestamp=Fri 2026-10-16 10:40:00 UTC',
    '',
    'Id=dieletrikbot-web.service',
    'ActiveState=active',
    'StateChangeTimestamp=n/a',
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
    since: 1792147200000,
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

test('systemctl show timestamps: utc (systemd 244 on), unix (251 on), none', () => {
  assert.equal(showTimestamp('Tue 2026-10-20 10:46:16 UTC'), Date.UTC(2026, 9, 20, 10, 46, 16));
  // Whatever the locale's day names
  assert.equal(showTimestamp('Di 2026-10-20 10:46:16 UTC'), Date.UTC(2026, 9, 20, 10, 46, 16));
  assert.equal(showTimestamp('Tue 2026-10-20 10:46:16.123456 UTC'), Date.UTC(2026, 9, 20, 10, 46, 16, 123));
  assert.equal(showTimestamp('@1792500000'), 1792500000000);
  assert.equal(showTimestamp('n/a'), null);
  assert.equal(showTimestamp(''), null);
  assert.equal(showTimestamp(undefined), null);
  // Not UTC: not guessed
  assert.equal(showTimestamp('Tue 2026-10-20 12:46:16 CEST'), null);
});
