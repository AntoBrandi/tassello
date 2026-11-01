// A pose (geometry_msgs/PoseStamped, or the pose of a
// PoseWithCovarianceStamped, e.g. AMCL's), where TF puts its frame: an arrow
// along its x, or its axes, as RViz's Pose display draws it.

import { Group, MeshLambertMaterial, SRGBColorSpace, type Object3D } from 'three';

import { Display, type DisplayContext } from '../display.ts';
import { parseColor } from '../model.ts';
import type { PoseDisplayConfig } from './index.ts';
import { disposeObject } from './urdf.ts';
import { arrowObject, axesObject, setOpacity } from './shapes.ts';

export const POSE_STAMPED = 'geometry_msgs/msg/PoseStamped';
export const POSE_WITH_COVARIANCE_STAMPED = 'geometry_msgs/msg/PoseWithCovarianceStamped';

interface PoseValue {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

interface PoseMessage {
  header: { frame_id: string };
  // A PoseWithCovarianceStamped's: { pose, covariance }
  pose: PoseValue & { pose?: PoseValue };
}

function shapeKey(config: PoseDisplayConfig): string {
  return config.shape === 'axes'
    ? `axes ${config.axesLength} ${config.axesRadius} ${config.alpha}`
    : `arrow ${config.shaftLength} ${config.shaftRadius} ${config.headLength} ${config.headRadius}`;
}

export class PoseDisplay extends Display<PoseDisplayConfig> {
  // Where TF puts the pose's frame; the shape, in it, at the pose
  protected readonly holder = new Group();
  protected readonly marker = new Group();
  protected readonly material = new MeshLambertMaterial();
  private shape: Object3D | null = null;
  private shapeKey = '';
  private unsubscribe: (() => void) | null = null;
  private frameId = '';

  constructor(context: DisplayContext) {
    super(context);
    this.marker.visible = false;
    this.holder.add(this.marker);
    this.root.add(this.holder);
  }

  configure(config: PoseDisplayConfig, previous: PoseDisplayConfig | null): void {
    this.material.color.setRGB(...parseColor(config.color), SRGBColorSpace);
    setOpacity(this.material, config.alpha);
    const key = shapeKey(config);
    if (key !== this.shapeKey) {
      this.shapeKey = key;
      this.setShape(
        config.shape === 'axes'
          ? axesObject(Math.max(1e-3, config.axesLength), Math.max(1e-4, config.axesRadius), config.alpha)
          : arrowObject(config, this.material),
      );
    }
    if (config.topic !== previous?.topic) {
      this.subscribe(config.topic.trim());
    }
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  dispose(): void {
    this.material.dispose();
  }

  private setShape(shape: Object3D): void {
    if (this.shape) {
      this.shape.removeFromParent();
      disposeObject(this.shape, new Set([this.material]));
    }
    this.shape = shape;
    this.marker.add(shape);
  }

  private subscribe(topic: string): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frameId = '';
    this.marker.visible = false;
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    this.unsubscribe = this.subscribeTopic<PoseMessage>(
      topic,
      { types: [POSE_STAMPED, POSE_WITH_COVARIANCE_STAMPED] },
      (message, type) => {
        const pose = type === POSE_WITH_COVARIANCE_STAMPED ? message.pose.pose : message.pose;
        const p = pose?.position;
        const q = pose?.orientation;
        const values = p && q ? [p.x, p.y, p.z, q.x, q.y, q.z, q.w] : [NaN];
        if (!values.every(Number.isFinite)) {
          this.marker.visible = false;
          this.setStatus('error', 'Its pose is not a number');
          this.render();
          return;
        }
        this.marker.position.set(p!.x, p!.y, p!.z);
        // An empty orientation (all zeros), as the identity
        if (Math.hypot(q!.x, q!.y, q!.z, q!.w) < 1e-9) {
          this.marker.quaternion.identity();
        } else {
          this.marker.quaternion.set(q!.x, q!.y, q!.z, q!.w).normalize();
        }
        this.marker.visible = true;
        if (message.header.frame_id !== this.frameId) {
          this.frameId = message.header.frame_id;
          this.attach(this.holder, this.frameId);
        }
        this.updateStatus();
        this.render();
      },
    );
  }

  private updateStatus(): void {
    if (!this.frameId || !this.marker.visible) {
      return;
    }
    if (this.pose(this.frameId)) {
      this.setStatus('ok');
    } else {
      this.setStatus('warn', this.missingFrame(this.frameId));
    }
  }
}
