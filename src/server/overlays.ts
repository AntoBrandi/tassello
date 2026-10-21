// What the navigation widgets draw over the map: a laser scan's points, in the
// map's frame, and a footprint (Nav2's published_footprint), in the robot's
// frame, which the page draws where the robot is. Each message is put in its
// frame by TF as it arrives: TF keeps no history (transforms.ts), so later it
// would land where the robot is by then, not where it was. One subscription
// per topic and frame, with the QoS of its publishers, shared by the pages;
// the latest is sent at most OVERLAY_RATE times a second.

import type rclnodejs from 'rclnodejs';

import { OVERLAY_RATE, type OverlayKind } from '../shared/protocol.ts';
import type { StreamState } from './frame_stream.ts';
import { missingCodeHint } from './message_code.ts';
import {
  polygonPoints,
  scanPoints,
  type LaserScanMessage,
  type PolygonMessage,
} from './overlay_encoding.ts';
import { publishersQos } from './qos.ts';
import type { Tf } from './tf.ts';
import type { Transform } from './transforms.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const TYPES: Record<OverlayKind, string> = {
  scan: 'sensor_msgs/msg/LaserScan',
  footprint: 'geometry_msgs/msg/PolygonStamped',
};
// How often the graph is checked for the topic's publishers, until it has one
const RETRY_PERIOD_MS = 1000;
// TF's own topics are subscribed to with the overlay: frames it cannot find
// meanwhile are not errors yet
const TF_GRACE_MS = 2000;

export interface OverlayData {
  // x0, y0, x1, y1, ... in the frame asked for
  points: number[];
  // Why the latest message could not be put in it, e.g. no TF between them
  error: string | null;
}

export interface OverlayWatcher {
  onStatus: (state: StreamState, message: string) => void;
  onOverlay: (overlay: OverlayData) => void;
}

type Message = LaserScanMessage | PolygonMessage;

class Overlay {
  readonly watchers = new Set<OverlayWatcher>();
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly tf: Tf;
  private readonly kind: OverlayKind;
  private readonly topic: string;
  private readonly frame: string;
  private readonly releaseTf: () => void;
  private readonly started = Date.now();
  private subscription: rclnodejs.Subscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private sendTimer: NodeJS.Timeout | null = null;
  // The latest message, with its frame's pose in ours as it arrived
  private pending: { message: Message; transform: Transform } | { error: string } | null = null;
  private latest: OverlayData | null = null;
  private state: StreamState = 'waiting';
  private message = '';

  constructor(node: rclnodejs.Node, logger: Logger, tf: Tf, kind: OverlayKind, topic: string, frame: string) {
    this.node = node;
    this.logger = logger;
    this.tf = tf;
    this.kind = kind;
    this.topic = topic;
    this.frame = frame;
    this.releaseTf = tf.use();
    this.subscribe();
  }

  add(watcher: OverlayWatcher): void {
    this.watchers.add(watcher);
    watcher.onStatus(this.state, this.message);
    if (this.latest) {
      watcher.onOverlay(this.latest);
    }
  }

  destroy(): void {
    for (const timer of [this.retryTimer, this.sendTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (this.subscription) {
      this.node.destroySubscription(this.subscription);
    }
    this.releaseTf();
  }

  private subscribe(): void {
    this.retryTimer = null;
    const match = publishersQos(this.node, this.topic, TYPES[this.kind], 1);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      this.retryTimer = setTimeout(() => this.subscribe(), RETRY_PERIOD_MS);
      return;
    }
    try {
      this.subscription = this.node.createSubscription(
        // @ts-expect-error: the type is a runtime string, not one of the literal types
        TYPES[this.kind],
        this.topic,
        { qos: match.qos },
        (message: unknown) => this.onMessage(message as Message),
      );
    } catch (e) {
      this.setState('error', `Cannot subscribe to ${this.topic}: ${missingCodeHint(errorMessage(e))}`);
      return;
    }
    this.setState('waiting', `Waiting for messages on ${this.topic}`);
  }

  private onMessage(message: Message): void {
    try {
      const { transform } = this.tf.lookupTransform(this.frame, message.header.frame_id);
      this.pending = { message, transform };
    } catch (e) {
      if (Date.now() - this.started < TF_GRACE_MS) {
        return;
      }
      this.pending = { error: `Cannot put ${this.topic} in "${this.frame}": ${errorMessage(e)}` };
    }
    this.setState('streaming', TYPES[this.kind]);
    if (!this.sendTimer) {
      this.send();
    }
  }

  // The latest, then the next at most OVERLAY_RATE times a second
  private send(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    if ('error' in pending) {
      this.latest = { points: [], error: pending.error };
    } else {
      this.latest = {
        points:
          this.kind === 'scan'
            ? scanPoints(pending.message as LaserScanMessage, pending.transform)
            : polygonPoints(pending.message as PolygonMessage, pending.transform),
        error: null,
      };
    }
    for (const watcher of this.watchers) {
      watcher.onOverlay(this.latest);
    }
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.send();
    }, 1000 / OVERLAY_RATE);
  }

  private setState(state: StreamState, message: string): void {
    if (state === this.state && message === this.message) {
      return;
    }
    if (state === 'error') {
      this.logger.warn(message);
    }
    this.state = state;
    this.message = message;
    for (const watcher of this.watchers) {
      watcher.onStatus(state, message);
    }
  }
}

export class Overlays {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly tf: Tf;
  private readonly overlays = new Map<string, Overlay>();

  constructor(node: rclnodejs.Node, logger: Logger, tf: Tf) {
    this.node = node;
    this.logger = logger;
    this.tf = tf;
  }

  // The topic's messages, put in frame, until the returned function is called
  watch(kind: OverlayKind, topic: string, frame: string, watcher: OverlayWatcher): () => void {
    const name = absoluteTopic(topic);
    const key = `${kind} ${name} ${frame}`;
    let overlay = this.overlays.get(key);
    if (!overlay) {
      overlay = new Overlay(this.node, this.logger, this.tf, kind, name, frame);
      this.overlays.set(key, overlay);
    }
    const shared = overlay;
    shared.add(watcher);
    return () => {
      shared.watchers.delete(watcher);
      if (shared.watchers.size === 0) {
        shared.destroy();
        this.overlays.delete(key);
      }
    };
  }
}
