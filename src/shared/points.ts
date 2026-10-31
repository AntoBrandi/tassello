// The points of a points frame (POINTS_FORMAT, see protocol.ts), as the
// server packs them and the page unpacks them: little endian, positions first,
// then what each point carries.
//
//   i16 x, y, z per point          (position = offset + value * scale)
//   then, per point, the channel's: u8 intensity (min + value / 255 * (max - min))
//                                   u8 r, g, b
//
// Quantized to 16 bits about the points' centre: a millimetre or two over a
// lidar's 100 m, 6 bytes a point instead of 12.

export type PointsChannelKind = 'intensity' | 'rgb';

export interface PointsLayout {
  count: number;
  offset: [number, number, number];
  // Meters per unit of the positions
  scale: number;
  channel: PointsChannelKind | null;
  // Of the intensities: min and max, which 0 and 255 stand for
  range: [number, number];
}

export interface Points {
  // x, y, z per point, in meters
  positions: Float32Array;
  // 0-1 per point, from the range's min to its max: intensities
  values: Float32Array | null;
  // r, g, b per point: colours
  colors: Uint8Array | null;
  range: [number, number];
}

const MAX_UNIT = 32767;

function bytesPerPoint(channel: PointsChannelKind | null): number {
  return 6 + (channel === 'intensity' ? 1 : channel === 'rgb' ? 3 : 0);
}

// positions: x, y, z of count points, finite; values: an intensity per point,
// or r, g, b per point
export function packPoints(
  positions: Float32Array,
  count: number,
  channel: { kind: 'intensity'; values: Float32Array } | { kind: 'rgb'; values: Uint8Array } | null,
): { data: Uint8Array; layout: PointsLayout } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i * 3 + axis];
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  const offset: [number, number, number] = count > 0 ? [0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number] : [0, 0, 0];
  const half = count > 0 ? Math.max(...[0, 1, 2].map((a) => (max[a] - min[a]) / 2)) : 0;
  const scale = half > 0 ? half / MAX_UNIT : 1e-6;
  const data = new Uint8Array(count * bytesPerPoint(channel?.kind ?? null));
  const view = new DataView(data.buffer);
  for (let i = 0; i < count * 3; i++) {
    view.setInt16(i * 2, Math.round((positions[i] - offset[i % 3]) / scale), true);
  }
  let range: [number, number] = [0, 0];
  const start = count * 6;
  if (channel?.kind === 'intensity') {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = channel.values[i];
      if (v < low) low = v;
      if (v > high) high = v;
    }
    range = count > 0 ? [low, high] : [0, 0];
    const span = high - low;
    for (let i = 0; i < count; i++) {
      data[start + i] = span > 0 ? Math.round(((channel.values[i] - low) / span) * 255) : 0;
    }
  } else if (channel?.kind === 'rgb') {
    data.set(channel.values.subarray(0, count * 3), start);
  }
  return { data, layout: { count, offset, scale, channel: channel?.kind ?? null, range } };
}

export function unpackPoints(data: ArrayBuffer | Uint8Array, layout: PointsLayout): Points {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const { count, offset, scale, channel } = layout;
  if (bytes.byteLength < count * bytesPerPoint(channel)) {
    throw new Error(`Points frame of ${bytes.byteLength} bytes, for ${count} points`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    positions[i] = offset[i % 3] + view.getInt16(i * 2, true) * scale;
  }
  const start = count * 6;
  let values: Float32Array | null = null;
  let colors: Uint8Array | null = null;
  if (channel === 'intensity') {
    values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = bytes[start + i] / 255;
    }
  } else if (channel === 'rgb') {
    colors = bytes.slice(start, start + count * 3);
  }
  return { positions, values, colors, range: layout.range };
}
