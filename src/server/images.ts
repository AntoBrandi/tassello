// Image topics for the camera widgets: raw images compressed to JPEG,
// compressed ones passed through. One stream per distinct request (topic,
// transport, quality, size).

import rclnodejs from 'rclnodejs';
import sharp from 'sharp';

import type { ImageSubscribe } from '../shared/protocol.ts';
import { FrameStream, type EncodedFrame } from './frame_stream.ts';
import { compressedToImage, rawToPixels, type RawImage } from './image_encoding.ts';
import { absoluteTopic, type Logger } from './util.ts';

const IMAGE = 'sensor_msgs/msg/Image';
const COMPRESSED_IMAGE = 'sensor_msgs/msg/CompressedImage';
type ImageType = typeof IMAGE | typeof COMPRESSED_IMAGE;

// The latest image only, and best effort: also matches reliable publishers
const IMAGE_QOS = new rclnodejs.QoS(
  rclnodejs.QoS.HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
  1,
  rclnodejs.QoS.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT,
  rclnodejs.QoS.DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
);

export type ImageOptions = Omit<ImageSubscribe, 'type' | 'id'>;

export function imageStreamKey(options: ImageOptions): string {
  return JSON.stringify(['image', options.topic, options.transport, options.quality, options.maxWidth]);
}

export class ImageStream extends FrameStream {
  private readonly options: ImageOptions;

  constructor(node: rclnodejs.Node, logger: Logger, options: ImageOptions) {
    super(node, logger, `Image stream ${options.topic}`);
    this.options = options;
    const topic = absoluteTopic(options.topic);
    if (options.transport === 'compressed') {
      this.subscribeImages(topic.endsWith('/compressed') ? topic : `${topic}/compressed`, COMPRESSED_IMAGE);
    } else if (options.transport === 'raw') {
      this.subscribeImages(topic, IMAGE);
    } else {
      this.retryUntil(() => this.resolve(topic));
    }
  }

  // 'auto': the type the topic is published with
  private resolve(topic: string): boolean {
    const types = this.node.getTopicNamesAndTypes().find((t) => t.name === topic)?.types ?? [];
    if (types.includes(COMPRESSED_IMAGE)) {
      this.subscribeImages(topic, COMPRESSED_IMAGE);
      return true;
    }
    if (types.includes(IMAGE)) {
      this.subscribeImages(topic, IMAGE);
      return true;
    }
    if (types.length > 0) {
      this.setState('error', `${topic} is a ${types.join(', ')}, not an image`);
    } else {
      this.setState('waiting', `Waiting for ${topic} to be published`);
    }
    return false;
  }

  private subscribeImages(topic: string, type: ImageType): void {
    if (this.subscribe(type, topic, IMAGE_QOS, (msg) => this.onImage(type, msg))) {
      this.description = topic;
      this.setState('waiting', `Waiting for images on ${topic}`);
    }
  }

  private onImage(type: ImageType, msg: unknown): void {
    if (type === IMAGE) {
      const image = msg as RawImage;
      this.description = `${image.encoding} ${image.width}×${image.height}`;
      this.offer(() => this.compress(image));
    } else {
      const image = msg as { format: string; data: Uint8Array | number[] };
      this.description = image.format || 'compressed';
      this.offer(async () => compressedToImage(image.format, toBytes(image.data)));
    }
  }

  private async compress(image: RawImage): Promise<EncodedFrame> {
    const pixels = rawToPixels({ ...image, data: toBytes(image.data) });
    let pipeline = sharp(pixels.data, {
      raw: { width: pixels.width, height: pixels.height, channels: pixels.channels },
    });
    const { maxWidth, quality } = this.options;
    if (maxWidth > 0 && pixels.width > maxWidth) {
      pipeline = pipeline.resize({ width: maxWidth });
    }
    const data = await pipeline.jpeg({ quality }).toBuffer();
    return { data, format: 0, width: image.width, height: image.height };
  }
}

// rclnodejs delivers uint8[] fields as Uint8Array, but types them loosely
function toBytes(data: Uint8Array | number[]): Uint8Array {
  return data instanceof Uint8Array ? data : Uint8Array.from(data);
}
