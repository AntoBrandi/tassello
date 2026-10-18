import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compose, invert, TfTree, yawOf, type Transform } from './transforms.ts';

function planar(x: number, y: number, yaw: number): Transform {
  return {
    translation: { x, y, z: 0 },
    rotation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
  };
}

function assertPlanar(t: Transform, x: number, y: number, yaw: number): void {
  assert.ok(Math.abs(t.translation.x - x) < 1e-9, `x ${t.translation.x} != ${x}`);
  assert.ok(Math.abs(t.translation.y - y) < 1e-9, `y ${t.translation.y} != ${y}`);
  assert.ok(Math.abs(yawOf(t.rotation) - yaw) < 1e-9, `yaw ${yawOf(t.rotation)} != ${yaw}`);
}

test('compose applies the second transform in the first one', () => {
  // 1 m ahead of a frame at (1, 0) turned left is at (1, 1)
  assertPlanar(compose(planar(1, 0, Math.PI / 2), planar(1, 0, 0)), 1, 1, Math.PI / 2);
});

test('invert undoes', () => {
  const t = planar(2, -1, 0.7);
  assertPlanar(compose(t, invert(t)), 0, 0, 0);
  assertPlanar(compose(invert(t), t), 0, 0, 0);
});

test('lookup chains the transforms to the common root', () => {
  const tree = new TfTree();
  tree.set('map', 'odom', planar(1, 2, Math.PI / 2), 1000);
  tree.set('/odom', 'base_footprint', planar(1, 0, 0), 1500);
  tree.set('base_footprint', 'camera', planar(0.2, 0, 0), null);
  const robot = tree.lookup('map', 'base_footprint', 2000);
  assertPlanar(robot.transform, 1, 3, Math.PI / 2);
  // The oldest dynamic transform, map -> odom
  assert.equal(robot.ageMs, 1000);
  // Down the tree: the map's origin seen from the camera
  const map = tree.lookup('camera', '/map', 2000);
  assertPlanar(compose(robot.transform, compose(planar(0.2, 0, 0), map.transform)), 0, 0, 0);
  assert.equal(tree.lookup('camera', 'base_footprint', 2000).ageMs, 0);
});

test('lookup reports what is missing', () => {
  const tree = new TfTree();
  tree.set('odom', 'base_footprint', planar(0, 0, 0), 0);
  tree.set('map', 'other', planar(0, 0, 0), 0);
  assert.throws(() => tree.lookup('map', 'base_footprint', 0), /"map" and "base_footprint" are not connected/);
  assert.throws(() => tree.lookup('map', 'laser', 0), /Frame "laser" does not exist/);
  assertPlanar(tree.lookup('odom', 'odom', 0).transform, 0, 0, 0);
});
