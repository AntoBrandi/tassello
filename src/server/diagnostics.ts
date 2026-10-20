// The robot's diagnostics for the diagnostics widgets: the
// diagnostic_msgs/msg/DiagnosticArray of /diagnostics, which every node's
// diagnostic_updater publishes, or of /diagnostics_agg, the aggregator's tree.
//
// A topic is followed once for every page, like the ROS log (rosout.ts). The
// server keeps the latest status of each name, marks stale those no longer
// received, and logs their changes of level (diagnostics_state.ts); its pages
// get the statuses that changed at most DIAGNOSTICS_RATE times a second.
// Diagnostics are followed for LINGER_MS after the last page: a page opened
// later sees what changed meanwhile.

import rclnodejs from 'rclnodejs';

import { DIAGNOSTICS_CHANGES, DIAGNOSTICS_RATE, type DiagnosticsUpdate } from '../shared/protocol.ts';
import { DiagnosticsState, STALE_AFTER_MS } from './diagnostics_state.ts';
import type { StreamState } from './frame_stream.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

const ARRAY_TYPE = 'diagnostic_msgs/msg/DiagnosticArray';
// Arrays queued while the server is busy: every node publishes its own
const QUEUE_DEPTH = 100;
// How often the statuses are checked for staleness, and the topic for
// publishers until it has messages
const CHECK_PERIOD_MS = 1000;
const LINGER_MS = 10 * 60_000;

export interface DiagnosticsWatcher {
  onStatus: (state: StreamState, message: string) => void;
  onUpdate: (update: Omit<DiagnosticsUpdate, 'type' | 'id'>) => void;
}

// A diagnostics topic: its subscription, its statuses, its pages
class DiagnosticsTopic {
  readonly watchers = new Set<DiagnosticsWatcher>();
  lingerTimer: NodeJS.Timeout | null = null;
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly topic: string;
  private readonly started = Date.now();
  private readonly statuses = new DiagnosticsState(DIAGNOSTICS_CHANGES);
  private subscription: rclnodejs.Subscription | null = null;
  private readonly checkTimer: NodeJS.Timeout;
  private state: StreamState = 'waiting';
  private message = '';
  // When the latest array came, 0 before the first
  private lastMessage = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastFlush = 0;

  constructor(node: rclnodejs.Node, logger: Logger, topic: string) {
    this.node = node;
    this.logger = logger;
    this.topic = topic;
    this.check();
    this.checkTimer = setInterval(() => this.check(), CHECK_PERIOD_MS);
  }

  add(watcher: DiagnosticsWatcher): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    // What the others have not had yet, which the new one gets with the rest
    this.flush();
    this.watchers.add(watcher);
    watcher.onStatus(this.state, this.message);
    watcher.onUpdate({ reset: true, started: this.started, ...this.statuses.snapshot() });
  }

  remove(watcher: DiagnosticsWatcher): void {
    this.watchers.delete(watcher);
  }

  destroy(): void {
    clearInterval(this.checkTimer);
    for (const timer of [this.flushTimer, this.lingerTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (this.subscription) {
      this.node.destroySubscription(this.subscription);
    }
  }

  // Best effort and volatile, which every publisher matches, reliable or not,
  // latched or not: unlike most topics, /diagnostics has many publishers, and
  // those that come later may not have the first ones' QoS. A lost array is
  // followed by another a second later. Whether it could.
  private subscribe(): boolean {
    const qos = new rclnodejs.QoS(
      HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
      QUEUE_DEPTH,
      ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT,
      DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
    );
    try {
      this.subscription = this.node.createSubscription(ARRAY_TYPE, this.topic, { qos }, (raw: unknown) =>
        this.onMessage(raw),
      );
      return true;
    } catch (e) {
      this.setState('error', `Cannot subscribe to ${this.topic}: ${errorMessage(e)}`);
      return false;
    }
  }

  private onMessage(raw: unknown): void {
    this.lastMessage = Date.now();
    this.statuses.add(raw, this.lastMessage);
    this.setState('streaming', this.topic);
    this.scheduleFlush();
  }

  // Marks the stale statuses, and until diagnostics come, subscribes when the
  // topic is not of another type (which the middleware would refuse), and
  // says what they wait for
  private check(): void {
    const now = Date.now();
    this.statuses.checkStale(now);
    this.scheduleFlush();
    if (this.lastMessage > 0 && now - this.lastMessage <= STALE_AFTER_MS) {
      return;
    }
    let types: string[];
    try {
      // Which says what is wrong with it, unlike the lookup
      rclnodejs.validator.validateFullTopicName(this.topic);
      const publishers = this.node.getPublishersInfoByTopic(this.topic, false) as { topic_type: string }[];
      types = [...new Set(publishers.map((p) => p.topic_type))];
    } catch (e) {
      this.setState('error', errorMessage(e));
      return;
    }
    if (types.length > 0 && !types.includes(ARRAY_TYPE)) {
      this.setState('error', `${this.topic} is a ${types.join(', ')}, not a ${ARRAY_TYPE}`);
      return;
    }
    if (!this.subscription && !this.subscribe()) {
      return;
    }
    if (this.lastMessage > 0) {
      this.setState('waiting', `No diagnostics on ${this.topic} lately: their statuses went stale`);
    } else if (types.length === 0) {
      this.setState('waiting', `Waiting for ${this.topic} to be published`);
    } else {
      this.setState('waiting', `Waiting for diagnostics on ${this.topic}`);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.watchers.size === 0) {
      return;
    }
    const wait = Math.max(0, this.lastFlush + 1000 / DIAGNOSTICS_RATE - Date.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlush = Date.now();
    // With no page left, what changed waits for the next one, which gets it
    // with the rest
    const batch = this.statuses.takeBatch();
    if (!batch) {
      return;
    }
    const update = { reset: false, started: this.started, ...batch };
    for (const watcher of this.watchers) {
      watcher.onUpdate(update);
    }
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

export class Diagnostics {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly topics = new Map<string, DiagnosticsTopic>();

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  // Until the returned function is called
  watch(topic: string, watcher: DiagnosticsWatcher): () => void {
    const name = absoluteTopic(topic);
    let diagnostics = this.topics.get(name);
    if (!diagnostics) {
      diagnostics = new DiagnosticsTopic(this.node, this.logger, name);
      this.topics.set(name, diagnostics);
    }
    const shared = diagnostics;
    shared.add(watcher);
    return () => {
      shared.remove(watcher);
      if (shared.watchers.size === 0 && !shared.lingerTimer) {
        shared.lingerTimer = setTimeout(() => this.forget(name, shared), LINGER_MS);
      }
    };
  }

  private forget(topic: string, diagnostics: DiagnosticsTopic): void {
    diagnostics.destroy();
    if (this.topics.get(topic) === diagnostics) {
      this.topics.delete(topic);
    }
  }
}
