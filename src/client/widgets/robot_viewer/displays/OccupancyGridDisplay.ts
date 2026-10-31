// A map or a costmap (nav_msgs/OccupancyGrid) on the ground of its frame,
// where TF puts that frame: the grid stream's image (coloured on the robot, as
// the Navigation widget's, unknown cells transparent), kept up to date by its
// <topic>_updates.

import {
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
} from 'three';

import type { GridInfo } from '../../../../shared/protocol.ts';
import { Display, type DisplayContext } from '../display.ts';
import type { GridDisplayConfig } from './index.ts';

// Images a second: maps change rarely, costmaps a few times a second
const RATES = { map: 1, costmap: 2 };

export class OccupancyGridDisplay extends Display<GridDisplayConfig> {
  // Where TF puts the grid's frame
  private readonly holder = new Group();
  private readonly material = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  private readonly mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
  private unsubscribe: (() => void) | null = null;
  private frameId = '';
  private bitmap: ImageBitmap | null = null;

  constructor(context: DisplayContext) {
    super(context);
    this.mesh.visible = false;
    this.holder.add(this.mesh);
    this.root.add(this.holder);
  }

  configure(config: GridDisplayConfig, previous: GridDisplayConfig | null): void {
    this.material.opacity = config.alpha;
    // Under what is drawn on them, costmaps over maps: first of the
    // transparent objects, which are drawn in this order
    this.mesh.renderOrder = config.style === 'costmap' ? -1 : -2;
    if (config.topic !== previous?.topic || config.style !== previous?.style) {
      this.subscribe(config);
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
    this.bitmap?.close();
  }

  private subscribe(config: GridDisplayConfig): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.mesh.visible = false;
    this.frameId = '';
    this.render();
    const topic = config.topic.trim();
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    let current = true;
    const unsubscribe = this.connection.subscribeGrid(
      { topic, style: config.style, maxFps: RATES[config.style] },
      {
        status: (state, message) => {
          if (state !== 'streaming') {
            this.setStatus(state, message);
          }
        },
        frame: async (file, { meta }) => {
          const bitmap = await createImageBitmap(file);
          if (!current) {
            bitmap.close();
            return;
          }
          this.show(bitmap, meta as GridInfo);
        },
      },
    );
    this.unsubscribe = this.context.track(() => {
      current = false;
      unsubscribe();
    });
  }

  private show(bitmap: ImageBitmap, info: GridInfo): void {
    const previous = this.material.map;
    const texture = new Texture(bitmap);
    // An ImageBitmap is not flipped: its first row, the grid's first (at the
    // origin's side), is the plane's bottom edge
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    // The cells crisp when zoomed in
    texture.magFilter = NearestFilter;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.material.map = texture;
    this.material.needsUpdate = previous === null;
    previous?.dispose();
    this.bitmap?.close();
    this.bitmap = bitmap;

    const width = info.width * info.resolution;
    const height = info.height * info.resolution;
    const cos = Math.cos(info.originYaw);
    const sin = Math.sin(info.originYaw);
    this.mesh.scale.set(width, height, 1);
    // Its centre: from the origin, the corner of cell 0, along the grid's axes
    this.mesh.position.set(
      info.originX + (cos * width) / 2 - (sin * height) / 2,
      info.originY + (sin * width) / 2 + (cos * height) / 2,
      0,
    );
    this.mesh.rotation.set(0, 0, info.originYaw);
    this.mesh.visible = true;
    if (info.frameId !== this.frameId) {
      this.frameId = info.frameId;
      this.attach(this.holder, info.frameId);
    }
    this.updateStatus();
    this.render();
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
