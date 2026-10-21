import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Delivery, OutputLog } from './terminal_output.ts';

test('the log gives the output from any offset it keeps', () => {
  const log = new OutputLog(100);
  log.append('hello ');
  log.append('world');
  assert.equal(log.start, 0);
  assert.equal(log.end, 11);
  assert.equal(log.since(0), 'hello world');
  assert.equal(log.since(6), 'world');
  assert.equal(log.since(11), '');
  assert.equal(log.since(12), null);
});

test('the log keeps at least its limit, the latest, in whole chunks', () => {
  const log = new OutputLog(40_000);
  const chunk = (c: string) => c.repeat(20_000);
  log.append(chunk('a'));
  log.append(chunk('b'));
  log.append(chunk('c'));
  // a dropped: b and c still make the limit
  assert.equal(log.start, 20_000);
  assert.equal(log.end, 60_000);
  assert.equal(log.since(10_000), null);
  assert.equal(log.since(39_999), `b${chunk('c')}`);
  // A chunk larger than the limit is kept whole
  log.append('d'.repeat(50_000));
  assert.equal(log.start, 60_000);
  assert.equal(log.since(60_000)?.length, 50_000);
});

test('echoes are joined into the last chunk, still dropped by the limit', () => {
  const log = new OutputLog(1000);
  for (let i = 0; i < 5000; i++) {
    log.append('x');
  }
  assert.equal(log.end, 5000);
  assert.equal(log.since(4990), 'x'.repeat(10));
  log.append('y'.repeat(20_000));
  log.append('z'.repeat(20_000));
  assert.ok(log.start > 0);
  assert.equal(log.since(log.end - 3), 'zzz');
});

test('a page gets what it lacks, at most a window ahead of what it wrote', () => {
  const log = new OutputLog(1 << 20);
  const delivery = new Delivery(0);
  assert.equal(delivery.next(log, 10), null);
  log.append('abcdef');
  assert.deepEqual(delivery.next(log, 10), { data: 'abcdef', offset: 6 });
  delivery.record(6, 6);
  log.append('0123456789');
  // 6 characters on the way: 4 more
  assert.deepEqual(delivery.next(log, 10), { data: '0123', offset: 10 });
  delivery.record(10, 4);
  // The window is full until the page writes some
  assert.equal(delivery.next(log, 10), null);
  delivery.ack(6);
  assert.equal(delivery.pending, 4);
  assert.deepEqual(delivery.next(log, 10), { data: '456789', offset: 16 });
});

test('a page lacking more than a window, or what is no longer kept, gets the screen', () => {
  const log = new OutputLog(40_000);
  log.append('x'.repeat(20_000));
  assert.equal(new Delivery(0).next(log, 10_000), 'snapshot');
  log.append('y'.repeat(20_000));
  log.append('z'.repeat(20_000));
  // Within a window, but no longer kept
  const delivery = new Delivery(10_000);
  assert.equal(log.start, 20_000);
  assert.equal(delivery.next(log, 1 << 20), 'snapshot');
  // The screen at offset 59,990 is sent (the server's terminal is that far):
  // then the rest, once the page wrote it
  delivery.record(59_990, 30_000);
  assert.equal(delivery.next(log, 30_000), null);
  delivery.ack(59_990);
  assert.deepEqual(delivery.next(log, 30_000), { data: 'z'.repeat(10), offset: 60_000 });
});

test('a message never ends in the middle of a character', () => {
  const log = new OutputLog(1000);
  log.append('ab😀cd');
  // 😀 is two code units, at 2 and 3: room for 3 of the 6
  const delivery = new Delivery(0);
  delivery.record(0, 3);
  assert.deepEqual(delivery.next(log, 6), { data: 'ab', offset: 2 });
  delivery.record(2, 2);
  // Room for 1: half of it, so nothing
  assert.equal(delivery.next(log, 6), null);
  delivery.ack(0);
  assert.deepEqual(delivery.next(log, 6), { data: '😀cd', offset: 6 });
});

test('messages are acknowledged in order, each freeing its size', () => {
  const log = new OutputLog(1000);
  log.append('a'.repeat(30));
  const delivery = new Delivery(0);
  delivery.record(10, 10);
  delivery.record(20, 10);
  delivery.record(30, 10);
  assert.equal(delivery.pending, 30);
  delivery.ack(20);
  assert.equal(delivery.pending, 10);
  delivery.ack(30);
  assert.equal(delivery.pending, 0);
});
