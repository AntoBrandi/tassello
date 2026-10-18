// The image and grid streams the pages subscribe to: one per distinct request,
// shared by its consumers, destroyed with the last of them.

import type rclnodejs from 'rclnodejs';

import type { Consumer, FrameSink, FrameStream } from './frame_stream.ts';
import { GridStream, gridStreamKey, type GridOptions } from './grids.ts';
import { ImageStream, imageStreamKey, type ImageOptions } from './images.ts';
import type { Logger } from './util.ts';

export class FrameStreams {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly streams = new Map<string, FrameStream>();

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  image(sink: FrameSink, id: number, options: ImageOptions): Consumer {
    return this.subscribe(sink, id, options.maxFps, imageStreamKey(options), () =>
      new ImageStream(this.node, this.logger, options),
    );
  }

  grid(sink: FrameSink, id: number, options: GridOptions): Consumer {
    return this.subscribe(sink, id, options.maxFps, gridStreamKey(options), () =>
      new GridStream(this.node, this.logger, options),
    );
  }

  unsubscribe(consumer: Consumer): void {
    const { stream } = consumer;
    stream.remove(consumer);
    if (stream.consumers.size === 0) {
      stream.destroy();
      for (const [key, s] of this.streams) {
        if (s === stream) {
          this.streams.delete(key);
        }
      }
    }
  }

  ack(consumer: Consumer): void {
    consumer.stream.ack(consumer);
  }

  private subscribe(
    sink: FrameSink,
    id: number,
    maxFps: number,
    key: string,
    create: () => FrameStream,
  ): Consumer {
    let stream = this.streams.get(key);
    if (!stream) {
      stream = create();
      this.streams.set(key, stream);
    }
    const consumer: Consumer = {
      sink,
      id,
      stream,
      minIntervalMs: 1000 / maxFps,
      inFlightSince: null,
      lastSentAt: 0,
      lastSentSeq: 0,
      timer: null,
    };
    stream.add(consumer);
    return consumer;
  }
}
