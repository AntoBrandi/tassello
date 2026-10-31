// Path topics (nav_msgs/Path) for the navigation widgets and the Robot
// Viewer, e.g. Nav2's plan: one subscription per topic, shared by the pages
// watching it, with the QoS of its publishers. A page gets the latest path
// when it starts watching, then every new one, at most every SEND_PERIOD_MS:
// its points in 2D, or its poses in 3D, each made once per path.

import type rclnodejs from 'rclnodejs';

import { toPathData, toPathPoses, type PathData, type PathMessage } from './path_encoding.ts';
import { publishersQos } from './qos.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const PATH = 'nav_msgs/msg/Path';
const SEND_PERIOD_MS = 200;
// How often the graph is checked for the topic's publishers, until it has one
const RETRY_PERIOD_MS = 1000;

type Watcher = (path: PathData) => void;

interface Latest {
  message: PathMessage;
  points?: PathData;
  poses?: PathData;
}

class PathTopic {
  // Each wants the poses (true) or the points
  readonly watchers = new Map<Watcher, boolean>();
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private subscription: rclnodejs.Subscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private sendTimer: NodeJS.Timeout | null = null;
  private latest: Latest | null = null;
  // A path arrived while sending was held back
  private pending = false;

  constructor(node: rclnodejs.Node, logger: Logger, topic: string) {
    this.node = node;
    this.logger = logger;
    this.subscribe(topic);
  }

  add(watcher: Watcher, poses: boolean): void {
    this.watchers.set(watcher, poses);
    if (this.latest) {
      watcher(this.encoded(poses));
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
  }

  private subscribe(topic: string): void {
    this.retryTimer = null;
    const match = publishersQos(this.node, topic, PATH, 1);
    if (!('qos' in match)) {
      this.retryTimer = setTimeout(() => this.subscribe(topic), RETRY_PERIOD_MS);
      return;
    }
    try {
      this.subscription = this.node.createSubscription(PATH, topic, { qos: match.qos }, (msg: unknown) =>
        this.onPath(msg as PathMessage),
      );
    } catch (e) {
      this.logger.warn(`Cannot subscribe to ${topic}: ${errorMessage(e)}`);
    }
  }

  private encoded(poses: boolean): PathData {
    const latest = this.latest!;
    return poses ? (latest.poses ??= toPathPoses(latest.message)) : (latest.points ??= toPathData(latest.message));
  }

  private onPath(msg: PathMessage): void {
    this.latest = { message: msg };
    if (this.sendTimer) {
      this.pending = true;
    } else {
      this.send();
    }
  }

  private send(): void {
    this.watchers.forEach((poses, watcher) => watcher(this.encoded(poses)));
    this.pending = false;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      if (this.pending) {
        this.send();
      }
    }, SEND_PERIOD_MS);
  }
}

export class Paths {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly topics = new Map<string, PathTopic>();

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  // Calls back with the topic's paths, their poses or their points, until the
  // returned function is called
  watch(topic: string, callback: Watcher, poses = false): () => void {
    const name = absoluteTopic(topic);
    let path = this.topics.get(name);
    if (!path) {
      path = new PathTopic(this.node, this.logger, name);
      this.topics.set(name, path);
    }
    const shared = path;
    shared.add(callback, poses);
    return () => {
      shared.watchers.delete(callback);
      if (shared.watchers.size === 0) {
        shared.destroy();
        this.topics.delete(name);
      }
    };
  }
}
