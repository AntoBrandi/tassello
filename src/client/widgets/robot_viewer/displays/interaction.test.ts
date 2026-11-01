import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Quaternion, Ray, Vector3 } from 'three';

import { InteractionMode, OrientationMode } from '../interactive_markers.ts';
import { controlAxis, controlFrame, MarkerDrag, viewFacing } from './interaction.ts';

const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} is not ${b}`);
const nearVector = (v: Vector3, x: number, y: number, z: number) => {
  near(v.x, x);
  near(v.y, y);
  near(v.z, z);
};

// From above, looking down at (x, y)
function down(x: number, y: number): Ray {
  return new Ray(new Vector3(x, y, 10), new Vector3(0, 0, -1));
}

function start(mode: number, axis: Vector3, grab: Vector3) {
  return new MarkerDrag({
    mode,
    pose: { position: new Vector3(), quaternion: new Quaternion() },
    axis,
    grab,
    view: new Vector3(0, 0, -1),
  });
}

test('along an axis: the closest point of the axis to the ray', () => {
  const drag = start(InteractionMode.MOVE_AXIS, new Vector3(1, 0, 0), new Vector3(0.5, 0, 0));
  nearVector(drag.move(down(2.5, 1))!.position, 2, 0, 0);
  // Looking along the axis tells nothing
  assert.equal(drag.move(new Ray(new Vector3(-5, 0, 0), new Vector3(1, 0, 0))), null);
  nearVector(drag.current.position, 2, 0, 0);
});

test('in a plane: as far as the ray moved in it, from the grab point', () => {
  const drag = start(InteractionMode.MOVE_PLANE, new Vector3(0, 0, 1), new Vector3(0.5, 0, 0));
  nearVector(drag.move(down(1.5, 2))!.position, 1, 2, 0);
  // Seen edge on
  assert.equal(drag.move(new Ray(new Vector3(0, -5, 0), new Vector3(0, 1, 0))), null);
});

test('around an axis: the angle the ray turned about it', () => {
  const drag = start(InteractionMode.ROTATE_AXIS, new Vector3(0, 0, 1), new Vector3(1, 0, 0));
  const pose = drag.move(down(0, 2))!;
  nearVector(pose.position, 0, 0, 0);
  // A quarter turn about z: x to y
  nearVector(new Vector3(1, 0, 0).applyQuaternion(pose.quaternion), 0, 1, 0);
  const back = drag.move(down(1, -1))!;
  nearVector(new Vector3(1, 0, 0).applyQuaternion(back.quaternion), Math.SQRT1_2, -Math.SQRT1_2, 0);
});

test('move and rotate: pulled by the grab point', () => {
  const drag = start(InteractionMode.MOVE_ROTATE, new Vector3(0, 0, 1), new Vector3(1, 0, 0));
  // Straight out: moved, not turned
  const out = drag.move(down(3, 0))!;
  nearVector(out.position, 2, 0, 0);
  nearVector(new Vector3(1, 0, 0).applyQuaternion(out.quaternion), 1, 0, 0);
  // Around: turned to face the pointer, the grab point under it
  const around = drag.move(down(2, 1))!;
  nearVector(around.position, 2, 0, 0);
  nearVector(new Vector3(1, 0, 0).applyQuaternion(around.quaternion), 0, 1, 0);
});

test('in 3D: across the view, or turned as a trackball', () => {
  const move = start(InteractionMode.MOVE_3D, new Vector3(1, 0, 0), new Vector3(0, 0, 0.5));
  nearVector(move.move(down(1, 1))!.position, 1, 1, 0);
  const turn = start(InteractionMode.ROTATE_3D, new Vector3(1, 0, 0), new Vector3(0, 0, 1));
  // The top of the ball pulled to the side: a quarter turn about y
  const pose = turn.move(new Ray(new Vector3(5, 0, 0), new Vector3(-1, 0, 0)))!;
  nearVector(pose.position, 0, 0, 0);
  nearVector(new Vector3(0, 0, 1).applyQuaternion(pose.quaternion), 1, 0, 0);
  // Both: moved, then turned while a modifier is held, from where it is
  const both = start(InteractionMode.MOVE_ROTATE_3D, new Vector3(1, 0, 0), new Vector3(0, 0, 1));
  nearVector(both.move(down(2, 0))!.position, 2, 0, 0);
  const turned = both.move(new Ray(new Vector3(10, 0, 0), new Vector3(-1, 0, 0)), true)!;
  nearVector(turned.position, 2, 0, 0);
  nearVector(new Vector3(0, 0, 1).applyQuaternion(turned.quaternion), 1, 0, 0);
});

test("a control's frame: the marker's, the frame's, or facing the view", () => {
  const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  const alongY = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  const view = { direction: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1) };
  // Inherited: the marker's turn, then the control's own
  nearVector(controlAxis(controlFrame(OrientationMode.INHERIT, turned, alongY, view), alongY), -1, 0, 0);
  // Fixed: the control's own only
  nearVector(controlAxis(controlFrame(OrientationMode.FIXED, turned, alongY, view), alongY), 0, 1, 0);
  // Facing the view: x where the camera looks, z up
  const facing = controlFrame(OrientationMode.VIEW_FACING, turned, new Quaternion(), view);
  nearVector(controlAxis(facing, new Quaternion()), 0, 1, 0);
  nearVector(new Vector3(0, 0, 1).applyQuaternion(facing), 0, 0, 1);
  // From above (2D): z is the view's up, ROS's y
  const above = viewFacing(new Quaternion(), new Vector3(0, 0, -1), new Vector3(0, 1, 0));
  nearVector(new Vector3(1, 0, 0).applyQuaternion(above), 0, 0, -1);
  nearVector(new Vector3(0, 0, 1).applyQuaternion(above), 0, 1, 0);
});
