// TF for the widgets: where a frame is in another, e.g. the robot in the map,
// sent to the page at a fixed rate. /tf and /tf_static are only subscribed
// while a page watches a transform: the robot's /tf is busy.

import rclnodejs from 'rclnodejs';

import type { Transform2D } from '../shared/protocol.ts';
import { TfTree, yawOf, type Transform } from './transforms.ts';
import { errorMessage, type Logger } from './util.ts';

const TF_MESSAGE = 'tf2_msgs/msg/TFMessage';
const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

// As tf2_ros's listener: depth 100, static transforms latched
const DYNAMIC_QOS = new rclnodejs.QoS(
  HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
  100,
  ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
  DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
);
const STATIC_QOS = new rclnodejs.QoS(
  HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
  100,
  ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
  DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL,
);

export interface TfResult {
  transform: Transform2D | null;
  error: string | null;
  ageMs: number;
}

interface TfMessage {
  transforms: { header: { frame_id: string }; child_frame_id: string; transform: Transform }[];
}

export class Tf {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly tree = new TfTree();
  private subscriptions: rclnodejs.Subscription[] = [];
  private watchers = 0;

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  // Calls back with the pose of source in target `rate` times a second, until
  // the returned function is called
  watch(target: string, source: string, rate: number, callback: (result: TfResult) => void): () => void {
    this.acquire();
    const timer = setInterval(() => callback(this.lookup(target, source)), 1000 / rate);
    return () => {
      clearInterval(timer);
      this.release();
    };
  }

  private lookup(target: string, source: string): TfResult {
    try {
      const { transform, ageMs } = this.tree.lookup(target, source, Date.now());
      return {
        transform: {
          x: transform.translation.x,
          y: transform.translation.y,
          yaw: yawOf(transform.rotation),
        },
        error: null,
        ageMs,
      };
    } catch (e) {
      return { transform: null, error: errorMessage(e), ageMs: 0 };
    }
  }

  private acquire(): void {
    if (this.watchers++ > 0) {
      return;
    }
    const store = (isStatic: boolean) => (msg: unknown) => {
      const now = Date.now();
      for (const t of (msg as TfMessage).transforms) {
        this.tree.set(t.header.frame_id, t.child_frame_id, t.transform, isStatic ? null : now);
      }
    };
    try {
      this.subscriptions = [
        this.node.createSubscription(TF_MESSAGE, '/tf', { qos: DYNAMIC_QOS }, store(false)),
        this.node.createSubscription(TF_MESSAGE, '/tf_static', { qos: STATIC_QOS }, store(true)),
      ];
    } catch (e) {
      this.logger.error(`Cannot subscribe to TF: ${errorMessage(e)}`);
    }
  }

  private release(): void {
    if (--this.watchers > 0) {
      return;
    }
    for (const subscription of this.subscriptions.splice(0)) {
      this.node.destroySubscription(subscription);
    }
    // Static transforms come again, latched, with the next subscription
    this.tree.clear();
  }
}
