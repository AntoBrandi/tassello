import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headerStamp, TopicStatsWindow } from './topic_stats.ts';

const close = (actual: number | undefined | null, expected: number) =>
  assert.ok(actual !== undefined && actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

test('a header’s stamp, read from the serialized message', () => {
  // CDR little endian: encapsulation, then sec 1729435407, nanosec 500000000
  const little = Uint8Array.from([0, 1, 0, 0, 0x0f, 0x17, 0x15, 0x67, 0x00, 0x65, 0xcd, 0x1d, 0, 0, 0, 0]);
  close(headerStamp(little), 1729435407.5);
  const big = Uint8Array.from([0, 0, 0, 0, 0x67, 0x15, 0x17, 0x0f, 0x1d, 0xcd, 0x65, 0x00]);
  close(headerStamp(big), 1729435407.5);
  assert.equal(headerStamp(Uint8Array.from([0, 1, 0, 0])), null);
});

test('rate, intervals, bandwidth, sizes and delays of the latest messages', () => {
  const window = new TopicStatsWindow(100);
  // 10 Hz, one late; 100 then 200 bytes
  const times = [0, 0.1, 0.2, 0.4];
  times.forEach((t, i) => window.add(t, i % 2 ? 200 : 100, 0.01 * (i + 1), 1000 + i));
  const stats = window.stats(100, 0);
  assert.equal(stats.received, 4);
  assert.equal(stats.window, 4);
  close(stats.rate, 3 / 0.4);
  close(stats.interval?.min, 0.1);
  close(stats.interval?.max, 0.2);
  close(stats.interval?.mean, 0.4 / 3);
  // The bytes after the first, over the time they took
  close(stats.bandwidth, (200 + 100 + 200) / 0.4);
  assert.deepEqual(stats.size, { mean: 150, min: 100, max: 200, stdDev: 50 });
  close(stats.delay?.mean, 0.025);
  assert.equal(stats.lastAt, 1003);
});

test('the window: the latest messages only, and those since a page came', () => {
  const window = new TopicStatsWindow(3);
  for (let i = 0; i < 5; i++) {
    window.add(i, 10 * (i + 1), null, i);
  }
  // The latest 3 are kept
  const stats = window.stats(10, 0);
  assert.equal(stats.received, 5);
  assert.equal(stats.window, 3);
  assert.deepEqual(stats.size, { mean: 40, min: 30, max: 50, stdDev: Math.sqrt(200 / 3) });
  assert.equal(stats.delay, null);
  assert.equal(window.stats(2, 0).window, 2);
  // A page that came after the third: two messages
  const since = window.stats(10, 3);
  assert.equal(since.received, 2);
  assert.equal(since.window, 2);
  close(since.rate, 1);
  assert.equal(window.stats(10, 5).rate, null);
});
