// The points the Robot Viewer draws, from a laser scan (sensor_msgs/LaserScan)
// or a point cloud (sensor_msgs/PointCloud2), in the message's own frame:
// thinned to at most maxPoints, evenly through the message, as a page draws
// them and does not measure them. With each point, its intensity or colour if
// asked for and the message has them. Packed by packPoints (shared/points.ts).

import type { PointsChannel } from '../shared/protocol.ts';
import type { LaserScanMessage } from './overlay_encoding.ts';

export interface ScanMessage extends LaserScanMessage {
  intensities?: ArrayLike<number>;
}

export interface PointFieldMessage {
  name: string;
  offset: number;
  datatype: number;
  count: number;
}

export interface PointCloud2Message {
  header: { frame_id: string };
  height: number;
  width: number;
  fields: PointFieldMessage[];
  is_bigendian: boolean;
  point_step: number;
  row_step: number;
  data: Uint8Array | number[];
}

export interface ExtractedPoints {
  // x, y, z per point
  positions: Float32Array;
  count: number;
  channel: { kind: 'intensity'; values: Float32Array } | { kind: 'rgb'; values: Uint8Array } | null;
  // Points in the message, with or without a return
  source: number;
}

// sensor_msgs/PointField's datatypes
const INT8 = 1;
const UINT8 = 2;
const INT16 = 3;
const UINT16 = 4;
const INT32 = 5;
const UINT32 = 6;
const FLOAT32 = 7;
const FLOAT64 = 8;

// The names clouds give their intensities, by drivers' habits
const INTENSITY_FIELDS = ['intensity', 'i', 'reflectivity', 'luminance'];

export function scanToPoints(scan: ScanMessage, maxPoints: number, channel: PointsChannel): ExtractedPoints {
  const count = scan.ranges.length;
  const step = Math.max(1, Math.ceil(count / Math.max(1, maxPoints)));
  const withIntensity =
    (channel === 'auto' || channel === 'intensity') && scan.intensities !== undefined && scan.intensities.length === count;
  const capacity = Math.ceil(count / step);
  const positions = new Float32Array(capacity * 3);
  const values = new Float32Array(withIntensity ? capacity : 0);
  let n = 0;
  for (let i = 0; i < count; i += step) {
    const range = scan.ranges[i];
    if (!Number.isFinite(range) || range < scan.range_min || range > scan.range_max) {
      continue;
    }
    const angle = scan.angle_min + i * scan.angle_increment;
    positions[n * 3] = range * Math.cos(angle);
    positions[n * 3 + 1] = range * Math.sin(angle);
    positions[n * 3 + 2] = 0;
    if (withIntensity) {
      const intensity = scan.intensities![i];
      values[n] = Number.isFinite(intensity) ? intensity : 0;
    }
    n++;
  }
  return {
    positions: positions.subarray(0, n * 3),
    count: n,
    channel: withIntensity ? { kind: 'intensity', values: values.subarray(0, n) } : null,
    source: count,
  };
}

type Reader = (view: DataView, offset: number) => number;

function reader(datatype: number, little: boolean): Reader | null {
  switch (datatype) {
    case INT8:
      return (view, offset) => view.getInt8(offset);
    case UINT8:
      return (view, offset) => view.getUint8(offset);
    case INT16:
      return (view, offset) => view.getInt16(offset, little);
    case UINT16:
      return (view, offset) => view.getUint16(offset, little);
    case INT32:
      return (view, offset) => view.getInt32(offset, little);
    case UINT32:
      return (view, offset) => view.getUint32(offset, little);
    case FLOAT32:
      return (view, offset) => view.getFloat32(offset, little);
    case FLOAT64:
      return (view, offset) => view.getFloat64(offset, little);
    default:
      return null;
  }
}

function toBytes(data: Uint8Array | number[]): Uint8Array {
  return data instanceof Uint8Array ? data : Uint8Array.from(data);
}

export function cloudToPoints(cloud: PointCloud2Message, maxPoints: number, channel: PointsChannel): ExtractedPoints {
  const little = !cloud.is_bigendian;
  const field = (name: string) => cloud.fields.find((f) => f.name === name);
  const axes = ['x', 'y', 'z'].map((name) => {
    const f = field(name);
    const read = f ? reader(f.datatype, little) : null;
    return f && read ? { offset: f.offset, read } : null;
  });
  if (axes.some((axis) => axis === null)) {
    throw new Error('The cloud has no x, y and z fields of a number type');
  }
  const [x, y, z] = axes as { offset: number; read: Reader }[];
  const rgbField = field('rgb') ?? field('rgba');
  const intensityField = INTENSITY_FIELDS.map(field).find((f) => f && reader(f.datatype, little));
  const kind: 'rgb' | 'intensity' | null =
    (channel === 'auto' || channel === 'rgb') && rgbField
      ? 'rgb'
      : (channel === 'auto' || channel === 'intensity') && intensityField
        ? 'intensity'
        : null;
  const readIntensity = intensityField ? reader(intensityField.datatype, little) : null;

  const data = toBytes(cloud.data);
  const total = cloud.width * cloud.height;
  if (total > 0 && data.byteLength < (cloud.height - 1) * cloud.row_step + cloud.width * cloud.point_step) {
    throw new Error(`The cloud's data is ${data.byteLength} bytes, too short for ${cloud.width}×${cloud.height} points`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const step = Math.max(1, Math.ceil(total / Math.max(1, maxPoints)));
  const capacity = Math.ceil(total / step);
  const positions = new Float32Array(capacity * 3);
  const intensities = new Float32Array(kind === 'intensity' ? capacity : 0);
  const colors = new Uint8Array(kind === 'rgb' ? capacity * 3 : 0);
  let n = 0;
  for (let i = 0; i < total; i += step) {
    const base = Math.floor(i / cloud.width) * cloud.row_step + (i % cloud.width) * cloud.point_step;
    const px = x.read(view, base + x.offset);
    const py = y.read(view, base + y.offset);
    const pz = z.read(view, base + z.offset);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
      continue;
    }
    positions[n * 3] = px;
    positions[n * 3 + 1] = py;
    positions[n * 3 + 2] = pz;
    if (kind === 'rgb') {
      // Packed in 4 bytes, as PCL does, whether a float or an integer
      const packed = view.getUint32(base + rgbField!.offset, little);
      colors[n * 3] = (packed >> 16) & 0xff;
      colors[n * 3 + 1] = (packed >> 8) & 0xff;
      colors[n * 3 + 2] = packed & 0xff;
    } else if (kind === 'intensity') {
      const value = readIntensity!(view, base + intensityField!.offset);
      intensities[n] = Number.isFinite(value) ? value : 0;
    }
    n++;
  }
  return {
    positions: positions.subarray(0, n * 3),
    count: n,
    channel:
      kind === 'rgb'
        ? { kind, values: colors.subarray(0, n * 3) }
        : kind === 'intensity'
          ? { kind, values: intensities.subarray(0, n) }
          : null,
    source: total,
  };
}
