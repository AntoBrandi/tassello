import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toPathData } from './path_encoding.ts';

function path(frame: string, points: [number, number][]) {
  return { header: { frame_id: frame }, poses: points.map(([x, y]) => ({ pose: { position: { x, y } } })) };
}

test('paths become flat, rounded points', () => {
  assert.deepEqual(toPathData(path('/map', [[1.23456, -2], [3, 4.0004]])), {
    frameId: 'map',
    points: [1.235, -2, 3, 4],
  });
  assert.deepEqual(toPathData(path('map', [])), { frameId: 'map', points: [] });
});

test('long paths are thinned out, keeping their end', () => {
  const long = path('map', Array.from({ length: 12001 }, (_, i) => [i, 0] as [number, number]));
  const { points } = toPathData(long);
  assert.ok(points.length / 2 <= 5001, `${points.length / 2} points`);
  assert.deepEqual(points.slice(0, 2), [0, 0]);
  assert.deepEqual(points.slice(-2), [12000, 0]);
});
