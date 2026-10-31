// nav_msgs/Path messages, as the navigation widgets draw them (points in 2D),
// or as the Robot Viewer does (poses in 3D)

import type { PathUpdate } from '../shared/protocol.ts';

// Longer paths are thinned out: a page draws them, it does not follow them
const MAX_POINTS = 5000;

export type PathData = Omit<PathUpdate, 'type' | 'id'>;

interface Vector {
  x: number;
  y: number;
  z?: number;
}

export interface PathMessage {
  header: { frame_id: string };
  poses: { pose: { position: Vector; orientation?: Vector & { w: number } } }[];
}

// Millimeters are enough, and keep the JSON short
const round = (value: number) => Math.round(value * 1000) / 1000;
const roundUnit = (value: number) => Math.round(value * 10000) / 10000;

// The indices of the poses kept: evenly, at most MAX_POINTS, and the end of
// the path, where the robot is going, always
function kept(count: number): number[] {
  const step = Math.ceil(count / MAX_POINTS);
  const indices: number[] = [];
  for (let i = 0; i < count; i += step) {
    indices.push(i);
  }
  if (count > 0 && (count - 1) % step !== 0) {
    indices.push(count - 1);
  }
  return indices;
}

function frameOf(msg: PathMessage): string {
  return msg.header.frame_id.replace(/^\//, '');
}

export function toPathData(msg: PathMessage): PathData {
  const points: number[] = [];
  for (const i of kept(msg.poses.length)) {
    const { x, y } = msg.poses[i].pose.position;
    points.push(round(x), round(y));
  }
  return { frameId: frameOf(msg), points };
}

export function toPathPoses(msg: PathMessage): PathData {
  const poses: number[] = [];
  for (const i of kept(msg.poses.length)) {
    const { position, orientation } = msg.poses[i].pose;
    poses.push(round(position.x), round(position.y), round(position.z ?? 0));
    if (orientation) {
      poses.push(roundUnit(orientation.x), roundUnit(orientation.y), roundUnit(orientation.z ?? 0), roundUnit(orientation.w));
    } else {
      poses.push(0, 0, 0, 1);
    }
  }
  return { frameId: frameOf(msg), points: [], poses };
}
