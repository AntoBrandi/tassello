import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyUpdate, renderGrid } from './grid_encoding.ts';

test('maps: free light, occupied dark, unknown transparent', () => {
  const { data, channels } = renderGrid({ width: 4, height: 1, data: Int8Array.from([0, 100, -1, 50]) }, 'map');
  assert.equal(channels, 2);
  const [freeGray, freeAlpha, occupiedGray, , , unknownAlpha, halfGray] = data;
  assert.equal(freeAlpha, 255);
  assert.ok(freeGray > 200 && occupiedGray < 50, `${freeGray} ${occupiedGray}`);
  assert.equal(unknownAlpha, 0);
  assert.ok(halfGray > occupiedGray && halfGray < freeGray);
});

test('costmaps: free and unknown transparent, inscribed and lethal opaque', () => {
  const { data, channels } = renderGrid(
    { width: 5, height: 1, data: Int8Array.from([0, -1, 50, 99, 100]) },
    'costmap',
  );
  assert.equal(channels, 4);
  const alpha = (cell: number) => data[cell * 4 + 3];
  assert.equal(alpha(0), 0);
  assert.equal(alpha(1), 0);
  assert.ok(alpha(2) > 0 && alpha(2) < alpha(3) && alpha(3) < alpha(4));
});

test('the known cells are bounded', () => {
  const grid = { width: 4, height: 3, data: Int8Array.from([-1, -1, -1, -1, -1, 0, 100, -1, -1, -1, 50, -1]) };
  assert.deepEqual(renderGrid(grid, 'map').known, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(renderGrid({ width: 1, height: 1, data: Int8Array.from([-1]) }, 'map').known, null);
});

test('grids smaller than their size are refused', () => {
  assert.throws(() => renderGrid({ width: 2, height: 2, data: new Int8Array(3) }, 'map'));
});

test('updates are copied in place, if they fit', () => {
  const grid = { width: 3, height: 3, data: new Int8Array(9) };
  assert.ok(applyUpdate(grid, { x: 1, y: 1, width: 2, height: 2, data: Int8Array.from([1, 2, 3, 4]) }));
  assert.deepEqual([...grid.data], [0, 0, 0, 0, 1, 2, 0, 3, 4]);
  assert.equal(applyUpdate(grid, { x: 2, y: 2, width: 2, height: 1, data: Int8Array.from([5, 6]) }), false);
});
