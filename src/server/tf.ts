// TF for the widgets: where a frame is in another, e.g. the robot in the map,
// sent to the page at a fixed rate. /tf and /tf_static are only subscribed
// while a page watches a transform, or something placed by TF (overlays.ts):
// the robot's /tf is busy.

import rclnodejs from 'rclnodejs';

import type { Pose3D, TfFrame, Transform2D } from '../shared/protocol.ts';
import { normalizeFrame, TfTree, yawOf, type Transform } from './transforms.ts';
import { errorMessage, type Logger } from './util.ts';

const TF_MESSAGE = 'tf2_msgs/msg/TFMessage';
// TF's topics are subscribed to with the first watcher: frames it cannot find
// meanwhile are not errors yet
const TF_GRACE_MS = 2000;

// To 1e-5 (a hundredth of a millimetre): the JSON stays short
const round = (value: number) => Math.round(value * 1e5) / 1e5 || 0;

export function poseOf({ translation: t, rotation: r }: Transform): Pose3D {
  return [round(t.x), round(t.y), round(t.z), round(r.x), round(r.y), round(r.z), round(r.w)];
}

export interface TfFramesResult {
  frames: TfFrame[];
  error: string | null;
}
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

  // Follows /tf and /tf_static until the returned function is called, for the
  // modules that look transforms up themselves (lookupTransform)
  use(): () => void {
    this.acquire();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.release();
      }
    };
  }

  // The pose of source in target now, in 3D, and the age of the oldest
  // dynamic transform it is made of. Throws if they are not connected.
  lookupTransform(target: string, source: string): { transform: Transform; ageMs: number } {
    return this.tree.lookup(target, source, Date.now());
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

  // Calls back with every frame, and its pose in fixedFrame (none if empty),
  // `rate` times a second, until the returned function is called
  watchFrames(fixedFrame: string, rate: number, callback: (result: TfFramesResult) => void): () => void {
    this.acquire();
    const started = Date.now();
    const timer = setInterval(() => callback(this.frames(fixedFrame, Date.now() - started < TF_GRACE_MS)), 1000 / rate);
    return () => {
      clearInterval(timer);
      this.release();
    };
  }

  // grace: TF's topics were just subscribed to, a frame missing may come
  private frames(fixedFrame: string, grace: boolean): TfFramesResult {
    const now = Date.now();
    const fixed = normalizeFrame(fixedFrame);
    const frames: TfFrame[] = this.tree.frames().map(({ name, parent, receivedAt }) => ({
      name,
      parent,
      pose: null,
      ageMs: receivedAt === null ? null : now - receivedAt,
    }));
    if (!fixed) {
      return { frames, error: null };
    }
    if (!frames.some((frame) => frame.name === fixed)) {
      return {
        frames,
        error: grace ? null : frames.length === 0 ? 'No TF frames yet' : `Frame "${fixed}" does not exist`,
      };
    }
    for (const frame of frames) {
      try {
        frame.pose = poseOf(this.tree.lookup(fixed, frame.name, now).transform);
      } catch {
        // Of another tree: no pose
      }
    }
    return { frames, error: null };
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
