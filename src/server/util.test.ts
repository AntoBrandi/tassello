import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toJson } from './util.ts';

test('toJson makes typed arrays and BigInt JSON friendly', () => {
  const message = {
    name: ['a', 'b'],
    position: Float64Array.from([1.5, -2]),
    data: Uint8Array.from([1, 2]),
    stamp: { sec: 3n, nanosec: 4 },
    nested: [{ values: BigInt64Array.from([5n]) }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(toJson(message))), {
    name: ['a', 'b'],
    position: [1.5, -2],
    data: [1, 2],
    stamp: { sec: 3, nanosec: 4 },
    nested: [{ values: [5] }],
  });
});
