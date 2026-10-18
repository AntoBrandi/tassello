// Where the links of a URDF are, for the arm teleop's Cartesian jogs: they move
// a link's origin along a frame's axes by damped least squares on the
// position Jacobian, as MoveIt Servo does: the least joint motion that does
// it, slowing down near singularities instead of jumping. Orientation is
// left free, which arms of 5 joints cannot keep.

import type { UrdfJoint, Vector3 } from '../shared/urdf.ts';

// Row major
type Matrix3 = [number, number, number, number, number, number, number, number, number];

interface Pose {
  r: Matrix3;
  p: Vector3;
}

const IDENTITY: Pose = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: [0, 0, 0] };
// Finite difference of the Jacobian, rad or m
const JACOBIAN_STEP = 1e-6;

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const m = new Array(9).fill(0) as Matrix3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
    }
  }
  return m;
}

function apply(r: Matrix3, v: Vector3): Vector3 {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
}

function transpose(r: Matrix3): Matrix3 {
  return [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
}

function compose(a: Pose, b: Pose): Pose {
  const p = apply(a.r, b.p);
  return { r: multiply(a.r, b.r), p: [a.p[0] + p[0], a.p[1] + p[1], a.p[2] + p[2]] };
}

// URDF's fixed axis roll, pitch, yaw: Rz(yaw) Ry(pitch) Rx(roll)
function fromRpy([roll, pitch, yaw]: Vector3): Matrix3 {
  const [cr, sr, cp, sp, cy, sy] = [
    Math.cos(roll),
    Math.sin(roll),
    Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw),
    Math.sin(yaw),
  ];
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ];
}

// Rodrigues: a turn of angle about a unit axis
function fromAxisAngle(axis: Vector3, angle: number): Matrix3 {
  const length = Math.hypot(...axis) || 1;
  const [x, y, z] = axis.map((v) => v / length);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

// The child's frame in the parent's, with the joint at that position
function jointPose(joint: UrdfJoint, position: number): Pose {
  const origin: Pose = { r: fromRpy(joint.rpy), p: joint.xyz };
  if (joint.type === 'revolute' || joint.type === 'continuous') {
    return compose(origin, { r: fromAxisAngle(joint.axis, position), p: [0, 0, 0] });
  }
  if (joint.type === 'prismatic') {
    const length = Math.hypot(...joint.axis) || 1;
    return compose(origin, { r: IDENTITY.r, p: joint.axis.map((v) => (v / length) * position) as Vector3 });
  }
  return origin;
}

export class Kinematics {
  // By child link
  private readonly parents = new Map<string, UrdfJoint>();

  constructor(joints: Map<string, UrdfJoint>) {
    for (const joint of joints.values()) {
      if (joint.child) {
        this.parents.set(joint.child, joint);
      }
    }
  }

  // The joints from the root of the tree down to the link
  chain(link: string): UrdfJoint[] {
    const chain: UrdfJoint[] = [];
    const seen = new Set<string>();
    for (let joint = this.parents.get(link); joint && !seen.has(joint.child); joint = this.parents.get(joint.parent)) {
      seen.add(joint.child);
      chain.unshift(joint);
    }
    return chain;
  }

  hasLink(link: string): boolean {
    return this.parents.has(link) || [...this.parents.values()].some((j) => j.parent === link);
  }

  // The link's origin in the frame of another link, the joints at the
  // positions given (0 if not)
  position(link: string, frame: string, positions: ReadonlyMap<string, number>): Vector3 {
    const pose = (name: string) =>
      this.chain(name).reduce(
        (pose, joint) => compose(pose, jointPose(joint, positions.get(joint.name) ?? 0)),
        IDENTITY,
      );
    const base = pose(frame);
    const target = pose(link).p;
    return apply(transpose(base.r), [target[0] - base.p[0], target[1] - base.p[1], target[2] - base.p[2]]);
  }

  // d position / d joint, one column per joint
  jacobian(link: string, frame: string, positions: ReadonlyMap<string, number>, joints: string[]): Vector3[] {
    const at = this.position(link, frame, positions);
    return joints.map((name) => {
      const moved = new Map(positions).set(name, (positions.get(name) ?? 0) + JACOBIAN_STEP);
      const p = this.position(link, frame, moved);
      return [0, 1, 2].map((i) => (p[i] - at[i]) / JACOBIAN_STEP) as Vector3;
    });
  }
}

// The joint motion dq that moves the position by error, damped least
// squares: dq = J^T (J J^T + damping^2 I)^-1 error
export function dampedLeastSquares(columns: Vector3[], error: Vector3, damping: number): number[] {
  const a: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of columns) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        a[3 * i + j] += c[i] * c[j];
      }
    }
  }
  a[0] += damping * damping;
  a[4] += damping * damping;
  a[8] += damping * damping;
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const inverse: Matrix3 = [
    (a[4] * a[8] - a[5] * a[7]) / det,
    (a[2] * a[7] - a[1] * a[8]) / det,
    (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det,
    (a[0] * a[8] - a[2] * a[6]) / det,
    (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det,
    (a[1] * a[6] - a[0] * a[7]) / det,
    (a[0] * a[4] - a[1] * a[3]) / det,
  ];
  const y = apply(inverse, error);
  return columns.map((c) => c[0] * y[0] + c[1] * y[1] + c[2] * y[2]);
}
