import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DISPLAYS,
  effectiveFixedFrame,
  frameFilter,
  migrateRobotModelConfig,
  moveItem,
  newDisplayId,
  parseColor,
  rainbow,
  treeRoot,
} from './model.ts';

test("the Robot Model widget's config becomes displays", () => {
  assert.deepEqual(
    migrateRobotModelConfig({ descriptionTopic: '/my/description', showFrames: true, highlightMotion: false }),
    {
      descriptionTopic: '/my/description',
      showFrames: true,
      highlightMotion: false,
      displays: [
        {
          id: 'robot',
          type: 'robot-model-display',
          name: '',
          enabled: true,
          config: { descriptionTopic: '/my/description', highlightMotion: false },
        },
        { id: 'tf', type: 'tf-display', name: '', enabled: true, config: {} },
      ],
    },
  );
  // A viewer's own, or a new one's (the property's default stands in), are kept
  const viewer = { displays: [], descriptionTopic: '/old' };
  assert.equal(migrateRobotModelConfig(viewer), viewer);
  const fresh = { fixedFrame: 'map' };
  assert.equal(migrateRobotModelConfig(fresh), fresh);
  assert.equal(DEFAULT_DISPLAYS[0].type, 'robot-model-display');
});

const frames = [
  { name: 'map', parent: null },
  { name: 'odom', parent: 'map' },
  { name: 'base_link', parent: 'odom' },
  { name: 'laser', parent: 'base_link' },
  { name: 'charger', parent: null },
  { name: 'dock', parent: 'charger' },
];

test('Auto: the frame chosen, else the first suggested, else the root of the largest tree', () => {
  assert.equal(treeRoot(frames), 'map');
  assert.equal(treeRoot([]), null);
  // Ties: by name
  assert.equal(treeRoot([{ name: 'b', parent: null }, { name: 'a', parent: null }]), 'a');
  // Loops end
  assert.equal(typeof treeRoot([{ name: 'a', parent: 'b' }, { name: 'b', parent: 'a' }]), 'string');
  assert.equal(effectiveFixedFrame(' /odom ', ['base_link'], frames), 'odom');
  assert.equal(effectiveFixedFrame('', [null, 'base_footprint'], frames), 'base_footprint');
  assert.equal(effectiveFixedFrame('', [null], frames), 'map');
  assert.equal(effectiveFixedFrame('', [], []), '');
});

test('new display ids are not taken; items move within the list', () => {
  const id = newDisplayId(['robot']);
  assert.match(id, /^d[0-9a-f]{8}$/);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  const list = ['a', 'b'];
  assert.equal(moveItem(list, 0, -1), list);
});

test("RViz's rainbow: red to magenta", () => {
  assert.deepEqual(rainbow(0), [1, 0, 0]);
  assert.deepEqual(rainbow(1), [1, 0, 1]);
  assert.deepEqual(rainbow(0.4), [0, 1, 0]);
  assert.deepEqual(rainbow(0.6), [0, 1, 1]);
  assert.deepEqual(rainbow(-3), rainbow(0));
  assert.deepEqual(rainbow(NaN), rainbow(0));
  assert.deepEqual(parseColor('#ff8000'), [1, 128 / 255, 0]);
  assert.deepEqual(parseColor('red'), [0.5, 0.5, 0.5]);
});

test('TF frames filtered by words of their names', () => {
  const show = frameFilter(' Wheel, laser ');
  assert.equal(show('left_wheel_link'), true);
  assert.equal(show('base_laser'), true);
  assert.equal(show('base_link'), false);
  assert.equal(frameFilter(' , ')('anything'), true);
});
