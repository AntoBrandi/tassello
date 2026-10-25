import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dialAngle, formatSpeed, motionOf, scaleTicks, TWIST, TWIST_STAMPED } from './model.ts';

const twist = (x: number, y: number, z: number) => ({
  linear: { x, y, z: 0 },
  angular: { x: 0, y: 0, z },
});

test('the speed and turn of Twist and TwistStamped commands', () => {
  assert.deepEqual(motionOf(TWIST, twist(0.3, 0, 0.5)), { speed: 0.3, turn: 0.5 });
  const stamped = { header: { stamp: { sec: 1, nanosec: 0 }, frame_id: 'base_link' }, twist: twist(-0.2, 0, -1) };
  assert.deepEqual(motionOf(TWIST_STAMPED, stamped), { speed: -0.2, turn: -1 });
  assert.equal(motionOf('std_msgs/msg/Float64', { data: 1 }), null);
  assert.equal(motionOf(null, null), null);
});

test('omnidirectional speeds, negative going backwards', () => {
  assert.equal(motionOf(TWIST, twist(0.3, 0.4, 0))?.speed, 0.5);
  assert.equal(motionOf(TWIST, twist(-0.3, 0.4, 0))?.speed, -0.5);
  // Sideways only
  assert.equal(motionOf(TWIST, twist(0, -0.4, 0))?.speed, 0.4);
});

test('missing or odd fields count as 0', () => {
  assert.deepEqual(motionOf(TWIST, { linear: { x: 'fast' } }), { speed: 0, turn: 0 });
  assert.deepEqual(motionOf(TWIST_STAMPED, {}), { speed: 0, turn: 0 });
  assert.deepEqual(motionOf(TWIST, null), { speed: 0, turn: 0 });
});

test('the needle from the start of the scale to its end, either way', () => {
  assert.equal(dialAngle(0, 1), -120);
  assert.equal(dialAngle(0.5, 1), 0);
  assert.equal(dialAngle(-0.5, 1), 0);
  assert.equal(dialAngle(1, 1), 120);
  assert.equal(dialAngle(3, 1), 120);
  assert.equal(dialAngle(1, 0), -120);
});

test('ticks at round steps, about five labelled', () => {
  const one = scaleTicks(1);
  assert.deepEqual(one.major, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(one.minor.slice(0, 4), [0.05, 0.1, 0.15, 0.25]);
  assert.equal(one.minor.length, 15);
  // A TurtleBot3's: the scale goes on past the last label
  const turtle = scaleTicks(0.22);
  assert.deepEqual(turtle.major, [0, 0.05, 0.1, 0.15, 0.2]);
  assert.deepEqual(turtle.minor.slice(-2), [0.21, 0.22]);
  assert.deepEqual(scaleTicks(2).major, [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(scaleTicks(10).major, [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(scaleTicks(0), { major: [0], minor: [] });
});

test('speeds shown with a sign going backwards, never -0', () => {
  assert.equal(formatSpeed(0.256, 1), '0.26');
  assert.equal(formatSpeed(-0.25, 1), '−0.25');
  assert.equal(formatSpeed(-0.001, 1), '0.00');
  assert.equal(formatSpeed(12.34, 20), '12.3');
});
