// What the image and grid streams share. A stream has one or more ROS
// subscriptions, shared by every widget showing it (its consumers), and is
// destroyed with the last of them.
//
// Each consumer gets one frame at a time, the latest, and the next only once
// it acknowledged that one: a slow network or browser skips frames instead of
// queueing them. A frame is encoded only when a consumer is ready for it, once
// whatever the number of consumers.

import type rclnodejs from 'rclnodejs';

import type { EncodedImage } from './image_encoding.ts';
import { errorMessage, type Logger } from './util.ts';

// How often the ROS graph is checked again for what a stream waits for, e.g.
// the type of a topic not published yet
const RETRY_PERIOD_MS = 1000;
// A frame not acknowledged within this time is taken as lost
const ACK_TIMEOUT_MS = 5000;

export type StreamState = 'waiting' | 'streaming' | 'error';

// An image file, with what the page needs to know about it
export interface EncodedFrame extends EncodedImage {
  meta?: object;
}

// Where a consumer's frames and status go: its WebSocket session
export interface FrameSink {
  sendStreamStatus(id: number, state: StreamState, message: string): void;
  sendFrame(id: number, frame: EncodedFrame): void;
}

export interface Consumer {
  readonly sink: FrameSink;
  readonly id: number;
  readonly stream: FrameStream;
  readonly minIntervalMs: number;
  // Since when the last frame sent waits for its acknowledgment
  inFlightSince: number | null;
  lastSentAt: number;
  lastSentSeq: number;
  // Holds the next frame back to respect the frame rate
  timer: NodeJS.Timeout | null;
}

interface Frame {
  seq: number;
  encode: () => Promise<EncodedFrame>;
  encoded: Promise<EncodedFrame> | null;
}

export abstract class FrameStream {
  readonly consumers = new Set<Consumer>();
  protected readonly node: rclnodejs.Node;
  protected readonly logger: Logger;
  // Shown to the pages while streaming, e.g. the image's encoding and size
  protected description = '';
  private readonly label: string;
  private readonly subscriptions: rclnodejs.Subscription[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private frame: Frame | null = null;
  private seq = 0;
  private state: StreamState = 'waiting';
  private message = '';

  // label: names the stream in the logs
  constructor(node: rclnodejs.Node, logger: Logger, label: string) {
    this.node = node;
    this.logger = logger;
    this.label = label;
  }

  add(consumer: Consumer): void {
    this.consumers.add(consumer);
    consumer.sink.sendStreamStatus(consumer.id, this.state, this.message);
    this.trySend(consumer);
  }

  remove(consumer: Consumer): void {
    this.consumers.delete(consumer);
    if (consumer.timer) {
      clearTimeout(consumer.timer);
    }
  }

  ack(consumer: Consumer): void {
    consumer.inFlightSince = null;
    this.trySend(consumer);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    for (const subscription of this.subscriptions.splice(0)) {
      this.node.destroySubscription(subscription);
    }
  }

  // Calls attempt until it returns true, waiting RETRY_PERIOD_MS in between
  protected retryUntil(attempt: () => boolean): void {
    this.retryTimer = null;
    if (!this.destroyed && !attempt()) {
      this.retryTimer = setTimeout(() => this.retryUntil(attempt), RETRY_PERIOD_MS);
    }
  }

  // false if it failed: the stream is then in error, unless optional
  protected subscribe(
    type: string,
    topic: string,
    qos: rclnodejs.QoS,
    callback: (message: unknown) => void,
    optional = false,
  ): boolean {
    try {
      this.subscriptions.push(
        // @ts-expect-error: the type is a runtime string, not one of the literal types
        this.node.createSubscription(type, topic, { qos }, callback),
      );
      return true;
    } catch (e) {
      if (!optional) {
        this.setState('error', `Cannot subscribe to ${topic}: ${errorMessage(e)}`);
      }
      return false;
    }
  }

  // A new frame is available, to encode when a consumer is ready for it
  protected offer(encode: () => Promise<EncodedFrame>): void {
    this.frame = { seq: ++this.seq, encode, encoded: null };
    for (const consumer of this.consumers) {
      this.trySend(consumer);
    }
  }

  protected setState(state: StreamState, message: string): void {
    if (state === this.state && message === this.message) {
      return;
    }
    if (state === 'error') {
      this.logger.warn(`${this.label}: ${message}`);
    }
    this.state = state;
    this.message = message;
    for (const consumer of this.consumers) {
      consumer.sink.sendStreamStatus(consumer.id, state, message);
    }
  }

  private trySend(consumer: Consumer): void {
    const frame = this.frame;
    if (!frame || frame.seq === consumer.lastSentSeq || consumer.timer) {
      return;
    }
    const now = Date.now();
    if (consumer.inFlightSince !== null && now - consumer.inFlightSince < ACK_TIMEOUT_MS) {
      return;
    }
    const wait = consumer.lastSentAt + consumer.minIntervalMs - now;
    if (wait > 0) {
      consumer.timer = setTimeout(() => {
        consumer.timer = null;
        this.trySend(consumer);
      }, wait);
      return;
    }
    consumer.inFlightSince = now;
    consumer.lastSentAt = now;
    consumer.lastSentSeq = frame.seq;
    frame.encoded ??= frame.encode();
    frame.encoded.then(
      (encoded) => {
        this.setState('streaming', this.description);
        if (this.consumers.has(consumer)) {
          consumer.sink.sendFrame(consumer.id, encoded);
        }
      },
      (e: unknown) => {
        consumer.inFlightSince = null;
        this.setState('error', errorMessage(e));
      },
    );
  }
}
