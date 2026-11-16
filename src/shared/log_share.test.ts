import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fairShares, keepFairly } from './log_share.ts';

const message = (name: string, seq: number) => ({ name, seq });
const shares = (counts: Record<string, number>, capacity: number) =>
  Object.fromEntries(fairShares(new Map(Object.entries(counts)), capacity));

test('the loggers that sent fewer than their share keep them all, the others split the rest', () => {
  assert.deepEqual(shares({ quiet: 3, flood: 500 }, 100), { quiet: 3, flood: 97 });
  assert.deepEqual(shares({ a: 10, b: 50, c: 60 }, 100), { a: 10, b: 45, c: 45 });
  // What does not divide: one more for the first, by name
  assert.deepEqual(shares({ b: 50, a: 50, c: 50 }, 100), { a: 34, b: 33, c: 33 });
  // All fit
  assert.deepEqual(shares({ a: 2, b: 3 }, 100), { a: 2, b: 3 });
  assert.deepEqual(shares({ a: 2 }, 0), { a: 0 });
});

test('kept fairly: a flood drops its own oldest, never a quiet logger’s', () => {
  const log = [
    message('quiet', 1),
    ...Array.from({ length: 20 }, (_, i) => message('flood', i + 2)),
    message('quiet', 22),
    message('flood', 23),
  ];
  const kept = keepFairly(log, 10);
  assert.equal(kept.length, 10);
  // In order: the quiet logger's two, the flood's latest eight (of 2 to 21, and 23)
  assert.deepEqual(
    kept.map((m) => m.seq),
    [1, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  );
  // All fit: the same array
  assert.equal(keepFairly(log, 100), log);
});
