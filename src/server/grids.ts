// OccupancyGrid topics for the navigation widgets: maps and costmaps, drawn
// into PNG images that carry where they lie (GridInfo). Kept up to date with
// the map_msgs/OccupancyGridUpdate of <topic>_updates, as Nav2's costmaps
// publish them unless always_send_full_costmap.

import rclnodejs from 'rclnodejs';
import sharp from 'sharp';

import type { GridInfo, GridSubscribe } from '../shared/protocol.ts';
import { FrameStream } from './frame_stream.ts';
import { applyUpdate, renderGrid, type Grid } from './grid_encoding.ts';
import { publishersQos } from './qos.ts';
import { yawOf } from './transforms.ts';
import { absoluteTopic, type Logger } from './util.ts';

const OCCUPANCY_GRID = 'nav_msgs/msg/OccupancyGrid';
const GRID_UPDATE = 'map_msgs/msg/OccupancyGridUpdate';

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

export type GridOptions = Omit<GridSubscribe, 'type' | 'id'>;

export function gridStreamKey(options: GridOptions): string {
  return JSON.stringify(['grid', options.topic, options.style]);
}

interface OccupancyGrid {
  header: { frame_id: string };
  info: {
    width: number;
    height: number;
    resolution: number;
    origin: {
      position: { x: number; y: number };
      orientation: { x: number; y: number; z: number; w: number };
    };
  };
  data: Int8Array | number[];
}

function toInt8(data: Int8Array | number[]): Int8Array {
  return data instanceof Int8Array ? data : Int8Array.from(data);
}

export class GridStream extends FrameStream {
  private readonly options: GridOptions;
  private grid: (Grid & { info: GridInfo }) | null = null;

  constructor(node: rclnodejs.Node, logger: Logger, options: GridOptions) {
    super(node, logger, `Grid stream ${options.topic}`);
    this.options = options;
    this.retryUntil(() => this.subscribeGrid(absoluteTopic(options.topic)));
  }

  // Waits for a publisher, to subscribe with a QoS matching it: maps are
  // usually latched
  private subscribeGrid(topic: string): boolean {
    const match = publishersQos(this.node, topic, OCCUPANCY_GRID, 1);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      return false;
    }
    if (!this.subscribe(OCCUPANCY_GRID, topic, match.qos, (msg) => this.onGrid(msg as OccupancyGrid))) {
      return true;
    }
    // Volatile: an update older than the grid would be wrong
    const updatesQos = new rclnodejs.QoS(
      HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
      10,
      ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
      DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
    );
    this.subscribe(GRID_UPDATE, `${topic}_updates`, updatesQos, (msg) => this.onUpdate(msg), true);
    this.setState('waiting', `Waiting for ${topic}`);
    return true;
  }

  private onGrid(msg: OccupancyGrid): void {
    const { info } = msg;
    this.grid = {
      width: info.width,
      height: info.height,
      data: toInt8(msg.data),
      info: {
        frameId: msg.header.frame_id.replace(/^\//, ''),
        width: info.width,
        height: info.height,
        resolution: info.resolution,
        originX: info.origin.position.x,
        originY: info.origin.position.y,
        originYaw: yawOf(info.origin.orientation),
        known: null,
      },
    };
    this.description = `${info.width}×${info.height} cells of ${+info.resolution.toFixed(3)} m`;
    this.offerGrid();
  }

  private onUpdate(msg: unknown): void {
    const update = msg as { x: number; y: number; width: number; height: number; data: Int8Array | number[] };
    if (this.grid && applyUpdate(this.grid, { ...update, data: toInt8(update.data) })) {
      this.offerGrid();
    }
  }

  // The grid as it is when a page is ready for it
  private offerGrid(): void {
    const grid = this.grid!;
    this.offer(async () => {
      const pixels = renderGrid(grid, this.options.style);
      const data = await sharp(pixels.data, {
        raw: { width: grid.width, height: grid.height, channels: pixels.channels },
      })
        // Fast rather than small: maps compress well anyway
        .png({ compressionLevel: 3 })
        .toBuffer();
      return {
        data,
        format: 1,
        width: grid.width,
        height: grid.height,
        meta: { ...grid.info, known: pixels.known },
      };
    });
  }
}
