import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Panel, WidgetInstance } from '../../shared/panel.ts';
import { deviceFor, fits, layoutFor, withHidden, withoutLayout, withRect } from './layouts.ts';

const minSize = () => ({ w: 1, h: 2 });

function widget(id: string, x: number, y: number, w: number, h: number): WidgetInstance {
  return { id, type: 'test', title: '', x, y, w, h, config: {} };
}

// A desktop panel: a wide map, two cameras beside it, a button below
const panel: Panel = {
  id: 'p',
  name: 'P',
  widgets: [
    widget('button', 0, 10, 3, 1),
    widget('map', 0, 0, 12, 10),
    widget('camera1', 12, 0, 6, 4),
    widget('camera2', 12, 4, 6, 4),
  ],
};

test('devices by width', () => {
  assert.equal(deviceFor(390), 'phone');
  assert.equal(deviceFor(820), 'tablet');
  assert.equal(deviceFor(1440), 'desktop');
});

test('the desktop layout is the widgets own', () => {
  const layout = layoutFor(panel, 'desktop', minSize);
  assert.deepEqual(layout.rects.get('map'), { x: 0, y: 0, w: 12, h: 10 });
});

test('phones stack the widgets in reading order, narrowed to their columns', () => {
  const layout = layoutFor(panel, 'phone', minSize);
  assert.equal(layout.custom, false);
  assert.deepEqual(Object.fromEntries(layout.rects), {
    map: { x: 0, y: 0, w: 6, h: 5 },
    camera1: { x: 0, y: 5, w: 6, h: 4 },
    camera2: { x: 0, y: 9, w: 6, h: 4 },
    button: { x: 0, y: 13, w: 3, h: 1 },
  });
});

test('tablets keep what fits side by side', () => {
  const layout = layoutFor(panel, 'tablet', minSize);
  assert.deepEqual(layout.rects.get('map'), { x: 0, y: 0, w: 12, h: 10 });
  assert.deepEqual(layout.rects.get('camera1'), { x: 0, y: 10, w: 6, h: 4 });
  assert.deepEqual(layout.rects.get('camera2'), { x: 6, y: 10, w: 6, h: 4 });
});

test('moving a widget on a phone makes the shown layout its own', () => {
  const auto = layoutFor(panel, 'phone', minSize);
  const moved = withRect(panel, 'phone', auto, 'button', { x: 3, y: 13, w: 3, h: 1 });
  assert.deepEqual(moved.widgets, panel.widgets);
  assert.deepEqual(moved.layouts?.phone?.rects.camera1, { x: 0, y: 5, w: 6, h: 4 });
  const layout = layoutFor(moved, 'phone', minSize);
  assert.equal(layout.custom, true);
  assert.deepEqual(layout.rects.get('button'), { x: 3, y: 13, w: 3, h: 1 });
  // A widget added since goes after the others
  const added = { ...moved, widgets: [...moved.widgets, widget('new', 0, 0, 2, 2)] };
  assert.deepEqual(layoutFor(added, 'phone', minSize).rects.get('new'), { x: 0, y: 14, w: 2, h: 2 });
  assert.equal(layoutFor(withoutLayout(moved, 'phone'), 'phone', minSize).custom, false);
  assert.equal(withoutLayout(moved, 'phone').layouts, undefined);
});

test('hidden widgets are left out of the device, and come back', () => {
  // Automatic: the others close the gap, and it comes back in its place
  const auto = layoutFor(panel, 'phone', minSize);
  const hidden = withHidden(panel, 'phone', auto, 'map', true);
  const layout = layoutFor(hidden, 'phone', minSize);
  assert.equal(layout.rects.has('map'), false);
  assert.equal(layout.custom, false);
  assert.deepEqual(layout.hidden, ['map']);
  assert.deepEqual(layout.rects.get('camera1'), { x: 0, y: 0, w: 6, h: 4 });
  const shown = layoutFor(withHidden(hidden, 'phone', layout, 'map', false), 'phone', minSize);
  assert.deepEqual(shown.rects.get('map'), { x: 0, y: 0, w: 6, h: 5 });
  // Arranged: the others stay, and it comes back after them
  const arranged = withRect(panel, 'phone', auto, 'button', { x: 3, y: 13, w: 3, h: 1 });
  const arrangedLayout = layoutFor(withHidden(arranged, 'phone', layoutFor(arranged, 'phone', minSize), 'map', true), 'phone', minSize);
  assert.deepEqual(arrangedLayout.rects.get('camera1'), { x: 0, y: 5, w: 6, h: 4 });
  const back = layoutFor(
    withHidden(withHidden(arranged, 'phone', layoutFor(arranged, 'phone', minSize), 'map', true), 'phone', arrangedLayout, 'map', false),
    'phone',
    minSize,
  );
  assert.deepEqual(back.rects.get('map'), { x: 0, y: 14, w: 6, h: 5 });
});

test('fits keeps widgets apart and within the columns', () => {
  const layout = layoutFor(panel, 'phone', minSize);
  assert.equal(fits({ x: 0, y: 14, w: 6, h: 1 }, layout, 6), true);
  assert.equal(fits({ x: 1, y: 14, w: 6, h: 1 }, layout, 6), false);
  assert.equal(fits({ x: 0, y: 4, w: 6, h: 2 }, layout, 6, 'map'), false);
  assert.equal(fits({ x: 0, y: 0, w: 6, h: 5 }, layout, 6, 'map'), true);
});
