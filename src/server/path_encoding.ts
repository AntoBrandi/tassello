// nav_msgs/Path messages, as the navigation widgets draw them

import type { PathUpdate } from '../shared/protocol.ts';

// Longer paths are thinned out: a page draws them, it does not follow them
const MAX_POINTS = 5000;

export type PathData = Omit<PathUpdate, 'type' | 'id'>;

export interface PathMessage {
  header: { frame_id: string };
  poses: { pose: { position: { x: number; y: number } } }[];
}

// Millimeters are enough, and keep the JSON short
const round = (value: number) => Math.round(value * 1000) / 1000;

export function toPathData(msg: PathMessage): PathData {
  const step = Math.ceil(msg.poses.length / MAX_POINTS);
  const points: number[] = [];
  for (let i = 0; i < msg.poses.length; i += step) {
    const { x, y } = msg.poses[i].pose.position;
    points.push(round(x), round(y));
  }
  // The end of the path, where the robot is going, always
  const last = msg.poses.at(-1);
  if (last && (msg.poses.length - 1) % step !== 0) {
    points.push(round(last.pose.position.x), round(last.pose.position.y));
  }
  return { frameId: msg.header.frame_id.replace(/^\//, ''), points };
}
