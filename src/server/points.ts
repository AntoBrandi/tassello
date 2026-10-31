// Laser scans and point clouds for the Robot Viewer, as binary frames of
// points (POINTS_FORMAT): thinned and quantized on the server, which sends a
// page the latest once it drew the previous one, as the camera's images. Each
// message is placed by TF as it arrives, its frame's pose in the fixed frame
// sent with its points: TF keeps no history (transforms.ts), so later it would
// land where the sensor is by then, not where it was.

import type rclnodejs from 'rclnodejs';

import { packPoints } from '../shared/points.ts';
import { POINTS_FORMAT, type Pose3D, type PointsInfo, type PointsSubscribe } from '../shared/protocol.ts';
import { FrameStream } from './frame_stream.ts';
import { cloudToPoints, scanToPoints, type PointCloud2Message, type ScanMessage } from './point_encoding.ts';
import { publishersQos } from './qos.ts';
import { poseOf, type Tf } from './tf.ts';
import { normalizeFrame } from './transforms.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const TYPES = {
  scan: 'sensor_msgs/msg/LaserScan',
  cloud: 'sensor_msgs/msg/PointCloud2',
} as const;
// TF's own topics are subscribed to with the stream: frames it cannot find
// meanwhile are not errors yet
const TF_GRACE_MS = 2000;

export type PointsOptions = Omit<PointsSubscribe, 'type' | 'id'>;

export function pointsStreamKey(options: PointsOptions): string {
  return JSON.stringify(['points', options.kind, options.topic, options.fixedFrame, options.maxPoints, options.channel]);
}

type Message = ScanMessage | PointCloud2Message;

export class PointsStream extends FrameStream {
  private readonly options: PointsOptions;
  private readonly tf: Tf;
  private readonly releaseTf: () => void;
  private readonly started = Date.now();
  private readonly topic: string;

  constructor(node: rclnodejs.Node, logger: Logger, tf: Tf, options: PointsOptions) {
    super(node, logger, `Points stream ${options.topic}`);
    this.options = options;
    this.tf = tf;
    this.topic = absoluteTopic(options.topic);
    this.releaseTf = tf.use();
    this.retryUntil(() => this.subscribePoints());
  }

  destroy(): void {
    super.destroy();
    this.releaseTf();
  }

  // Waits for a publisher, to subscribe with a QoS matching it: sensors are
  // usually best effort
  private subscribePoints(): boolean {
    const type = TYPES[this.options.kind];
    const match = publishersQos(this.node, this.topic, type, 1);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      return false;
    }
    // Its failure is the stream's error
    if (!this.subscribe(type, this.topic, match.qos, (message) => this.onMessage(message as Message))) {
      return true;
    }
    this.setState('waiting', `Waiting for messages on ${this.topic}`);
    return true;
  }

  private onMessage(message: Message): void {
    const frameId = normalizeFrame(message.header.frame_id);
    const fixedFrame = normalizeFrame(this.options.fixedFrame);
    let pose: Pose3D | null = null;
    let error: string | null = null;
    if (!fixedFrame) {
      error = 'No fixed frame';
    } else {
      try {
        pose = poseOf(this.tf.lookupTransform(fixedFrame, frameId).transform);
      } catch (e) {
        if (Date.now() - this.started < TF_GRACE_MS) {
          return;
        }
        error = `Cannot place ${this.topic} in "${fixedFrame}": ${errorMessage(e)}`;
      }
    }
    this.offer(async () => this.encode(message, frameId, pose, error));
  }

  private encode(message: Message, frameId: string, pose: Pose3D | null, error: string | null) {
    const { kind, maxPoints, channel } = this.options;
    const extracted = error
      ? null
      : kind === 'scan'
        ? scanToPoints(message as ScanMessage, maxPoints, channel)
        : cloudToPoints(message as PointCloud2Message, maxPoints, channel);
    const { data, layout } = packPoints(extracted?.positions ?? new Float32Array(0), extracted?.count ?? 0, extracted?.channel ?? null);
    const source =
      kind === 'scan'
        ? (message as ScanMessage).ranges.length
        : (message as PointCloud2Message).width * (message as PointCloud2Message).height;
    this.description =
      extracted && extracted.count < source
        ? `${extracted.count} of ${source} points, in ${frameId}`
        : `${extracted?.count ?? 0} points, in ${frameId}`;
    const meta: PointsInfo = { ...layout, frameId, pose, error, source };
    return {
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      format: POINTS_FORMAT as 2,
      width: 0,
      height: 0,
      meta,
    };
  }
}
