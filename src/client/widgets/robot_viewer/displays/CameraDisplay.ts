// A camera's images in the 3D view: raw (sensor_msgs/Image, compressed to
// JPEG on the robot) or compressed (sensor_msgs/CompressedImage, passed
// through), on a plane in front of the camera, where TF puts the images'
// frame, as the camera sees it: sized by its camera info at a distance, with
// the edges of its frustum.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
} from 'three';

import type { ImageInfo } from '../../../../shared/protocol.ts';
import { Display, type DisplayContext } from '../display.ts';
import { cameraInfoTopic, imageCorners, intrinsicsFromFov, intrinsicsOf, type Intrinsics } from '../model.ts';
import type { CameraDisplayConfig } from './index.ts';
import { LinesLayer } from './lines.ts';

const CAMERA_INFO = 'sensor_msgs/msg/CameraInfo';
// The optical frame's axes (z forward, x right, y down) in a body frame's (x
// forward, y left, z up): a camera_link's
const OPTICAL_IN_BODY = new Euler(-Math.PI / 2, 0, -Math.PI / 2, 'ZYX');
const FRUSTUM = { color: '#e8e8e8', width: 1.5, opacity: 0.85 };
// Images without camera info for this long: a field of view is assumed
const INFO_GRACE_MS = 2000;

interface CameraInfoMessage {
  width: number;
  height: number;
  k: number[];
  p: number[];
}

export class CameraDisplay extends Display<CameraDisplayConfig> {
  // Where TF puts the images' frame
  protected readonly holder = new Group();
  // The camera's optical frame, in the holder
  protected readonly optical = new Group();
  protected readonly frustum = new LinesLayer(FRUSTUM);
  private readonly material = new MeshBasicMaterial({ side: DoubleSide, toneMapped: false });
  private readonly plane = new Mesh(new BufferGeometry(), this.material);
  private config: CameraDisplayConfig | null = null;
  private texture: Texture | null = null;
  private unsubscribeImages: (() => void) | null = null;
  private unsubscribeInfo: (() => void) | null = null;
  private infoTopic = '';
  private frameId = '';
  // From the camera info, null until it comes
  private intrinsics: Intrinsics | null = null;
  // Of the images, as published: the projection without camera info
  private imageSize: { width: number; height: number } | null = null;
  private firstImageAt = 0;

  constructor(context: DisplayContext) {
    super(context);
    const geometry = this.plane.geometry;
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    // The image's top left, top right, bottom right, bottom left: its first
    // row, at v = 0, as ImageBitmaps are not flipped
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex([0, 3, 1, 1, 3, 2]);
    this.plane.visible = false;
    this.optical.add(this.plane, this.frustum.object);
    this.holder.add(this.optical);
    this.root.add(this.holder);
  }

  configure(config: CameraDisplayConfig, previous: CameraDisplayConfig | null): void {
    this.config = config;
    const transparent = config.alpha < 1;
    if (this.material.transparent !== transparent) {
      this.material.transparent = transparent;
      this.material.depthWrite = !transparent;
      this.material.needsUpdate = true;
    }
    this.material.opacity = config.alpha;
    this.optical.rotation.copy(config.axes === 'body' ? OPTICAL_IN_BODY : new Euler());
    const topic = config.topic.trim();
    if (
      !previous ||
      topic !== previous.topic.trim() ||
      config.transport !== previous.transport ||
      config.maxRate !== previous.maxRate ||
      config.maxWidth !== previous.maxWidth ||
      config.quality !== previous.quality
    ) {
      this.subscribeImages(config);
    }
    const infoTopic = config.cameraInfoTopic.trim() || (topic ? cameraInfoTopic(topic) : '');
    if (infoTopic !== this.infoTopic) {
      this.subscribeInfo(infoTopic);
    }
    this.layout();
    this.updateStatus();
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  dispose(): void {
    this.closeImage(this.texture);
  }

  private subscribeImages(config: CameraDisplayConfig): void {
    this.unsubscribeImages?.();
    this.unsubscribeImages = null;
    this.plane.visible = false;
    this.frameId = '';
    this.imageSize = null;
    this.firstImageAt = 0;
    const topic = config.topic.trim();
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    let current = true;
    const unsubscribe = this.connection.subscribeImage(
      {
        topic,
        transport: config.transport,
        maxFps: config.maxRate,
        quality: config.quality,
        maxWidth: config.maxWidth,
      },
      {
        status: (state, message) => {
          if (state !== 'streaming') {
            this.setStatus(state, message);
          }
        },
        frame: async (file, { meta, width, height }) => {
          const bitmap = await createImageBitmap(file);
          if (!current) {
            bitmap.close();
            return;
          }
          this.show(bitmap, (meta as ImageInfo | undefined)?.frameId ?? '', width || bitmap.width, height || bitmap.height);
        },
      },
    );
    this.unsubscribeImages = this.context.track(() => {
      current = false;
      unsubscribe();
    });
  }

  private subscribeInfo(topic: string): void {
    this.unsubscribeInfo?.();
    this.unsubscribeInfo = null;
    this.infoTopic = topic;
    this.intrinsics = null;
    if (!topic) {
      return;
    }
    // Its status is the images': without it, a field of view is assumed
    this.unsubscribeInfo = this.subscribeTopic<CameraInfoMessage>(
      topic,
      { types: [CAMERA_INFO], status: false, maxRate: 1 },
      (message) => {
        this.intrinsics = intrinsicsOf(message);
        this.layout();
        this.updateStatus();
        this.render();
      },
    );
  }

  private show(bitmap: ImageBitmap, frameId: string, width: number, height: number): void {
    const texture = this.texture;
    const image = texture?.image as ImageBitmap | undefined;
    if (texture && image && image.width === bitmap.width && image.height === bitmap.height) {
      // The same texture, its pixels replaced
      image.close();
      texture.image = bitmap;
      texture.needsUpdate = true;
    } else {
      const next = new Texture(bitmap);
      next.flipY = false;
      next.colorSpace = SRGBColorSpace;
      next.minFilter = LinearFilter;
      next.generateMipmaps = false;
      next.needsUpdate = true;
      this.material.map = next;
      this.material.needsUpdate = true;
      this.closeImage(texture);
      texture?.dispose();
      this.texture = next;
    }
    if (this.imageSize?.width !== width || this.imageSize?.height !== height) {
      this.imageSize = { width, height };
      this.layout();
    }
    this.firstImageAt ||= performance.now();
    if (frameId !== this.frameId) {
      this.frameId = frameId;
      this.attach(this.holder, frameId);
    }
    this.plane.visible = true;
    this.updateStatus();
    this.render();
  }

  // The plane and the frustum, from the camera info, else the field of view
  private layout(): void {
    const config = this.config;
    const intrinsics =
      this.intrinsics ??
      (this.imageSize && config ? intrinsicsFromFov(this.imageSize.width, this.imageSize.height, config.fov) : null);
    if (!config || !intrinsics) {
      this.frustum.setSegments([]);
      return;
    }
    const corners = imageCorners(intrinsics, config.distance);
    const position = this.plane.geometry.getAttribute('position') as BufferAttribute;
    corners.forEach(([x, y, z], i) => position.setXYZ(i, x, y, z));
    position.needsUpdate = true;
    this.plane.geometry.computeBoundingSphere();
    this.plane.geometry.computeBoundingBox();
    if (!config.showFrustum) {
      this.frustum.setSegments([]);
      return;
    }
    const segments: number[] = [];
    corners.forEach((corner, i) => {
      segments.push(0, 0, 0, ...corner);
      segments.push(...corner, ...corners[(i + 1) % 4]);
    });
    this.frustum.setSegments(segments);
  }

  private updateStatus(): void {
    // Until an image comes, the stream's status
    if (!this.plane.visible) {
      return;
    }
    if (!this.pose(this.frameId)) {
      this.setStatus('warn', this.missingFrame(this.frameId));
    } else if (!this.intrinsics && this.firstImageAt && performance.now() - this.firstImageAt > INFO_GRACE_MS) {
      this.setStatus(
        'warn',
        `No camera info on ${this.infoTopic || 'its topic'}: a ${this.config?.fov ?? 60}° field of view assumed`,
      );
    } else {
      this.setStatus('ok');
    }
  }

  private closeImage(texture: Texture | null): void {
    const image = texture?.image as ImageBitmap | undefined;
    image?.close?.();
  }
}
