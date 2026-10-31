// An octomap (octomap_msgs/Octomap, binary or full), e.g. octomap_server's,
// where TF puts its frame: its occupied voxels as cubes, decoded on the robot
// (the octomap stream), coloured by height, by their own colours (a
// ColorOcTree's full map) or in one colour.

import { BoxGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial } from 'three';

import type { OctomapFrame } from '../../../connection.ts';
import { Display, type DisplayContext } from '../display.ts';
import { parseColor, rainbow } from '../model.ts';
import type { OctomapDisplayConfig } from './index.ts';
import { toLinear } from './points.ts';

export class OctomapDisplay extends Display<OctomapDisplayConfig> {
  // Where TF puts the map's frame
  protected readonly holder = new Group();
  private readonly geometry = new BoxGeometry(1, 1, 1);
  private readonly material = new MeshLambertMaterial();
  private mesh: InstancedMesh | null = null;
  private config: OctomapDisplayConfig | null = null;
  private frame: OctomapFrame | null = null;
  private unsubscribe: (() => void) | null = null;
  private frameId = '';

  constructor(context: DisplayContext) {
    super(context);
    this.root.add(this.holder);
  }

  configure(config: OctomapDisplayConfig, previous: OctomapDisplayConfig | null): void {
    this.config = config;
    const transparent = config.alpha < 1;
    if (this.material.transparent !== transparent) {
      this.material.transparent = transparent;
      this.material.depthWrite = !transparent;
      this.material.needsUpdate = true;
    }
    this.material.opacity = config.alpha;
    if (
      !previous ||
      config.topic !== previous.topic ||
      config.maxDepth !== previous.maxDepth ||
      config.maxVoxels !== previous.maxVoxels ||
      config.maxRate !== previous.maxRate
    ) {
      this.subscribe(config);
    } else if (config.colorBy !== previous.colorBy || config.color !== previous.color) {
      this.recolor();
    }
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  private subscribe(config: OctomapDisplayConfig): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frameId = '';
    this.show(null);
    this.setNotes([]);
    const topic = config.topic.trim();
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    let current = true;
    const unsubscribe = this.connection.subscribeOctomap(
      {
        topic,
        maxDepth: Math.round(config.maxDepth),
        maxVoxels: Math.round(config.maxVoxels),
        maxFps: config.maxRate,
      },
      {
        status: (state, message) => {
          if (state !== 'streaming') {
            this.setStatus(state, message);
          }
        },
        voxels: (frame) => {
          if (!current) {
            return;
          }
          this.show(frame);
          const { count, source } = frame.info;
          this.setNotes(
            count < source ? [{ text: `Octomap: ${count} of its ${source} voxels, set a lower depth`, tone: 'info' }] : [],
          );
          if (frame.info.frameId !== this.frameId) {
            this.frameId = frame.info.frameId;
            this.attach(this.holder, this.frameId);
          }
          this.updateStatus();
          this.render();
        },
      },
    );
    this.unsubscribe = this.context.track(() => {
      current = false;
      unsubscribe();
    });
  }

  // A mesh anew for each map: maps come seldom, their voxels change in number
  private show(frame: OctomapFrame | null): void {
    this.frame = frame;
    if (this.mesh) {
      this.mesh.removeFromParent();
      // Its instances' buffers; the box and the material are kept
      this.mesh.dispose();
      this.mesh = null;
    }
    if (!frame || frame.info.count === 0) {
      return;
    }
    const { count, levels } = frame.info;
    const mesh = new InstancedMesh(this.geometry, this.material, count);
    const matrix = new Matrix4();
    const p = frame.positions;
    let index = 0;
    for (const { size, count: levelCount } of levels) {
      for (let j = 0; j < levelCount && index < count; j++, index++) {
        matrix.makeScale(size, size, size);
        matrix.setPosition(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
        mesh.setMatrixAt(index, matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh = mesh;
    this.recolor();
    this.holder.add(mesh);
  }

  private recolor(): void {
    const mesh = this.mesh;
    const frame = this.frame;
    const config = this.config;
    if (!mesh?.instanceColor || !frame || !config) {
      return;
    }
    const colors = mesh.instanceColor.array as Float32Array;
    const count = frame.info.count;
    // Their own colours if asked for and they have them, else by height
    const mode =
      config.colorBy === 'auto' || config.colorBy === 'rgb' ? (frame.colors ? 'rgb' : 'height') : config.colorBy;
    if (mode === 'rgb' && frame.colors) {
      for (let i = 0; i < count * 3; i++) {
        colors[i] = toLinear(frame.colors[i] / 255);
      }
    } else if (mode === 'height') {
      // Of the map's frame, from its lowest voxel to its highest
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < count; i++) {
        low = Math.min(low, frame.positions[i * 3 + 2]);
        high = Math.max(high, frame.positions[i * 3 + 2]);
      }
      const span = high - low;
      const rgb: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        rainbow(span > 0 ? (frame.positions[i * 3 + 2] - low) / span : 0, rgb);
        colors[i * 3] = toLinear(rgb[0]);
        colors[i * 3 + 1] = toLinear(rgb[1]);
        colors[i * 3 + 2] = toLinear(rgb[2]);
      }
    } else {
      const [r, g, b] = parseColor(config.color).map(toLinear);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    }
    mesh.instanceColor.needsUpdate = true;
  }

  private updateStatus(): void {
    const frame = this.frame;
    if (!this.frameId && !frame) {
      return;
    }
    if (frame?.info.error) {
      this.setStatus('error', frame.info.error);
    } else if (this.frameId && !this.pose(this.frameId)) {
      this.setStatus('warn', this.missingFrame(this.frameId));
    } else {
      this.setStatus('ok');
    }
  }
}
