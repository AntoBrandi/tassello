// Any topic for the widgets, its messages as JSON: e.g. the robot description
// and the joint states of the robot model widget. One subscription per topic,
// with the QoS and type of its publishers, shared by its watchers; each gets
// the latest message, then the next ones at most at its own rate.

import type rclnodejs from 'rclnodejs';

import type { StreamState } from './frame_stream.ts';
import { missingCodeHint } from './message_code.ts';
import { publishersQos } from './qos.ts';
import { absoluteTopic, errorMessage, toJson, type Logger } from './util.ts';

// How often the graph is checked for the topic's publishers, until it has one
const RETRY_PERIOD_MS = 1000;

export interface TopicWatcher {
  minIntervalMs: number;
  onStatus: (state: StreamState, message: string) => void;
  onMessage: (type: string, message: unknown) => void;
}

interface Delivery {
  lastSentAt: number;
  lastSentSeq: number;
  timer: NodeJS.Timeout | null;
}

interface Latest {
  seq: number;
  raw: unknown;
  // Converted once, when first sent
  json: unknown;
}

class TopicSubscription {
  readonly watchers = new Map<TopicWatcher, Delivery>();
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly topic: string;
  private subscription: rclnodejs.Subscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private type = '';
  private latest: Latest | null = null;
  private seq = 0;
  private state: StreamState = 'waiting';
  private message = '';

  constructor(node: rclnodejs.Node, logger: Logger, topic: string) {
    this.node = node;
    this.logger = logger;
    this.topic = topic;
    this.subscribe();
  }

  add(watcher: TopicWatcher): void {
    const delivery: Delivery = { lastSentAt: 0, lastSentSeq: 0, timer: null };
    this.watchers.set(watcher, delivery);
    watcher.onStatus(this.state, this.message);
    this.deliver(watcher, delivery);
  }

  remove(watcher: TopicWatcher): void {
    const delivery = this.watchers.get(watcher);
    if (delivery?.timer) {
      clearTimeout(delivery.timer);
    }
    this.watchers.delete(watcher);
  }

  destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.subscription) {
      this.node.destroySubscription(this.subscription);
    }
  }

  private subscribe(): void {
    this.retryTimer = null;
    const match = publishersQos(this.node, this.topic, null, 1);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      this.retryTimer = setTimeout(() => this.subscribe(), RETRY_PERIOD_MS);
      return;
    }
    try {
      this.subscription = this.node.createSubscription(
        // @ts-expect-error: the type is a runtime string, not one of the literal types
        match.type,
        this.topic,
        { qos: match.qos },
        (raw: unknown) => this.onMessage(raw),
      );
    } catch (e) {
      this.setState('error', `Cannot subscribe to ${this.topic}: ${missingCodeHint(errorMessage(e))}`);
      return;
    }
    this.type = match.type;
    this.setState('waiting', `Waiting for messages on ${this.topic}`);
  }

  private onMessage(raw: unknown): void {
    this.latest = { seq: ++this.seq, raw, json: undefined };
    this.setState('streaming', this.type);
    for (const [watcher, delivery] of this.watchers) {
      this.deliver(watcher, delivery);
    }
  }

  // Now, or when the watcher's rate allows: the latest message then
  private deliver(watcher: TopicWatcher, delivery: Delivery): void {
    const latest = this.latest;
    if (!latest || latest.seq === delivery.lastSentSeq || delivery.timer) {
      return;
    }
    const wait = delivery.lastSentAt + watcher.minIntervalMs - Date.now();
    if (wait > 0) {
      delivery.timer = setTimeout(() => {
        delivery.timer = null;
        this.deliver(watcher, delivery);
      }, wait);
      return;
    }
    latest.json ??= toJson(latest.raw);
    delivery.lastSentAt = Date.now();
    delivery.lastSentSeq = latest.seq;
    watcher.onMessage(this.type, latest.json);
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
    for (const watcher of this.watchers.keys()) {
      watcher.onStatus(state, message);
    }
  }
}

export class Topics {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly subscriptions = new Map<string, TopicSubscription>();

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  // Until the returned function is called
  watch(topic: string, watcher: TopicWatcher): () => void {
    const name = absoluteTopic(topic);
    let subscription = this.subscriptions.get(name);
    if (!subscription) {
      subscription = new TopicSubscription(this.node, this.logger, name);
      this.subscriptions.set(name, subscription);
    }
    const shared = subscription;
    shared.add(watcher);
    return () => {
      shared.remove(watcher);
      if (shared.watchers.size === 0) {
        shared.destroy();
        this.subscriptions.delete(name);
      }
    };
  }
}
