import assert from 'node:assert/strict';
import { test } from 'node:test';

import { layoutTree, type Size } from './layout.ts';

const GAPS = { siblings: 20, levels: 40 };

// children by node, sizes by node (100 x 40 by default)
function layout(children: number[][], sizes: Record<number, Size> = {}, direction: 'vertical' | 'horizontal' = 'vertical') {
  return layoutTree([0], (node) => children[node] ?? [], (node) => sizes[node] ?? { width: 100, height: 40 }, direction, GAPS);
}

const centre = (box: { x: number; width: number } | undefined) => box && box.x + box.width / 2;

test('parents are centred over their children, in their order', () => {
  const { boxes, width, height, links } = layout([[1, 2]]);
  assert.deepEqual(boxes.get(0), { x: 60, y: 0, width: 100, height: 40 });
  assert.deepEqual(boxes.get(1), { x: 0, y: 80, width: 100, height: 40 });
  assert.deepEqual(boxes.get(2), { x: 120, y: 80, width: 100, height: 40 });
  assert.equal(width, 220);
  assert.equal(height, 120);
  assert.deepEqual(
    links.map((link) => [link.parent, link.child]),
    [
      [0, 1],
      [0, 2],
    ],
  );
  // Down from the parent's bottom, turning half way, down to the child's top
  assert.match(links[0].d, /^M110,40L110,54Q110,60 104,60L56,60Q50,60 50,66L50,80$/);
});

test('subtrees come as close as their outlines allow', () => {
  // 1 has two children below; 2 is a leaf, which may come close to 1
  const tucked = layout([[1, 2], [3, 4]]);
  assert.equal(centre(tucked.boxes.get(2))! - centre(tucked.boxes.get(1))!, 120);
  // 2 has a child of its own, which must clear 1's
  const pushed = layout([[1, 2], [3, 4], [5]]);
  assert.equal(centre(pushed.boxes.get(2))! - centre(pushed.boxes.get(1))!, 180);
  assert.equal(centre(pushed.boxes.get(5)), centre(pushed.boxes.get(2)));
});

test('levels are as deep as their largest node, wide nodes take their room', () => {
  const { boxes } = layout([[1, 2], [3]], { 1: { width: 300, height: 90 } });
  assert.equal(boxes.get(3)!.y, 40 + 40 + 90 + 40);
  assert.equal(boxes.get(2)!.x - (boxes.get(1)!.x + 300), 20);
});

test('horizontally, levels go right and siblings down', () => {
  const { boxes, width, height } = layout([[1, 2]], { 0: { width: 150, height: 40 } }, 'horizontal');
  assert.deepEqual(boxes.get(0), { x: 0, y: 30, width: 150, height: 40 });
  assert.deepEqual(boxes.get(1), { x: 190, y: 0, width: 100, height: 40 });
  assert.deepEqual(boxes.get(2), { x: 190, y: 60, width: 100, height: 40 });
  assert.equal(width, 290);
  assert.equal(height, 100);
});

test('nothing to lay out', () => {
  assert.deepEqual(layoutTree([], () => [], () => ({ width: 1, height: 1 }), 'vertical', GAPS), {
    boxes: new Map(),
    links: [],
    width: 0,
    height: 0,
  });
});
