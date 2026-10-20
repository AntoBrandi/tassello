import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeNetpbm } from './netpbm.ts';

test('binary PGM maps decode, comments in the header skipped', () => {
  const header = Buffer.from('P5\n# CREATOR: map_saver.cpp 0.050 m/pix\n3 2\n255\n', 'latin1');
  const image = decodeNetpbm(Buffer.concat([header, Buffer.from([0, 205, 254, 254, 205, 0])]));
  assert.deepEqual({ ...image, data: [...image.data] }, { width: 3, height: 2, channels: 1, data: [0, 205, 254, 254, 205, 0] });
});

test('text and 16 bit images are scaled to 8 bit', () => {
  const text = decodeNetpbm(Buffer.from('P2 2 1 15\n0 15\n'));
  assert.deepEqual([...text.data], [0, 255]);
  const wide = decodeNetpbm(Buffer.concat([Buffer.from('P5 1 1 65535\n'), Buffer.from([0x80, 0x00])]));
  assert.deepEqual([...wide.data], [128]);
  const colour = decodeNetpbm(Buffer.from('P3 1 1 255 10 20 30'));
  assert.equal(colour.channels, 3);
  assert.deepEqual([...colour.data], [10, 20, 30]);
});

test('other files, and malformed or truncated images, are refused', () => {
  assert.throws(() => decodeNetpbm(Buffer.from('\x89PNG')), /Not a PGM/);
  assert.throws(() => decodeNetpbm(Buffer.from('P5\nx y\n255\n')), /Malformed/);
  assert.throws(() => decodeNetpbm(Buffer.from('P5 4 4 255\n\0\0')), /Truncated/);
  assert.throws(() => decodeNetpbm(Buffer.from('P5 0 4 255\n')), /Malformed/);
});
