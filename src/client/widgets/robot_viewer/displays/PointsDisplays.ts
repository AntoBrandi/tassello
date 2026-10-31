// A laser scan and a point cloud, where TF put their frames as each message
// arrived: their points thinned and placed on the robot (the points stream),
// drawn by a PointsLayer. Asked for again in a new fixed frame.

import type { PointsChannel, PointsKind } from '../../../../shared/protocol.ts';
import { Display, type DisplayContext } from '../display.ts';
import type { LaserScanDisplayConfig, PointCloudDisplayConfig } from './index.ts';
import { PointsLayer, type PointsColoring } from './points.ts';

// A scan's returns: more than lidars have
const MAX_SCAN_POINTS = 4000;

interface PointsConfig {
  topic: string;
  colorBy: PointsColoring;
  color: string;
  size: number;
  maxRate: number;
}

// What the server sends with each point: nothing for a colour or heights
function channelOf(coloring: PointsColoring): PointsChannel {
  return coloring === 'auto' || coloring === 'rgb' || coloring === 'intensity' ? coloring : 'none';
}

// Of points from the points stream: extend it for another kind of points'
// colours or sizes, or use PointsLayer for points of your own
export abstract class PointsDisplay<C extends PointsConfig> extends Display<C> {
  protected readonly layer = new PointsLayer();
  private config: C | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(context: DisplayContext) {
    super(context);
    this.root.add(this.layer.object);
  }

  protected abstract kind(): PointsKind;
  protected abstract maxPoints(config: C): number;

  configure(config: C, previous: C | null): void {
    this.config = config;
    this.layer.setStyle({ coloring: config.colorBy, color: config.color, size: config.size }, this.context.pixelRatio);
    if (
      !previous ||
      config.topic !== previous.topic ||
      config.maxRate !== previous.maxRate ||
      this.maxPoints(config) !== this.maxPoints(previous) ||
      channelOf(config.colorBy) !== channelOf(previous.colorBy)
    ) {
      this.subscribe();
    }
    this.render();
  }

  onFixedFrameChange(): void {
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.layer.setFrame(null);
    this.render();
    const config = this.config;
    const topic = config?.topic.trim();
    if (!config || !topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    if (!this.fixedFrame) {
      this.setStatus('waiting', 'Waiting for a fixed frame');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    let current = true;
    const unsubscribe = this.connection.subscribePoints(
      {
        kind: this.kind(),
        topic,
        fixedFrame: this.fixedFrame,
        maxPoints: this.maxPoints(config),
        channel: channelOf(config.colorBy),
        maxFps: config.maxRate,
      },
      {
        status: (state, message) => {
          if (state !== 'streaming') {
            this.setStatus(state, message);
          }
        },
        points: (frame) => {
          if (!current) {
            return;
          }
          this.layer.setFrame(frame);
          if (frame.info.error) {
            this.setStatus('warn', frame.info.error);
          } else {
            this.setStatus('ok');
          }
          this.render();
        },
      },
    );
    this.unsubscribe = this.context.track(() => {
      current = false;
      unsubscribe();
    });
  }
}

export class LaserScanDisplay extends PointsDisplay<LaserScanDisplayConfig> {
  protected kind(): PointsKind {
    return 'scan';
  }

  protected maxPoints(): number {
    return MAX_SCAN_POINTS;
  }
}

export class PointCloudDisplay extends PointsDisplay<PointCloudDisplayConfig> {
  protected kind(): PointsKind {
    return 'cloud';
  }

  protected maxPoints(config: PointCloudDisplayConfig): number {
    return Math.round(config.maxPoints);
  }
}
