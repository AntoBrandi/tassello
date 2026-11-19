import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_RECORD_OPTIONS, type BagInfo } from '../../../shared/rosbag.ts';
import {
  baseName,
  DURATION_UNITS,
  elapsed,
  filterBags,
  formatDuration,
  inUnit,
  newBagPath,
  repairPercent,
  repairStatus,
  repairSummary,
  optionsSummary,
  recordingWhat,
  SIZE_UNITS,
  topicRate,
} from './model.ts';

test('durations: a clock beyond a minute, seconds or ms below', () => {
  assert.equal(elapsed(65_400), '1:05');
  assert.equal(elapsed(3_729_000), '1:02:09');
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(12_440), '12.4 s');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(null), '?');
});

test('a new bag’s path sorts by time; its name is the path’s last part', () => {
  const now = new Date(2026, 9, 22, 9, 5, 7);
  assert.equal(newBagPath('~/bags/', 'rosbag2', now), '~/bags/rosbag2_2026-10-22_09-05-07');
  assert.equal(newBagPath(' ', 'behavior_tree', now), '~/behavior_tree_2026-10-22_09-05-07');
  assert.equal(baseName('/home/robot/bags/run_1/'), 'run_1');
});

test('a topic’s rate over its bag', () => {
  assert.equal(topicRate({ name: '/scan', type: '', count: 100 }, 10_000), '10.0 Hz');
  assert.equal(topicRate({ name: '/imu', type: '', count: 2000 }, 10_000), '200 Hz');
  assert.equal(topicRate({ name: '/map', type: '', count: 1 }, 10_000), '0.10 Hz');
  assert.equal(topicRate({ name: '/x', type: '', count: null }, 10_000), '');
});

test('what a recording records, and with which options, in a few words', () => {
  assert.equal(recordingWhat({ all: false, topics: ['/scan'], regex: '', exclude: '' }), '/scan');
  assert.equal(recordingWhat({ all: false, topics: ['/a', '/b', '/c', '/d'], regex: '^/tf', exclude: '' }), '/a, /b and 2 more, those matching ^/tf');
  assert.equal(recordingWhat({ all: true, topics: [], regex: '', exclude: '/camera' }), 'all topics, but /camera');
  assert.equal(optionsSummary(DEFAULT_RECORD_OPTIONS, 'mcap'), 'MCAP');
  assert.equal(
    optionsSummary(
      { ...DEFAULT_RECORD_OPTIONS, storage: 'sqlite3', compressionMode: 'file', maxBagSize: 2e9, maxBagDuration: 600, useSimTime: true },
      'mcap',
    ),
    'SQLite · zstd by file · split at 2 GB or 10 min · sim time',
  );
});

test('sizes and durations in the largest unit they are whole numbers of', () => {
  assert.deepEqual(inUnit(2e9, SIZE_UNITS), { amount: 2, factor: 1e9 });
  assert.deepEqual(inUnit(1.5e9, SIZE_UNITS), { amount: 1500, factor: 1e6 });
  assert.deepEqual(inUnit(0, SIZE_UNITS), { amount: 0, factor: 1e6 });
  assert.deepEqual(inUnit(90, DURATION_UNITS), { amount: 90, factor: 1 });
  assert.deepEqual(inUnit(7200, DURATION_UNITS), { amount: 2, factor: 3600 });
});

test('bags filtered by their name or their topics', () => {
  const bag = (name: string, topics: string[]): BagInfo => ({
    path: `/bags/${name}`, name, size: 0, modified: 0, storage: 'mcap', start: null, duration: null, messages: null,
    topics: topics.map((topic) => ({ name: topic, type: '', count: null })), files: [], compression: null, recording: false, problem: null, repairable: false, repair: null,
  });
  const bags = [bag('lab_run', ['/scan']), bag('field_test', ['/gps/fix', '/odom'])];
  assert.deepEqual(filterBags(bags, 'LAB').map((b) => b.name), ['lab_run']);
  assert.deepEqual(filterBags(bags, 'gps; scan').map((b) => b.name), ['lab_run', 'field_test']);
  assert.equal(filterBags(bags, ' ').length, 2);
});

test('a repair, as the widget says it', () => {
  assert.equal(repairStatus({ done: 0, total: 0 }), 'Repairing: looking at its files…');
  assert.equal(repairPercent({ done: 999, total: 1000 }), 99);
  assert.equal(repairPercent({ done: 5, total: 0 }), 0);
  assert.match(repairStatus({ done: 1.2e9, total: 2.6e9 }), /^Repairing: reading its files, 46% \(.+ of .+\)$/);
  const repair = {
    path: '/bags/run',
    version: 5,
    messages: 1653,
    duration: 6359.78,
    files: ['run_0.mcap.zstd', 'run_1.mcap.zstd'],
    skipped: [],
    compressed: [],
  };
  assert.equal(repairSummary(repair), 'Repaired run: 1653 messages over 6.4 s, in 2 files');
  assert.equal(
    repairSummary({ ...repair, messages: 1, files: ['run_0.mcap.zstd'], compressed: ['run_0.mcap.zstd'], skipped: [{ name: 'run_1.mcap', reason: 'empty' }] }),
    'Repaired run: 1 message over 6.4 s, in 1 file; run_0.mcap compressed, as its recording would have; left out, as nothing of them can be read: run_1.mcap (empty)',
  );
});
