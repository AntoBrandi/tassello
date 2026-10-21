// What the navigation widgets draw over the map, as they draw it: a laser
// scan's points (sensor_msgs/LaserScan), and a footprint's polygon
// (geometry_msgs/PolygonStamped, Nav2's published_footprint), put in another
// frame by a transform. In 3D: a lidar mounted upside down or tilted lands
// where it looks.

import { transformPoint, type Transform } from './transforms.ts';

// Denser scans are thinned out: a page draws them, it does not measure them
export const MAX_SCAN_POINTS = 1440;

export interface LaserScanMessage {
  header: { frame_id: string };
  angle_min: number;
  angle_increment: number;
  range_min: number;
  range_max: number;
  ranges: ArrayLike<number>;
}

export interface PolygonMessage {
  header: { frame_id: string };
  polygon: { points: { x: number; y: number; z: number }[] };
}

// Centimeters are enough for a scan, millimeters for a footprint, and keep
// the JSON short; -0 is 0
const centimeters = (value: number) => Math.round(value * 100) / 100 || 0;
const millimeters = (value: number) => Math.round(value * 1000) / 1000 || 0;

// The scan's points with a return, as x0, y0, x1, y1, ... in the frame the
// transform takes them to (the scan's frame's pose in it), at most maxPoints:
// those beyond its range limits, infinities and NaN are no returns
export function scanPoints(scan: LaserScanMessage, transform: Transform, maxPoints = MAX_SCAN_POINTS): number[] {
  const count = scan.ranges.length;
  const step = Math.max(1, Math.ceil(count / maxPoints));
  const points: number[] = [];
  for (let i = 0; i < count; i += step) {
    const range = scan.ranges[i];
    if (!Number.isFinite(range) || range < scan.range_min || range > scan.range_max) {
      continue;
    }
    const angle = scan.angle_min + i * scan.angle_increment;
    const p = transformPoint(transform, { x: range * Math.cos(angle), y: range * Math.sin(angle), z: 0 });
    points.push(centimeters(p.x), centimeters(p.y));
  }
  return points;
}

// The polygon's corners, as x0, y0, x1, y1, ... in the frame the transform
// takes them to
export function polygonPoints(polygon: PolygonMessage, transform: Transform): number[] {
  const points: number[] = [];
  for (const corner of polygon.polygon.points) {
    const p = transformPoint(transform, { x: corner.x, y: corner.y, z: corner.z });
    points.push(millimeters(p.x), millimeters(p.y));
  }
  return points;
}
