// The ROS log for the logs widgets: the rcl_interfaces/msg/Log every node's
// logger publishes on /rosout, and the nodes of the ROS graph.
//
// A log is followed whole, like the behavior trees' (behavior_trees.ts): each
// topic is subscribed once, with its publishers' QoS (rcl's: reliable and
// transient local, so that each node's latest messages arrive first) and a
// deep queue. The server keeps its latest ROSOUT_HISTORY messages, and sends
// its pages the new ones at most ROSOUT_RATE times a second, at most
// MAX_BATCH at a time: a node logging faster than that has the oldest of each
// batch skipped, which the page is told. The log outlives its last page for
// LINGER_MS: a page reloaded, or a panel shown again, finds what was logged
// meanwhile.

import type rclnodejs from 'rclnodejs';

import { ROSOUT_HISTORY, ROSOUT_RATE, type RosoutUpdate } from '../shared/protocol.ts';
import type { StreamState } from './frame_stream.ts';
import { publishersQos } from './qos.ts';
import { LogHistory, nodeNames } from './rosout_log.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const LOG_TYPE = 'rcl_interfaces/msg/Log';
// How often the graph is checked for the topic's publishers, until it has one
const RETRY_PERIOD_MS = 1000;
// Messages queued while the server is busy: nodes log bursts as they start.
// The depth of rcl's own rosout publishers.
const QUEUE_DEPTH = 1000;
// ROSOUT_RATE times this a second, at most, to a page
const MAX_BATCH = 500;
const LINGER_MS = 10 * 60_000;
// How often the graph is checked for its nodes, while a page watches
const NODES_CHECK_MS = 2000;

export interface RosoutWatcher {
  onStatus: (state: StreamState, message: string) => void;
  onUpdate: (update: Omit<RosoutUpdate, 'type' | 'id'>) => void;
}

// A log topic: its subscription, its messages, its pages
class RosoutLog {
  readonly watchers = new Set<RosoutWatcher>();
  lingerTimer: NodeJS.Timeout | null = null;
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly topic: string;
  private readonly started = Date.now();
  private readonly history = new LogHistory(ROSOUT_HISTORY);
  private subscription: rclnodejs.Subscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private state: StreamState = 'waiting';
  private message = '';
  private nodes: string[] = [];
  // Since the last update
  private nodesChanged = false;
  private nodesTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastFlush = 0;

  constructor(node: rclnodejs.Node, logger: Logger, topic: string) {
    this.node = node;
    this.logger = logger;
    this.topic = topic;
    this.subscribe();
  }

  add(watcher: RosoutWatcher): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.checkNodes();
    // What the others have not had yet, which the new one gets with the rest
    this.flush();
    this.watchers.add(watcher);
    watcher.onStatus(this.state, this.message);
    watcher.onUpdate({
      reset: true,
      started: this.started,
      entries: this.history.snapshot(),
      skipped: 0,
      nodes: this.nodes,
    });
    this.nodesTimer ??= setInterval(() => this.checkNodes(), NODES_CHECK_MS);
  }

  remove(watcher: RosoutWatcher): void {
    this.watchers.delete(watcher);
    if (this.watchers.size === 0 && this.nodesTimer) {
      clearInterval(this.nodesTimer);
      this.nodesTimer = null;
    }
  }

  destroy(): void {
    for (const timer of [this.retryTimer, this.flushTimer, this.lingerTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (this.nodesTimer) {
      clearInterval(this.nodesTimer);
    }
    if (this.subscription) {
      this.node.destroySubscription(this.subscription);
    }
  }

  private subscribe(): void {
    this.retryTimer = null;
    const match = publishersQos(this.node, this.topic, LOG_TYPE, QUEUE_DEPTH);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      this.retryTimer = setTimeout(() => this.subscribe(), RETRY_PERIOD_MS);
      return;
    }
    try {
      this.subscription = this.node.createSubscription(LOG_TYPE, this.topic, { qos: match.qos }, (raw: unknown) =>
        this.onMessage(raw),
      );
    } catch (e) {
      this.setState('error', `Cannot subscribe to ${this.topic}: ${errorMessage(e)}`);
      return;
    }
    this.setState('waiting', `Waiting for messages on ${this.topic}`);
  }

  private onMessage(raw: unknown): void {
    this.history.add(raw);
    this.setState('streaming', LOG_TYPE);
    this.scheduleFlush();
  }

  private checkNodes(): void {
    let nodes: string[];
    try {
      nodes = nodeNames(this.node.getNodeNamesAndNamespaces());
    } catch {
      return;
    }
    if (nodes.join('\n') !== this.nodes.join('\n')) {
      this.nodes = nodes;
      this.nodesChanged = true;
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.watchers.size === 0) {
      return;
    }
    const wait = Math.max(0, this.lastFlush + 1000 / ROSOUT_RATE - Date.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlush = Date.now();
    const batch = this.history.takeBatch(MAX_BATCH);
    const nodes = this.nodesChanged ? this.nodes : null;
    this.nodesChanged = false;
    if (!batch && !nodes) {
      return;
    }
    const update = {
      reset: false,
      started: this.started,
      entries: batch?.entries ?? [],
      skipped: batch?.skipped ?? 0,
      nodes,
    };
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

export class Rosout {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly logs = new Map<string, RosoutLog>();

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  // Until the returned function is called
  watch(topic: string, watcher: RosoutWatcher): () => void {
    const name = absoluteTopic(topic);
    let log = this.logs.get(name);
    if (!log) {
      log = new RosoutLog(this.node, this.logger, name);
      this.logs.set(name, log);
    }
    const shared = log;
    shared.add(watcher);
    return () => {
      shared.remove(watcher);
      if (shared.watchers.size === 0 && !shared.lingerTimer) {
        shared.lingerTimer = setTimeout(() => this.forget(name, shared), LINGER_MS);
      }
    };
  }

  private forget(topic: string, log: RosoutLog): void {
    log.destroy();
    if (this.logs.get(topic) === log) {
      this.logs.delete(topic);
    }
  }
}
