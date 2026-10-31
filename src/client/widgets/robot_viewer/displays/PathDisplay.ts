// A path (nav_msgs/Path), e.g. Nav2's plan, where TF puts its frame: a line
// through its poses, thinned on the robot, and their orientations as arrows
// or axes if asked for.

import { Group, Quaternion, Vector3 } from 'three';

import { Display, type DisplayContext } from '../display.ts';
import type { PathDisplayConfig } from './index.ts';
import { LinesLayer } from './lines.ts';

// Of an arrow's length: its head's, and its head's half width
const HEAD = 0.3;
const HEAD_WIDTH = 0.15;
// x red, y green, z blue, as the TF display's axes
const AXES_COLORS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export class PathDisplay extends Display<PathDisplayConfig> {
  // Where TF puts the path's frame
  protected readonly holder = new Group();
  protected readonly line = new LinesLayer();
  protected readonly markers = new LinesLayer();
  private config: PathDisplayConfig | null = null;
  // x, y, z, qx, qy, qz, qw of each pose, in the path's frame
  private poses: number[] = [];
  private unsubscribe: (() => void) | null = null;
  private frameId = '';

  constructor(context: DisplayContext) {
    super(context);
    this.holder.add(this.line.object, this.markers.object);
    this.root.add(this.holder);
  }

  configure(config: PathDisplayConfig, previous: PathDisplayConfig | null): void {
    this.config = config;
    this.line.setStyle({ color: config.color, width: config.width, opacity: config.alpha });
    this.markers.setStyle({ color: config.color, width: Math.max(1, config.width * 0.75), opacity: config.alpha });
    if (config.topic !== previous?.topic) {
      this.subscribe(config.topic.trim());
    } else if (config.poseStyle !== previous.poseStyle || config.poseSize !== previous.poseSize) {
      this.drawMarkers();
    }
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  private subscribe(topic: string): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frameId = '';
    this.poses = [];
    this.line.setSegments([]);
    this.markers.setSegments([]);
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    let current = true;
    const unsubscribe = this.connection.subscribePath({ topic, poses: true }, (update) => {
      if (!current) {
        return;
      }
      this.poses = update.poses ?? [];
      const positions: number[] = [];
      for (let i = 0; i + 6 < this.poses.length; i += 7) {
        positions.push(this.poses[i], this.poses[i + 1], this.poses[i + 2]);
      }
      this.line.setPolyline(positions);
      this.drawMarkers();
      // An empty path, e.g. once the goal is reached, may have no frame
      if (update.frameId && update.frameId !== this.frameId) {
        this.frameId = update.frameId;
        this.attach(this.holder, this.frameId);
      }
      this.setStatus('ok');
      this.updateStatus();
      this.render();
    });
    this.unsubscribe = this.context.track(() => {
      current = false;
      unsubscribe();
    });
  }

  private drawMarkers(): void {
    const style = this.config?.poseStyle ?? 'none';
    const size = this.config?.poseSize ?? 0.1;
    if (style === 'none' || this.poses.length === 0) {
      this.markers.setSegments([]);
      return;
    }
    const segments: number[] = [];
    const colors: number[] = [];
    const position = new Vector3();
    const quaternion = new Quaternion();
    const axis = new Vector3();
    const side = new Vector3();
    const tip = new Vector3();
    const p = this.poses;
    for (let i = 0; i + 6 < p.length; i += 7) {
      position.set(p[i], p[i + 1], p[i + 2]);
      quaternion.set(p[i + 3], p[i + 4], p[i + 5], p[i + 6]).normalize();
      if (style === 'axes') {
        for (let a = 0; a < 3; a++) {
          axis.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(quaternion);
          segments.push(position.x, position.y, position.z);
          segments.push(position.x + axis.x * size, position.y + axis.y * size, position.z + axis.z * size);
          colors.push(...AXES_COLORS[a], ...AXES_COLORS[a]);
        }
      } else {
        // A shaft along x, and a head's two strokes back from its tip
        axis.set(1, 0, 0).applyQuaternion(quaternion);
        side.set(0, 1, 0).applyQuaternion(quaternion);
        tip.copy(position).addScaledVector(axis, size);
        segments.push(position.x, position.y, position.z, tip.x, tip.y, tip.z);
        for (const sign of [1, -1]) {
          segments.push(
            tip.x,
            tip.y,
            tip.z,
            tip.x - axis.x * size * HEAD + side.x * size * HEAD_WIDTH * sign,
            tip.y - axis.y * size * HEAD + side.y * size * HEAD_WIDTH * sign,
            tip.z - axis.z * size * HEAD + side.z * size * HEAD_WIDTH * sign,
          );
        }
      }
    }
    this.markers.setSegments(segments, style === 'axes' ? colors : null);
  }

  private updateStatus(): void {
    if (!this.frameId || this.poses.length === 0) {
      return;
    }
    if (this.pose(this.frameId)) {
      this.setStatus('ok');
    } else {
      this.setStatus('warn', this.missingFrame(this.frameId));
    }
  }
}
