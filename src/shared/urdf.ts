// The joints of a URDF, as robot_state_publisher publishes it: their type,
// limits and kinematics. Read with regular expressions, which the URDF xacro
// generates allows: no DOM on the server.

export type Vector3 = [number, number, number];

export interface UrdfJoint {
  name: string;
  // revolute, continuous, prismatic, fixed, ...
  type: string;
  // Position limits, null when it has none (continuous joints)
  lower: number | null;
  upper: number | null;
  parent: string;
  child: string;
  // The child's frame in the parent's at position 0
  xyz: Vector3;
  rpy: Vector3;
  // The axis it turns about or slides along, in the child's frame
  axis: Vector3;
}

const COMMENT = /<!--[\s\S]*?-->/g;
// A joint element, empty or not. The <joint> of <transmission> and
// <ros2_control> have no type, unlike the robot's.
const JOINT = /<joint\b([^>]*?)(?:\/>|>([\s\S]*?)<\/joint\s*>)/g;
const LIMIT = /<limit\b([^>]*?)\/?>/;
const ORIGIN = /<origin\b([^>]*?)\/?>/;
const AXIS = /<axis\b([^>]*?)\/?>/;
const PARENT = /<parent\b([^>]*?)\/?>/;
const CHILD = /<child\b([^>]*?)\/?>/;
const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    result[match[1]] = match[2] ?? match[3];
  }
  return result;
}

function vector(value: string | undefined, fallback: Vector3): Vector3 {
  const parts = (value ?? '').trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as Vector3) : fallback;
}

function element(pattern: RegExp, body: string): Record<string, string> {
  const match = pattern.exec(body);
  return match ? attributes(match[1]) : {};
}

function number(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// By name, in document order
export function urdfJoints(urdf: string): Map<string, UrdfJoint> {
  const joints = new Map<string, UrdfJoint>();
  for (const match of urdf.replace(COMMENT, '').matchAll(JOINT)) {
    const { name, type } = attributes(match[1]);
    if (!name || !type) {
      continue;
    }
    const body = match[2] ?? '';
    const bounds = element(LIMIT, body);
    const origin = element(ORIGIN, body);
    const positional = type === 'revolute' || type === 'prismatic';
    joints.set(name, {
      name,
      type,
      lower: positional ? number(bounds.lower) : null,
      upper: positional ? number(bounds.upper) : null,
      parent: element(PARENT, body).link ?? '',
      child: element(CHILD, body).link ?? '',
      xyz: vector(origin.xyz, [0, 0, 0]),
      rpy: vector(origin.rpy, [0, 0, 0]),
      axis: vector(element(AXIS, body).xyz, [1, 0, 0]),
    });
  }
  return joints;
}
