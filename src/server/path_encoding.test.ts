import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toPathData, toPathPoses } from './path_encoding.ts';

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

test('paths as poses: in 3D, with their orientations, thinned as points', () => {
  const msg = {
    header: { frame_id: '/map' },
    poses: [
      { pose: { position: { x: 1.23456, y: -2, z: 0.5 }, orientation: { x: 0, y: 0, z: 0.7071068, w: 0.7071068 } } },
      { pose: { position: { x: 3, y: 4, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
    ],
  };
  assert.deepEqual(toPathPoses(msg), {
    frameId: 'map',
    points: [],
    poses: [1.235, -2, 0.5, 0, 0, 0.7071, 0.7071, 3, 4, 0, 0, 0, 0, 1],
  });
  const long = path('map', Array.from({ length: 12001 }, (_, i) => [i, 0] as [number, number]));
  const { poses } = toPathPoses(long);
  assert.ok(poses!.length / 7 <= 5001);
  // Without a z or an orientation: on the ground, facing x
  assert.deepEqual(poses!.slice(-7), [12000, 0, 0, 0, 0, 0, 1]);
});
