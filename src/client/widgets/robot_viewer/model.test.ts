import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cameraInfoTopic,
  DEFAULT_DISPLAYS,
  effectiveFixedFrame,
  frameFilter,
  imageCorners,
  intrinsicsFromFov,
  intrinsicsOf,
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

test('the camera info beside an image topic, raw or compressed', () => {
  assert.equal(cameraInfoTopic('/camera/image_raw'), '/camera/camera_info');
  assert.equal(cameraInfoTopic('/camera/color/image_raw/compressed'), '/camera/color/camera_info');
  assert.equal(cameraInfoTopic(' /front/image_rect/ '), '/front/camera_info');
  assert.equal(cameraInfoTopic('image'), 'camera_info');
});

test("a camera's projection from its camera info, else from a field of view", () => {
  const k = [500, 0, 320, 0, 400, 240, 0, 0, 1];
  assert.deepEqual(intrinsicsOf({ width: 640, height: 480, k }), { width: 640, height: 480, fx: 500, fy: 400, cx: 320, cy: 240 });
  // Uncalibrated: its p if set, else none
  const p = [450, 0, 300, 0, 0, 460, 250, 0, 0, 0, 1, 0];
  assert.deepEqual(intrinsicsOf({ width: 640, height: 480, k: Array(9).fill(0), p }), { width: 640, height: 480, fx: 450, fy: 460, cx: 300, cy: 250 });
  assert.equal(intrinsicsOf({ width: 640, height: 480, k: Array(9).fill(0), p: Array(12).fill(0) }), null);
  assert.equal(intrinsicsOf({ width: 0, height: 0, k }), null);
  const fov = intrinsicsFromFov(640, 480, 90);
  assert.ok(Math.abs(fov.fx - 320) < 1e-9 && fov.fy === fov.fx && fov.cx === 320 && fov.cy === 240);
});

test("the image's corners in front of the camera, in its optical frame", () => {
  const corners = imageCorners({ width: 640, height: 480, fx: 320, fy: 320, cx: 320, cy: 240 }, 2);
  assert.deepEqual(corners, [
    [-2, -1.5, 2],
    [2, -1.5, 2],
    [2, 1.5, 2],
    [-2, 1.5, 2],
  ]);
  // An off-centre principal point shifts the image
  const [topLeft] = imageCorners({ width: 100, height: 100, fx: 100, fy: 100, cx: 25, cy: 50 }, 1);
  assert.deepEqual(topLeft, [-0.25, -0.5, 1]);
});
