// A polygon (geometry_msgs/PolygonStamped), e.g. Nav2's footprint
// (published_footprint), where TF puts its frame: its outline, closed.

import { Group } from 'three';

import { Display, type DisplayContext } from '../display.ts';
import type { PolygonDisplayConfig } from './index.ts';
import { LinesLayer } from './lines.ts';

const POLYGON_STAMPED = 'geometry_msgs/msg/PolygonStamped';

interface PolygonStamped {
  header: { frame_id: string };
  polygon: { points: { x: number; y: number; z?: number }[] };
}

export class PolygonDisplay extends Display<PolygonDisplayConfig> {
  // Where TF puts the polygon's frame
  protected readonly holder = new Group();
  protected readonly lines = new LinesLayer();
  private unsubscribe: (() => void) | null = null;
  private frameId = '';

  constructor(context: DisplayContext) {
    super(context);
    this.holder.add(this.lines.object);
    this.root.add(this.holder);
  }

  configure(config: PolygonDisplayConfig, previous: PolygonDisplayConfig | null): void {
    this.lines.setStyle({ color: config.color, width: config.width, opacity: config.alpha });
    if (config.topic !== previous?.topic) {
      this.subscribe(config.topic.trim());
    }
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  private subscribe(topic: string): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frameId = '';
    this.lines.setSegments([]);
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    this.setStatus('waiting', `Waiting for ${topic}`);
    this.unsubscribe = this.subscribeTopic<PolygonStamped>(topic, { types: [POLYGON_STAMPED] }, (message) => {
      this.lines.setPolyline(
        message.polygon.points.flatMap((p) => [p.x, p.y, p.z ?? 0]),
        true,
      );
      if (message.header.frame_id !== this.frameId) {
        this.frameId = message.header.frame_id;
        this.attach(this.holder, this.frameId);
      }
      this.updateStatus();
      this.render();
    });
  }

  private updateStatus(): void {
    if (!this.frameId) {
      return;
    }
    if (this.pose(this.frameId)) {
      this.setStatus('ok');
    } else {
      this.setStatus('warn', this.missingFrame(this.frameId));
    }
  }
}
