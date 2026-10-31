// The TF frames, where TF puts them in the fixed frame: their axes (x red,
// y green, z blue) and names, as the Robot Model widget showed its links', and
// optionally a line from each frame to its parent, yellow at the frame, as
// RViz's arrows.

import { AxesHelper, BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments } from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import { Display, type DisplayContext } from '../display.ts';
import { frameFilter } from '../model.ts';
import type { TfDisplayConfig } from './index.ts';

const AT_FRAME = [1, 0.85, 0.1];
const AT_PARENT = [0.85, 0.25, 0.85];

interface FrameObjects {
  group: Group;
  axes: AxesHelper;
  label: CSS2DObject;
  size: number;
}

export class TfDisplay extends Display<TfDisplayConfig> {
  private config: TfDisplayConfig | null = null;
  private readonly objects = new Map<string, FrameObjects>();
  private readonly links = new LineSegments(
    new BufferGeometry(),
    // Over everything, as the axes: frames are mostly inside the robot
    new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }),
  );

  constructor(context: DisplayContext) {
    super(context);
    this.links.renderOrder = 9;
    this.root.add(this.links);
  }

  configure(config: TfDisplayConfig): void {
    this.config = config;
    this.update();
  }

  onTransforms(): void {
    this.update();
  }

  onFixedFrameChange(): void {
    this.update();
  }

  private update(): void {
    const config = this.config;
    if (!config) {
      return;
    }
    const show = frameFilter(config.filter);
    const size = config.scale > 0 ? config.scale : Math.min(0.25, Math.max(0.02, this.context.scale * 0.12));
    const seen = new Set<string>();
    const positions: number[] = [];
    const colors: number[] = [];
    for (const frame of this.context.frames.values()) {
      const pose = this.pose(frame.name);
      if (!pose || !show(frame.name)) {
        continue;
      }
      seen.add(frame.name);
      let objects = this.objects.get(frame.name);
      if (objects?.size !== size) {
        this.remove(frame.name);
        objects = this.create(frame.name, size);
      }
      objects.group.position.copy(pose.position);
      objects.group.quaternion.copy(pose.quaternion);
      objects.axes.visible = config.showAxes;
      objects.label.visible = config.showNames;
      const parent = config.showArrows && frame.parent ? this.pose(frame.parent) : null;
      if (parent) {
        positions.push(pose.position.x, pose.position.y, pose.position.z, parent.position.x, parent.position.y, parent.position.z);
        colors.push(...AT_FRAME, ...AT_PARENT);
      }
    }
    for (const name of [...this.objects.keys()]) {
      if (!seen.has(name)) {
        this.remove(name);
      }
    }
    const geometry = this.links.geometry;
    // The former lines' buffers freed now, not when collected
    geometry.dispose();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    this.links.visible = positions.length > 0;
    if (this.context.frames.size === 0) {
      this.setStatus('waiting', 'Waiting for TF frames');
    } else if (seen.size === 0 && this.fixedFrame) {
      this.setStatus('warn', `No frames in "${this.fixedFrame}"`);
    } else {
      this.setStatus('ok');
    }
    this.render();
  }

  private create(name: string, size: number): FrameObjects {
    const group = new Group();
    const axes = new AxesHelper(size);
    for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) {
      material.depthTest = false;
    }
    axes.renderOrder = 10;
    const element = document.createElement('div');
    element.className = 'robot-frame-label';
    element.textContent = name;
    const label = new CSS2DObject(element);
    // Up and right of the frame's origin
    label.center.set(-0.05, 1.1);
    group.add(axes, label);
    this.root.add(group);
    const objects = { group, axes, label, size };
    this.objects.set(name, objects);
    return objects;
  }

  private remove(name: string): void {
    const objects = this.objects.get(name);
    if (objects) {
      objects.group.removeFromParent();
      objects.axes.dispose();
      // Removed with its element only when itself removed from the scene
      objects.label.element.remove();
      this.objects.delete(name);
    }
  }
}
