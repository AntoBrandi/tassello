import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';

import { groundPoint } from './pointer.ts';

// The viewer's world: ROS's z up turned into three.js's y up
function world(): Group {
  const group = new Group();
  group.rotation.x = -Math.PI / 2;
  group.updateMatrixWorld(true);
  return group;
}

test('a ray straight down hits the ground below it, in ROS axes', () => {
  const p = groundPoint(new Vector3(2, 10, -3), new Vector3(0, -1, 0));
  assert.deepEqual(p?.toArray(), [2, 3, 0]);
  // The same point as the world group places it
  const placed = world().localToWorld(new Vector3(2, 3, 0));
  assert.ok(Math.abs(placed.x - 2) < 1e-9 && Math.abs(placed.y) < 1e-9 && Math.abs(placed.z + 3) < 1e-9);
});

test('rays along the ground or away from it hit nothing', () => {
  assert.equal(groundPoint(new Vector3(0, 1, 0), new Vector3(1, 0, 0)), null);
  assert.equal(groundPoint(new Vector3(0, 1, 0), new Vector3(0, 1, 0)), null);
  assert.equal(groundPoint(new Vector3(0, -1, 0), new Vector3(0, -1, 0)), null);
});

test('the 2D view: the middle of the view is the point it looks at', () => {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  camera.up.set(0, 0, -1);
  camera.position.set(4, 200, -5);
  camera.lookAt(4, 0, -5);
  camera.zoom = 0.1;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(0, 0), camera);
  const p = groundPoint(raycaster.ray.origin, raycaster.ray.direction)!;
  assert.ok(Math.abs(p.x - 4) < 1e-6 && Math.abs(p.y - 5) < 1e-6);
  // ROS x to the right, y up: right of the middle is +x, above is +y
  raycaster.setFromCamera(new Vector2(0.5, 0), camera);
  assert.ok(groundPoint(raycaster.ray.origin, raycaster.ray.direction)!.x > 4);
  raycaster.setFromCamera(new Vector2(0, 0.5), camera);
  assert.ok(groundPoint(raycaster.ray.origin, raycaster.ray.direction)!.y > 5);
});

test('the 3D view: a camera above and in front hits the ground ahead', () => {
  const camera = new PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.set(1, 1, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(0, 0), camera);
  const p = groundPoint(raycaster.ray.origin, raycaster.ray.direction)!;
  assert.ok(p.length() < 1e-6);
});
