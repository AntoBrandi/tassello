import assert from 'node:assert/strict';
import { test } from 'node:test';

import { polygonPoints, scanPoints, type LaserScanMessage } from './overlay_encoding.ts';
import { IDENTITY, type Transform } from './transforms.ts';

const scan = (ranges: number[], parts: Partial<LaserScanMessage> = {}): LaserScanMessage => ({
  header: { frame_id: 'laser' },
  angle_min: 0,
  angle_increment: Math.PI / 2,
  range_min: 0.1,
  range_max: 10,
  ranges,
  ...parts,
});

// Rotated by angle about the axis (x, y, z), then moved by (tx, ty)
function transform(tx: number, ty: number, axis: [number, number, number], angle: number): Transform {
  const s = Math.sin(angle / 2);
  return {
    translation: { x: tx, y: ty, z: 0.3 },
    rotation: { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(angle / 2) },
  };
}

test('a scan’s points with a return, in its frame', () => {
  // Ahead, left, behind, right; then no returns
  assert.deepEqual(scanPoints(scan([1, 2, 3, 4]), IDENTITY), [1, 0, 0, 2, -3, 0, 0, -4]);
  assert.deepEqual(scanPoints(scan([Infinity, NaN, 0.05, 11]), IDENTITY), []);
  // range_max itself is a return, as RViz has it
  assert.deepEqual(scanPoints(scan([10]), IDENTITY), [10, 0]);
});

test('a scan’s points in another frame: where the lidar is mounted, upside down too', () => {
  // A lidar 0.2 m ahead of the robot, turned left: ahead of it is the robot's left
  assert.deepEqual(scanPoints(scan([1]), transform(0.2, 0, [0, 0, 1], Math.PI / 2)), [0.2, 1]);
  // Upside down (rolled 180°): its left is the robot's right
  assert.deepEqual(scanPoints(scan([1, 2]), transform(0, 0, [1, 0, 0], Math.PI)), [1, 0, 0, -2]);
});

test('dense scans thinned out, evenly', () => {
  const ranges = Array.from({ length: 3000 }, () => 5);
  const points = scanPoints(scan(ranges, { angle_increment: (2 * Math.PI) / 3000 }), IDENTITY, 1000);
  assert.equal(points.length / 2, 1000);
  // Centimeters
  assert.ok(points.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9));
});

test('a footprint’s corners in another frame', () => {
  const footprint = {
    header: { frame_id: 'odom' },
    polygon: {
      points: [
        { x: 1.3, y: 2.25, z: 0 },
        { x: 0.7, y: 2.25, z: 0 },
        { x: 0.7, y: 1.75, z: 0 },
        { x: 1.3, y: 1.75, z: 0 },
      ],
    },
  };
  // The robot at (1, 2) in odom, unturned: odom's points in the robot's frame
  const robotInOdom: Transform = { translation: { x: -1, y: -2, z: 0 }, rotation: IDENTITY.rotation };
  assert.deepEqual(polygonPoints(footprint, robotInOdom), [0.3, 0.25, -0.3, 0.25, -0.3, -0.25, 0.3, -0.25]);
});
