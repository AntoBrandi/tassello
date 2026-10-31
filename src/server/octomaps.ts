// Octomaps (octomap_msgs/Octomap) for the Robot Viewer, as binary frames of
// their occupied voxels (POINTS_FORMAT, with an OctomapInfo): decoded on the
// server, which sends a page the latest map once it drew the previous one. In
// the map's frame, which the page places by TF: maps come seldom, and stay
// where they are.

import type rclnodejs from 'rclnodejs';

import { packPoints } from '../shared/points.ts';
import { POINTS_FORMAT, type OctomapInfo, type OctomapSubscribe } from '../shared/protocol.ts';
import { FrameStream, type EncodedFrame } from './frame_stream.ts';
import { octomapToVoxels, type OctomapMessage, type Voxels } from './octomap_encoding.ts';
import { publishersQos } from './qos.ts';
import { normalizeFrame } from './transforms.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const OCTOMAP = 'octomap_msgs/msg/Octomap';

export type OctomapOptions = Omit<OctomapSubscribe, 'type' | 'id'>;

export function octomapStreamKey(options: OctomapOptions): string {
  return JSON.stringify(['octomap', options.topic, options.maxDepth, options.maxVoxels]);
}

export class OctomapStream extends FrameStream {
  private readonly options: OctomapOptions;
  private readonly topic: string;

  constructor(node: rclnodejs.Node, logger: Logger, options: OctomapOptions) {
    super(node, logger, `Octomap stream ${options.topic}`);
    this.options = options;
    this.topic = absoluteTopic(options.topic);
    this.retryUntil(() => this.subscribeMap());
  }

  // Waits for a publisher, to subscribe with a QoS matching it: octomap_server
  // latches its maps
  private subscribeMap(): boolean {
    const match = publishersQos(this.node, this.topic, OCTOMAP, 1);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      return false;
    }
    if (this.subscribe(OCTOMAP, this.topic, match.qos, (message) => this.onMessage(message as OctomapMessage))) {
      this.setState('waiting', `Waiting for messages on ${this.topic}`);
    }
    return true;
  }

  private onMessage(message: OctomapMessage): void {
    this.offer(async () => this.encode(message));
  }

  private encode(message: OctomapMessage): EncodedFrame {
    const frameId = normalizeFrame(message.header.frame_id);
    const tree = message.id || 'OcTree';
    let voxels: Voxels | null = null;
    let error: string | null = null;
    try {
      voxels = octomapToVoxels(message, this.options.maxDepth, this.options.maxVoxels);
    } catch (e) {
      error = errorMessage(e);
    }
    const { data, layout } = packPoints(
      voxels?.positions ?? new Float32Array(0),
      voxels?.count ?? 0,
      voxels?.colors ? { kind: 'rgb', values: voxels.colors } : null,
    );
    const kind = message.binary ? 'binary' : 'full';
    this.description = !voxels
      ? `${kind} ${tree}`
      : voxels.count < voxels.source
        ? `${voxels.count} of ${voxels.source} voxels, ${kind} ${tree} in ${frameId}`
        : `${voxels.count} voxels, ${kind} ${tree} in ${frameId}`;
    const meta: OctomapInfo = {
      ...layout,
      frameId,
      levels: voxels?.levels ?? [],
      tree,
      resolution: message.resolution,
      source: voxels?.source ?? 0,
      error,
    };
    return { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), format: POINTS_FORMAT as 2, width: 0, height: 0, meta };
  }
}
