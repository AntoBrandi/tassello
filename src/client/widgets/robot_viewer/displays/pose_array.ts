// The poses a Pose Array display draws, of a geometry_msgs/PoseArray or a
// nav2_msgs/ParticleCloud (AMCL's particles, with their weights): without
// three.js, to be tested alone.

export const POSE_ARRAY = 'geometry_msgs/msg/PoseArray';
export const PARTICLE_CLOUD = 'nav2_msgs/msg/ParticleCloud';

// The lightest particle's arrow, of the heaviest's
const MIN_WEIGHT_LENGTH = 0.3;

interface PoseValue {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

export interface PoseArrayMessage {
  header: { frame_id: string };
  poses?: PoseValue[];
  particles?: { pose: PoseValue; weight: number }[];
}

// x, y, z, qx, qy, qz, qw and a length factor (0-1) of each pose, at most max
// of them (evenly through the message); none that is not a number
export function posesOf(message: PoseArrayMessage, messageType: string, max: number, byWeight: boolean): number[] {
  const items =
    messageType === PARTICLE_CLOUD
      ? (message.particles ?? []).map((p) => ({ pose: p.pose, weight: p.weight }))
      : (message.poses ?? []).map((pose) => ({ pose, weight: 1 }));
  const step = Math.max(1, Math.ceil(items.length / Math.max(1, max)));
  const heaviest = items.reduce((m, i) => (Number.isFinite(i.weight) && i.weight > m ? i.weight : m), 0);
  const out: number[] = [];
  for (let k = 0; k < items.length; k += step) {
    const { pose, weight } = items[k];
    const p = pose?.position;
    const q = pose?.orientation;
    if (!p || !q) {
      continue;
    }
    const values = [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
    if (!values.every(Number.isFinite)) {
      continue;
    }
    const share = byWeight && messageType === PARTICLE_CLOUD && heaviest > 0 ? Math.max(0, weight) / heaviest : 1;
    out.push(...values, MIN_WEIGHT_LENGTH + (1 - MIN_WEIGHT_LENGTH) * share);
  }
  return out;
}
