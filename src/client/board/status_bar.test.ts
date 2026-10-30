import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fits, movedBy } from './layouts.ts';
import { freePlace, placeStatus, STATUS_COLUMNS, STATUS_GAP, statusLayout, widened } from './status_bar.ts';

const widget = (id: string, x: number, w: number) => ({ id, type: 'cpu-status', x, w, config: {} });

test('the status widgets on the one row, within the columns', () => {
  const layout = statusLayout([widget('a', 0, 3), widget('b', 22, 4), widget('c', 5, 30)]);
  assert.deepEqual([...layout.rects], [
    ['a', { x: 0, y: 0, w: 3, h: 1 }],
    ['b', { x: 20, y: 0, w: 4, h: 1 }],
    ['c', { x: 0, y: 0, w: STATUS_COLUMNS, h: 1 }],
  ]);
  assert.deepEqual(placeStatus({ x: 2, y: 0, w: 3, h: 1 }, 50), { left: 100 + STATUS_GAP / 2, width: 150 - STATUS_GAP });
});

test("moved and resized as the board's widgets, never onto another", () => {
  const layout = statusLayout([widget('a', 0, 3), widget('b', 10, 4)]);
  const moved = (dx: number) => movedBy(new Map([['a', layout.rects.get('a')!]]), dx, 0, STATUS_COLUMNS);
  assert.equal(moved(5).get('a')!.x, 5);
  assert.equal(moved(-5).get('a')!.x, 0);
  assert.equal(moved(40).get('a')!.x, 21);
  assert.equal(fits(moved(5), layout, STATUS_COLUMNS), true);
  assert.equal(fits(moved(8), layout, STATUS_COLUMNS), false);

  const a = layout.rects.get('a')!;
  assert.equal(widened(a, 4, 1).w, 7);
  assert.equal(widened(a, -5, 2).w, 2);
  assert.equal(widened({ ...a, x: 20 }, 10, 1).w, 4);
  // Wider than the room left: as wide as it
  assert.equal(widened({ ...a, x: 23 }, 0, 3).w, 1);
});

test('a new status widget: after the one selected, else the first free place, else the widest', () => {
  const rects = statusLayout([widget('a', 0, 3), widget('b', 10, 4), widget('c', 20, 4)]).rects.values();
  assert.deepEqual(freePlace(rects, 3, 1), { x: 3, w: 3 });
  assert.deepEqual(freePlace(statusLayout([widget('a', 0, 3), widget('b', 10, 4)]).rects.values(), 3, 1, 14), { x: 14, w: 3 });
  // From past the end: from the left
  assert.deepEqual(freePlace(statusLayout([widget('a', 0, 3), widget('b', 21, 3)]).rects.values(), 3, 1, 24), { x: 3, w: 3 });
  // No room for its width: the widest, if wide enough
  const full = statusLayout([widget('a', 0, 10), widget('b', 12, 6), widget('c', 19, 5)]).rects;
  assert.deepEqual(freePlace(full.values(), 4, 1), { x: 10, w: 2 });
  assert.equal(freePlace(full.values(), 4, 3), null);
  assert.deepEqual(freePlace([], 30, 1), { x: 0, w: STATUS_COLUMNS });
});
