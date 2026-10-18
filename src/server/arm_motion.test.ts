import assert from 'node:assert/strict';
import { test } from 'node:test';

import { urdfJoints } from '../shared/urdf.ts';
import { clampCommand, controllerNamespace, duration } from './arm_motion.ts';
import { dampedLeastSquares, Kinematics } from './kinematics.ts';

const URDF = `<?xml version="1.0"?>
<robot name="r">
  <!-- <joint name="commented" type="revolute"><limit lower="-9" upper="9"/></joint> -->
  <joint name="base_joint" type="fixed"><parent link="a"/><child link="b"/></joint>
  <joint name="wheel" type="continuous"><limit effort="1" velocity="2"/></joint>
  <joint name="joint_1" type="revolute">
    <parent link="b"/><child link="c"/>
    <limit effort="30.0" lower="-1.1686" upper="4.1788" velocity="1.0"/>
  </joint>
  <joint name='slide' type='prismatic'><limit lower='0' upper='0.2'/></joint>
  <transmission name="t"><joint name="joint_1"><hardwareInterface>x</hardwareInterface></joint></transmission>
  <ros2_control name="RobotSystem" type="system">
    <joint name="joint_1"><command_interface name="position"/></joint>
  </ros2_control>
</robot>`;

test('urdfJoints reads the joints of the robot, not of transmissions or ros2_control', () => {
  const joints = urdfJoints(URDF);
  assert.deepEqual([...joints.keys()], ['base_joint', 'wheel', 'joint_1', 'slide']);
  assert.deepEqual(joints.get('joint_1'), {
    name: 'joint_1',
    type: 'revolute',
    lower: -1.1686,
    upper: 4.1788,
    parent: 'b',
    child: 'c',
    // Defaults: no origin, x axis
    xyz: [0, 0, 0],
    rpy: [0, 0, 0],
    axis: [1, 0, 0],
  });
  const slide = joints.get('slide');
  assert.deepEqual([slide?.type, slide?.lower, slide?.upper], ['prismatic', 0, 0.2]);
  // Continuous joints have no position limits, whatever their limit says
  assert.equal(joints.get('wheel')?.lower, null);
});

test('clampCommand keeps the command within the range', () => {
  const range = { lower: -1, upper: 1 };
  assert.deepEqual(clampCommand(1.02, 0.99, 0.99, range, 0.5), { value: 1, limit: 'upper' });
  assert.deepEqual(clampCommand(-1.2, -0.95, -0.95, range, 0.5), { value: -1, limit: 'lower' });
  assert.deepEqual(clampCommand(0.5, 0.48, 0.48, range, 0.5), { value: 0.5, limit: null });
});

test('clampCommand lets a command out of the range only come back in', () => {
  const range = { lower: -1, upper: 1 };
  // Further out: held where it is
  assert.deepEqual(clampCommand(1.6, 1.5, 1.5, range, 0.5), { value: 1.5, limit: 'upper' });
  // Back in: free
  assert.deepEqual(clampCommand(1.45, 1.5, 1.5, range, 0.5), { value: 1.45, limit: null });
});

test('clampCommand never runs far ahead of a joint that does not follow', () => {
  const free = { lower: null, upper: null };
  assert.equal(clampCommand(2, 1.9, 0, free, 0.3).value, 0.3);
  assert.equal(clampCommand(-2, -1.9, 0, free, 0.3).value, -0.3);
});

test('duration and controllerNamespace', () => {
  assert.deepEqual(duration(1.25), { sec: 1, nanosec: 250000000 });
  assert.equal(controllerNamespace('arm_controller'), '/arm_controller');
  assert.equal(controllerNamespace('/ns/arm_controller/'), '/ns/arm_controller');
});

// Two links of 1 m turning about z, from the origin along x
const PLANAR = `<robot name="planar">
  <joint name="j1" type="revolute"><parent link="base"/><child link="l1"/>
    <origin xyz="0 0 0" rpy="0 0 0"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint>
  <joint name="j2" type="revolute"><parent link="l1"/><child link="l2"/>
    <origin xyz="1 0 0" rpy="0 0 0"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint>
  <joint name="tip_joint" type="fixed"><parent link="l2"/><child link="tip"/>
    <origin xyz="1 0 0" rpy="0 0 0"/></joint>
</robot>`;

function near(actual: number[], expected: number[], tolerance = 1e-6) {
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < tolerance, `${actual} != ${expected}`));
}

test('Kinematics places a link from its chain of joints', () => {
  const kinematics = new Kinematics(urdfJoints(PLANAR));
  assert.deepEqual(
    kinematics.chain('tip').map((j) => j.name),
    ['j1', 'j2', 'tip_joint'],
  );
  near(kinematics.position('tip', 'base', new Map()), [2, 0, 0]);
  near(kinematics.position('tip', 'base', new Map([['j1', Math.PI / 2]])), [0, 2, 0]);
  near(kinematics.position('tip', 'base', new Map([['j2', Math.PI / 2]])), [1, 1, 0]);
  // In the frame of the first link, the first joint does not move the tip
  near(
    kinematics.position(
      'tip',
      'l1',
      new Map([
        ['j1', 1],
        ['j2', Math.PI / 2],
      ]),
    ),
    [1, 1, 0],
  );
  // URDF rpy: a link rotated by yaw
  const yawed = urdfJoints(
    PLANAR.replace('<origin xyz="1 0 0" rpy="0 0 0"/><axis', '<origin xyz="1 0 0" rpy="0 0 1.5707963267948966"/><axis'),
  );
  near(new Kinematics(yawed).position('tip', 'base', new Map()), [1, 1, 0]);
});

test('dampedLeastSquares moves the tip where asked, with the least motion', () => {
  const kinematics = new Kinematics(urdfJoints(PLANAR));
  const positions = new Map([
    ['j1', 0.3],
    ['j2', 0.8],
  ]);
  const start = kinematics.position('tip', 'base', positions);
  const error: [number, number, number] = [0.001, -0.002, 0];
  const dq = dampedLeastSquares(kinematics.jacobian('tip', 'base', positions, ['j1', 'j2']), error, 0.001);
  const moved = kinematics.position(
    'tip',
    'base',
    new Map([
      ['j1', 0.3 + dq[0]],
      ['j2', 0.8 + dq[1]],
    ]),
  );
  near(moved, [start[0] + 0.001, start[1] - 0.002, 0], 1e-5);
  // Stretched out (singular), it slows down instead of jumping
  const straight = new Map([
    ['j1', 0],
    ['j2', 0],
  ]);
  const out = dampedLeastSquares(kinematics.jacobian('tip', 'base', straight, ['j1', 'j2']), [0.01, 0, 0], 0.01);
  assert.ok(Math.hypot(...out) < 0.01, `${out}`);
});
