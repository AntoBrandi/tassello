import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiagnosticsState, levelOf, STALE_AFTER_MS } from './diagnostics_state.ts';

// As rclnodejs gives a diagnostic_msgs/msg/DiagnosticStatus
const status = (name: string, level = 0, message = 'OK', values: Record<string, string> = {}) => ({
  level,
  name,
  message,
  hardware_id: 'hokuyo_123',
  values: Object.entries(values).map(([key, value]) => ({ key, value })),
});

const array = (...statuses: ReturnType<typeof status>[]) => ({
  header: { stamp: { sec: 1729435407, nanosec: 0 }, frame_id: '' },
  status: statuses,
});

const names = (batch: { statuses: { name: string }[] } | null) => batch?.statuses.map((s) => s.name);

test('statuses, numbered as they first come, with their key values', () => {
  const state = new DiagnosticsState(100);
  state.add(
    array(status('lidar: Connection', 1, 'Retrying', { Port: '/dev/ttyUSB0' }), status('amcl: Localization')),
    1000,
  );
  const { statuses, changes } = state.snapshot();
  assert.deepEqual(statuses[0], {
    id: 1,
    name: 'lidar: Connection',
    level: 1,
    message: 'Retrying',
    hardwareId: 'hokuyo_123',
    values: [{ key: 'Port', value: '/dev/ttyUSB0' }],
    stale: false,
    updated: 1000,
    since: 1000,
  });
  assert.equal(statuses[1].id, 2);
  // The first comes in warning: a change; the second, OK, is not
  assert.deepEqual(changes, [{ seq: 1, time: 1000, status: 1, level: 1, message: 'Retrying' }]);
});

test('missing or mistyped fields are empty', () => {
  const state = new DiagnosticsState(100);
  state.add({ status: [{ level: 2, values: [null, { key: 3 }] }, null] }, 0);
  state.add(null, 0);
  state.add({ status: 'nope' }, 0);
  const { statuses } = state.snapshot();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].name, '');
  assert.equal(statuses[0].level, 2);
  assert.deepEqual(statuses[0].values, [
    { key: '', value: '' },
    { key: '', value: '' },
  ]);
});

test('batches: the statuses that changed, not those received the same again', () => {
  const state = new DiagnosticsState(100);
  assert.equal(state.takeBatch(), null);
  state.add(array(status('a'), status('b')), 1000);
  assert.deepEqual(names(state.takeBatch()), ['a', 'b']);
  state.add(array(status('a'), status('b')), 2000);
  assert.equal(state.takeBatch(), null);
  state.add(array(status('a'), status('b', 0, 'OK', { Rate: '9.8' })), 3000);
  const batch = state.takeBatch();
  assert.deepEqual(names(batch), ['b']);
  assert.equal(batch?.statuses[0].updated, 3000);
  // The values changed, not the level
  assert.deepEqual(batch?.changes, []);
  assert.equal(batch?.statuses[0].since, 1000);
});

test('changes of level, each once, since when', () => {
  const state = new DiagnosticsState(100);
  state.add(array(status('motor')), 1000);
  state.add(array(status('motor', 2, 'Overcurrent')), 2000);
  state.add(array(status('motor', 2, 'Overheating')), 3000);
  state.add(array(status('motor', 0, 'OK')), 4000);
  const batch = state.takeBatch();
  assert.deepEqual(
    batch?.changes.map((c) => [c.seq, c.time, c.level, c.message]),
    [
      [1, 2000, 2, 'Overcurrent'],
      [2, 4000, 0, 'OK'],
    ],
  );
  assert.equal(batch?.statuses[0].since, 4000);
  assert.equal(state.takeBatch(), null);
});

test('stale when no longer received, fresh again when received', () => {
  const state = new DiagnosticsState(100);
  state.add(array(status('lidar', 1, 'Slow')), 1000);
  state.takeBatch();
  state.checkStale(1000 + STALE_AFTER_MS);
  assert.equal(state.takeBatch(), null);
  state.checkStale(1001 + STALE_AFTER_MS);
  let batch = state.takeBatch();
  assert.equal(batch?.statuses[0].stale, true);
  assert.equal(levelOf(batch!.statuses[0]), 3);
  assert.deepEqual(
    batch?.changes.map((c) => [c.level, c.message]),
    [[3, 'Slow']],
  );
  // Once
  state.checkStale(20_000);
  assert.equal(state.takeBatch(), null);
  // The same as before it went stale: fresh, back to its level
  state.add(array(status('lidar', 1, 'Slow')), 21_000);
  batch = state.takeBatch();
  assert.equal(batch?.statuses[0].stale, false);
  assert.equal(batch?.statuses[0].since, 21_000);
  assert.deepEqual(
    batch?.changes.map((c) => c.level),
    [1],
  );
});

test('slow publishers go stale after a few of their periods', () => {
  const state = new DiagnosticsState(100);
  state.add(array(status('slow')), 0);
  state.add(array(status('slow')), 10_000);
  state.checkStale(10_000 + 2 * STALE_AFTER_MS);
  assert.equal(state.snapshot().statuses[0].stale, false);
  state.checkStale(10_000 + 30_001);
  assert.equal(state.snapshot().statuses[0].stale, true);
});

test('published stale (the aggregator’s), then gone: no change of level', () => {
  const state = new DiagnosticsState(100);
  state.add(array(status('/Sensors/Lidar', 3, 'Stale')), 0);
  state.takeBatch();
  state.checkStale(STALE_AFTER_MS + 1);
  const batch = state.takeBatch();
  assert.equal(batch?.statuses[0].stale, true);
  assert.deepEqual(batch?.changes, []);
  assert.equal(batch?.statuses[0].since, 0);
});

test('the latest changes are kept, a batch never more', () => {
  const state = new DiagnosticsState(4);
  for (let i = 0; i < 9; i++) {
    state.add(array(status('flapping', i % 2)), i * 1000);
  }
  // From OK at first: 8 changes
  const batch = state.takeBatch();
  assert.deepEqual(
    batch?.changes.map((c) => c.seq),
    [5, 6, 7, 8],
  );
  assert.deepEqual(
    state.snapshot().changes.map((c) => c.seq),
    [5, 6, 7, 8],
  );
});
