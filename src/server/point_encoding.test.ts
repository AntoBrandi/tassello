import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packPoints, unpackPoints } from '../shared/points.ts';
import { cloudToPoints, scanToPoints, type PointCloud2Message, type PointFieldMessage } from './point_encoding.ts';

const FLOAT32 = 7;
const UINT8 = 2;

function scan(ranges: number[], intensities?: number[]) {
  return {
    header: { frame_id: 'laser' },
    angle_min: 0,
    angle_increment: Math.PI / 2,
    range_min: 0.1,
    range_max: 10,
    ranges,
    intensities,
  };
}

function close(actual: ArrayLike<number>, expected: number[], tolerance = 1e-6): void {
  assert.equal(actual.length, expected.length, `${Array.from(actual)} != ${expected}`);
  expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < tolerance, `[${i}] ${actual[i]} != ${v}`));
}

test('a scan: its returns in its frame, those out of range or not finite left out', () => {
  const points = scanToPoints(scan([1, 0.05, Infinity, 2], [10, 20, 30, 40]), 100, 'auto');
  assert.equal(points.count, 2);
  assert.equal(points.source, 4);
  close(points.positions, [1, 0, 0, 0, -2, 0]);
  assert.deepEqual(points.channel?.kind, 'intensity');
  close(points.channel!.values, [10, 40]);
  // Not asked for, or not one per range
  assert.equal(scanToPoints(scan([1, 2, 3, 4], [1, 2, 3, 4]), 100, 'none').channel, null);
  assert.equal(scanToPoints(scan([1, 2, 3, 4], []), 100, 'intensity').channel, null);
});

test('a scan is thinned evenly to the points asked for', () => {
  const points = scanToPoints(scan([1, 1, 1, 1, 1, 1, 1, 1]), 3, 'none');
  // Every third: 0, 3 and 6, at 0, 3π/2 and 3π
  assert.equal(points.count, 3);
  close(points.positions, [1, 0, 0, 0, -1, 0, -1, 0, 0]);
});

// A cloud of points of x, y, z (float32) then the given fields, `padding`
// bytes at the end of each row
function cloud(
  rows: number[][][],
  extra: { field: PointFieldMessage; write: (view: DataView, offset: number, value: number, little: boolean) => void }[] = [],
  { bigEndian = false, padding = 0 } = {},
): PointCloud2Message {
  const fields: PointFieldMessage[] = [
    { name: 'x', offset: 0, datatype: FLOAT32, count: 1 },
    { name: 'y', offset: 4, datatype: FLOAT32, count: 1 },
    { name: 'z', offset: 8, datatype: FLOAT32, count: 1 },
    ...extra.map((e) => e.field),
  ];
  const pointStep = 16;
  const width = rows[0].length;
  const rowStep = width * pointStep + padding;
  const data = new Uint8Array(rowStep * rows.length);
  const view = new DataView(data.buffer);
  rows.forEach((row, r) =>
    row.forEach((point, c) => {
      const base = r * rowStep + c * pointStep;
      point.slice(0, 3).forEach((v, axis) => view.setFloat32(base + axis * 4, v, !bigEndian));
      extra.forEach((e, i) => e.write(view, base + e.field.offset, point[3 + i], !bigEndian));
    }),
  );
  return {
    header: { frame_id: 'camera' },
    height: rows.length,
    width,
    fields,
    is_bigendian: bigEndian,
    point_step: pointStep,
    row_step: rowStep,
    data,
  };
}

const intensity = {
  field: { name: 'intensity', offset: 12, datatype: FLOAT32, count: 1 },
  write: (view: DataView, offset: number, value: number, little: boolean) => view.setFloat32(offset, value, little),
};
// PCL's packed colour: 0x00RRGGBB in a float's bytes
const rgb = {
  field: { name: 'rgb', offset: 12, datatype: FLOAT32, count: 1 },
  write: (view: DataView, offset: number, value: number, little: boolean) => view.setUint32(offset, value, little),
};

test('a cloud: x, y, z of its rows, padded or not, NaN left out', () => {
  const organized = cloud(
    [
      [[1, 2, 3, 5], [NaN, NaN, NaN, 0]],
      [[4, 5, 6, 7], [7, 8, 9, 1]],
    ],
    [intensity],
    { padding: 8 },
  );
  const points = cloudToPoints(organized, 100, 'auto');
  assert.equal(points.count, 3);
  assert.equal(points.source, 4);
  close(points.positions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(points.channel?.kind, 'intensity');
  close(points.channel!.values, [5, 7, 1]);
  assert.equal(cloudToPoints(organized, 100, 'rgb').channel, null);
});

test('a cloud: its packed colours, in either byte order', () => {
  for (const bigEndian of [false, true]) {
    const points = cloudToPoints(cloud([[[1, 0, 0, 0xff8000], [0, 1, 0, 0x0000ff]]], [rgb], { bigEndian }), 100, 'auto');
    assert.equal(points.channel?.kind, 'rgb');
    assert.deepEqual(Array.from(points.channel!.values), [255, 128, 0, 0, 0, 255]);
    close(points.positions, [1, 0, 0, 0, 1, 0]);
  }
});

test('a cloud is thinned to the points asked for, and must have x, y and z', () => {
  const row = Array.from({ length: 10 }, (_, i) => [i, 0, 0]);
  assert.equal(cloudToPoints(cloud([row]), 4, 'none').count, 4);
  close(cloudToPoints(cloud([row]), 4, 'none').positions.filter((_, i) => i % 3 === 0), [0, 3, 6, 9]);
  const flat = { ...cloud([row]), fields: [{ name: 'x', offset: 0, datatype: FLOAT32, count: 1 }] };
  assert.throws(() => cloudToPoints(flat, 10, 'none'), /no x, y and z/);
  const short = { ...cloud([row]), data: new Uint8Array(20) };
  assert.throws(() => cloudToPoints(short, 10, 'none'), /too short/);
  const bytes = { ...cloud([row]), fields: [...cloud([row]).fields, { name: 'i', offset: 12, datatype: UINT8, count: 1 }] };
  assert.equal(cloudToPoints(bytes, 10, 'auto').channel?.kind, 'intensity');
});

test('points packed and unpacked: within a millimetre, intensities over their range', () => {
  const positions = new Float32Array([1, 2, 3, -40, 0.5, 0, 60, -2, 1.25]);
  const { data, layout } = packPoints(positions, 3, { kind: 'intensity', values: new Float32Array([10, 20, 15]) });
  assert.equal(data.byteLength, 3 * 7);
  assert.deepEqual(layout.range, [10, 20]);
  const points = unpackPoints(data.slice().buffer, layout);
  close(points.positions, Array.from(positions), 2e-3);
  close(points.values!, [0, 1, 0.5], 1 / 255);
  assert.equal(points.colors, null);

  const colored = packPoints(new Float32Array([0, 0, 0, 1, 1, 1]), 2, { kind: 'rgb', values: new Uint8Array([1, 2, 3, 4, 5, 6]) });
  assert.deepEqual(Array.from(unpackPoints(colored.data, colored.layout).colors!), [1, 2, 3, 4, 5, 6]);
  // One point, or none
  close(unpackPoints(...Object.values(packPoints(new Float32Array([5, 6, 7]), 1, null)) as [Uint8Array, never]).positions, [5, 6, 7], 1e-5);
  assert.equal(unpackPoints(new Uint8Array(0), packPoints(new Float32Array(0), 0, null).layout).positions.length, 0);
  assert.throws(() => unpackPoints(new Uint8Array(4), layout), /for 3 points/);
});
