// A set of poses (geometry_msgs/PoseArray, or nav2_msgs/ParticleCloud: AMCL's
// particles, with their weights), where TF puts its frame: an arrow along each
// pose's x, as RViz's Pose Array and Particle Cloud displays draw them. A
// particle's arrow is longer the heavier it is (to the heaviest's length).

import { Group, Quaternion, Vector3 } from 'three';

import { Display, type DisplayContext } from '../display.ts';
import type { PoseArrayDisplayConfig } from './index.ts';
import { LinesLayer } from './lines.ts';
import { PARTICLE_CLOUD, POSE_ARRAY, posesOf, type PoseArrayMessage } from './pose_array.ts';

export { PARTICLE_CLOUD, POSE_ARRAY } from './pose_array.ts';

// Of an arrow's length: its head's, and its head's half width
const HEAD = 0.3;
const HEAD_WIDTH = 0.15;

export class PoseArrayDisplay extends Display<PoseArrayDisplayConfig> {
  // Where TF puts the poses' frame
  protected readonly holder = new Group();
  protected readonly arrows = new LinesLayer();
  private config: PoseArrayDisplayConfig | null = null;
  // x, y, z, qx, qy, qz, qw, length factor of each pose, in their frame
  private poses: number[] = [];
  private unsubscribe: (() => void) | null = null;
  private frameId = '';

  constructor(context: DisplayContext) {
    super(context);
    this.holder.add(this.arrows.object);
    this.root.add(this.holder);
  }

  configure(config: PoseArrayDisplayConfig, previous: PoseArrayDisplayConfig | null): void {
    this.config = config;
    this.arrows.setStyle({ color: config.color, width: config.width, opacity: config.alpha });
    if (config.topic !== previous?.topic || config.maxRate !== previous?.maxRate) {
      this.subscribe(config.topic.trim(), config.maxRate);
    } else {
      this.draw();
    }
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  private subscribe(topic: string, maxRate: number): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frameId = '';
    this.poses = [];
    this.arrows.setSegments([]);
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    this.unsubscribe = this.subscribeTopic<PoseArrayMessage>(
      topic,
      { types: [POSE_ARRAY, PARTICLE_CLOUD], maxRate: Math.max(0.1, maxRate) },
      (message, type) => {
        const config = this.config;
        this.poses = posesOf(message, type, config?.maxPoses ?? 5000, config?.lengthByWeight ?? true);
        this.draw();
        if (message.header.frame_id && message.header.frame_id !== this.frameId) {
          this.frameId = message.header.frame_id;
          this.attach(this.holder, this.frameId);
        }
        this.setStatus('ok');
        this.updateStatus();
        this.render();
      },
    );
  }

  private draw(): void {
    const length = this.config?.arrowLength ?? 0.3;
    const segments: number[] = [];
    const position = new Vector3();
    const quaternion = new Quaternion();
    const axis = new Vector3();
    const side = new Vector3();
    const tip = new Vector3();
    const p = this.poses;
    for (let i = 0; i + 7 < p.length; i += 8) {
      const size = length * p[i + 7];
      position.set(p[i], p[i + 1], p[i + 2]);
      // An empty orientation (all zeros), as the identity
      if (Math.hypot(p[i + 3], p[i + 4], p[i + 5], p[i + 6]) < 1e-9) {
        quaternion.identity();
      } else {
        quaternion.set(p[i + 3], p[i + 4], p[i + 5], p[i + 6]).normalize();
      }
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
    this.arrows.setSegments(segments);
  }

  private updateStatus(): void {
    if (!this.frameId) {
      return;
    }
    if (this.pose(this.frameId)) {
      this.setStatus('ok');
    } else {
      this.setStatus('warn', this.missingFrame(this.frameId));
    }
  }
}
