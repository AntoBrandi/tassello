import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compressedToImage, rawToPixels, UnsupportedImageError, type RawImage } from './image_encoding.ts';

function image(encoding: string, width: number, height: number, step: number, data: number[]): RawImage {
  return { encoding, width, height, step, is_bigendian: 0, data: Uint8Array.from(data) };
}

test('rgb8 without padding is passed through', () => {
  const pixels = rawToPixels(image('rgb8', 2, 1, 6, [1, 2, 3, 4, 5, 6]));
  assert.equal(pixels.channels, 3);
  assert.deepEqual([...pixels.data], [1, 2, 3, 4, 5, 6]);
});

test('bgr8 rows lose their padding and swap red and blue', () => {
  // 2x2, step 8: 2 bytes of padding per row
  const pixels = rawToPixels(image('bgr8', 2, 2, 8, [1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 9, 10, 11, 12, 0, 0]));
  assert.deepEqual([...pixels.data], [3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]);
});

test('bgra8 keeps alpha', () => {
  const pixels = rawToPixels(image('bgra8', 1, 1, 4, [1, 2, 3, 4]));
  assert.equal(pixels.channels, 4);
  assert.deepEqual([...pixels.data], [3, 2, 1, 4]);
});

test('mono16 keeps the high byte, big or little endian', () => {
  assert.deepEqual([...rawToPixels(image('mono16', 2, 1, 4, [0x34, 0x12, 0xff, 0xff])).data], [0x12, 0xff]);
  const bigEndian = { ...image('mono16', 1, 1, 2, [0x12, 0x34]), is_bigendian: 1 };
  assert.deepEqual([...rawToPixels(bigEndian).data], [0x12]);
});

test('16UC1 depth is scaled to its farthest point', () => {
  // 1000 and 2000 mm, little endian
  const pixels = rawToPixels(image('16UC1', 2, 1, 4, [0xe8, 0x03, 0xd0, 0x07]));
  assert.deepEqual([...pixels.data], [128, 255]);
});

test('32FC1 depth is scaled, invalid values black', () => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setFloat32(0, 1, true);
  view.setFloat32(4, 2, true);
  view.setFloat32(8, Number.NaN, true);
  const pixels = rawToPixels({ encoding: '32FC1', width: 3, height: 1, step: 12, is_bigendian: 0, data });
  assert.deepEqual([...pixels.data], [128, 255, 0]);
});

test('YUYV and UYVY give the same colours', () => {
  // White then black, gray: Y 235 and 16, U = V = 128
  const yuyv = rawToPixels(image('yuv422_yuy2', 2, 1, 4, [235, 128, 16, 128]));
  const uyvy = rawToPixels(image('yuv422', 2, 1, 4, [128, 235, 128, 16]));
  assert.deepEqual([...yuyv.data], [255, 255, 255, 0, 0, 0]);
  assert.deepEqual([...uyvy.data], [...yuyv.data]);
});

test('YUYV red', () => {
  // BT.601 limited range red: Y 81, U 90, V 240
  const [r, g, b] = rawToPixels(image('yuyv', 2, 1, 4, [81, 90, 81, 240])).data;
  assert.ok(r > 250 && g < 5 && b < 5, `got ${r},${g},${b}`);
});

test('unknown encodings and short data are refused', () => {
  assert.throws(() => rawToPixels(image('bayer_rggb8', 2, 2, 2, [0, 0, 0, 0])), UnsupportedImageError);
  assert.throws(() => rawToPixels(image('rgb8', 2, 2, 6, [0, 0, 0])), UnsupportedImageError);
});

test('compressed images are recognized by their content', () => {
  const jpeg = compressedToImage('jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1]));
  assert.equal(jpeg.format, 0);
  const png = compressedToImage('png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]));
  assert.equal(png.format, 1);
  const depth = compressedToImage('16UC1; compressedDepth', Uint8Array.from([...new Array(12).fill(0), 0x89, 0x50, 0x4e, 0x47]));
  assert.equal(depth.format, 1);
  assert.equal(depth.data.length, 4);
  assert.throws(() => compressedToImage('theora', Uint8Array.from([1, 2, 3, 4])), UnsupportedImageError);
});
