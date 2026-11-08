import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PARTICLE_CLOUD, POSE_ARRAY, posesOf } from './pose_array.ts';

const pose = (x: number, yaw = 0) => ({
  position: { x, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
});

test('a PoseArray: every pose at full length, at most max of them', () => {
  const message = { header: { frame_id: 'map' }, poses: [pose(0), pose(1), pose(2), pose(3)] };
  const all = posesOf(message, POSE_ARRAY, 10, true);
  assert.equal(all.length, 4 * 8);
  assert.deepEqual([all[0], all[7], all[8], all[15]], [0, 1, 1, 1]);
  // evenly thinned
  const two = posesOf(message, POSE_ARRAY, 2, true);
  assert.deepEqual([two[0], two[8]], [0, 2]);
});

test('a ParticleCloud: arrows by weight, none that is not a number', () => {
  const message = {
    header: { frame_id: 'map' },
    particles: [
      { pose: pose(0), weight: 0.5 },
      { pose: pose(1), weight: 0 },
      { pose: { position: { x: NaN, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, weight: 1 },
    ],
  };
  const out = posesOf(message, PARTICLE_CLOUD, 10, true);
  assert.equal(out.length, 2 * 8);
  // the heaviest drawable is not the max: the NaN one counts for the scale
  assert.ok(out[7] > out[15]);
  assert.equal(out[15], 0.3);
  // not by weight: all full length
  const flat = posesOf(message, PARTICLE_CLOUD, 10, false);
  assert.deepEqual([flat[7], flat[15]], [1, 1]);
});
