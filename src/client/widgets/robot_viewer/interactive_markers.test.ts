import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  autoComplete,
  defaultColor,
  feedback,
  FeedbackEvent,
  InteractionMode,
  makeTitle,
  MarkerType,
  menuTree,
  OrientationMode,
  quat,
  serverTopics,
  update,
  UpdateKind,
  UpdateSequence,
  type UpdateMsg,
} from './interactive_markers.ts';

function msg(seq: number, type: number = UpdateKind.UPDATE, server = '/server'): UpdateMsg {
  return update({ server_id: server, seq_num: seq, type });
}

test("the server's topics, from its update topic or its namespace", () => {
  assert.deepEqual(serverTopics('/basic_controls/update'), {
    namespace: '/basic_controls',
    update: '/basic_controls/update',
    feedback: '/basic_controls/feedback',
    service: '/basic_controls/get_interactive_markers',
  });
  assert.equal(serverTopics(' /basic_controls/ ').update, '/basic_controls/update');
  assert.equal(serverTopics('/a/b/update_full').namespace, '/a/b');
});

test('updates after the markers asked for are applied in order; those before, ignored', () => {
  const sequence = new UpdateSequence();
  // Not asked yet
  assert.equal(sequence.receive(msg(1)), 'ignore');
  sequence.asked();
  // Waiting for the answer: kept
  assert.equal(sequence.receive(msg(4)), 'ignore');
  assert.equal(sequence.receive(msg(5)), 'ignore');
  assert.equal(sequence.receive(msg(6)), 'ignore');
  // The answer as of 5: 4 and 5 are in it, 6 to apply
  assert.deepEqual(
    sequence.answered(5)?.map((u) => u.seq_num),
    [6],
  );
  assert.equal(sequence.running, true);
  assert.equal(sequence.receive(msg(7)), 'apply');
  assert.equal(sequence.receive(msg(7, UpdateKind.KEEP_ALIVE)), 'ignore');
  assert.equal(sequence.receive(msg(8)), 'apply');
  // What the markers shown are as of, for asking again whether it changed
  assert.equal(sequence.latest, 8);
  sequence.asked();
  assert.equal(sequence.latest, null);
});

test('a missed update, a keep alive ahead, or another server: ask again', () => {
  const missed = new UpdateSequence();
  missed.asked();
  missed.answered(3);
  assert.equal(missed.receive(msg(5)), 'reset');
  assert.equal(missed.running, false);

  const ahead = new UpdateSequence();
  ahead.asked();
  ahead.answered(3);
  assert.equal(ahead.receive(msg(4, UpdateKind.KEEP_ALIVE)), 'reset');

  const other = new UpdateSequence();
  other.asked();
  other.answered(3);
  assert.equal(other.receive(msg(4)), 'apply');
  assert.equal(other.receive(msg(5, UpdateKind.UPDATE, '/another')), 'reset');

  // Restarted: counting again, once updates came
  const restarted = new UpdateSequence();
  restarted.asked();
  restarted.answered(10);
  assert.equal(restarted.receive(msg(11)), 'apply');
  assert.equal(restarted.receive(msg(1)), 'reset');

  // The answer is missing an update that came while asking
  const gap = new UpdateSequence();
  gap.asked();
  gap.receive(msg(8));
  assert.equal(gap.answered(6), null);

  // Old ones, right after the answer: from before it
  const late = new UpdateSequence();
  late.asked();
  late.answered(6);
  assert.equal(late.receive(msg(5)), 'ignore');
  assert.equal(late.receive(msg(4, UpdateKind.KEEP_ALIVE)), 'ignore');
  assert.equal(late.receive(msg(6, UpdateKind.KEEP_ALIVE)), 'ignore');
  assert.equal(late.receive(msg(7)), 'apply');
});

test('autoComplete: a scale, orientations, and the default markers of controls without any', () => {
  const im = autoComplete({
    header: { frame_id: 'base_link' },
    name: 'simple_6dof',
    description: 'Simple 6-DOF Control',
    scale: 0,
    pose: { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 0 } },
    controls: [
      { name: 'move_x', orientation: { w: 1, x: 1, y: 0, z: 0 }, interaction_mode: InteractionMode.MOVE_AXIS },
      { name: 'rotate_z', orientation: { w: 1, x: 0, y: 1, z: 0 }, interaction_mode: InteractionMode.ROTATE_AXIS },
      { name: 'move_plane', interaction_mode: InteractionMode.MOVE_PLANE },
      { name: 'menu', interaction_mode: InteractionMode.MENU },
      { name: 'box', interaction_mode: InteractionMode.NONE, markers: [{ type: MarkerType.CUBE, scale: { x: 0.45 } }] },
      { name: 'box', interaction_mode: InteractionMode.BUTTON },
    ],
  });
  assert.equal(im.scale, 1);
  assert.deepEqual(im.pose.orientation, { x: 0, y: 0, z: 0, w: 1 });
  const [moveX, rotateZ, plane, menu, box, button] = im.controls;
  // Two arrows along the control's x, out from half the scale
  assert.equal(moveX.markers.length, 2);
  assert.equal(moveX.markers[0].type, MarkerType.ARROW);
  assert.deepEqual(
    moveX.markers.map((m) => [m.points[0].x, m.points[1].x]),
    [
      [0.5, 0.9],
      [-0.5, -0.9],
    ],
  );
  assert.ok(Math.abs(moveX.orientation.x - Math.SQRT1_2) < 1e-9);
  // A ring of 36 steps, two triangles each, striped for a rotation
  assert.equal(rotateZ.markers[0].type, MarkerType.TRIANGLE_LIST);
  assert.equal(rotateZ.markers[0].points.length, 36 * 6);
  assert.equal(rotateZ.markers[0].colors.length, 36 * 2);
  // Plain to move in the plane
  assert.equal(plane.markers[0].colors.length, 0);
  // A menu's text, facing the view
  assert.equal(menu.markers[0].type, MarkerType.TEXT_VIEW_FACING);
  assert.equal(menu.markers[0].text, 'Simple 6-DOF Control');
  assert.equal(menu.orientation_mode, OrientationMode.VIEW_FACING);
  // Its own markers kept, their missing scales 1
  assert.deepEqual(box.markers[0].scale, { x: 0.45, y: 1, z: 1 });
  assert.equal(box.markers[0].ns, 'simple_6dof');
  // Names made unique
  assert.equal(button.name, 'box_u0');
  assert.equal(button.markers.length, 0);
});

test("the default colours: the control's axis, half transparent", () => {
  assert.deepEqual(defaultColor({ x: 0, y: 0, z: 0, w: 1 }), { r: 1, g: 0, b: 0, a: 0.5 });
  const y = defaultColor(quat({ x: 0, y: 0, z: 1, w: 1 }));
  assert.ok(y.r < 1e-9 && Math.abs(y.g - 1) < 1e-9 && y.b < 1e-9);
  const z = defaultColor(quat({ x: 0, y: 1, z: 0, w: 1 }));
  assert.ok(z.r < 1e-9 && z.g < 1e-9 && Math.abs(z.b - 1) < 1e-9);
});

test('the description, above the marker', () => {
  const title = makeTitle(autoComplete({ name: 'm', description: 'Hello', scale: 2, controls: [{ name: 'c' }] }));
  assert.equal(title.interaction_mode, InteractionMode.NONE);
  assert.equal(title.orientation_mode, OrientationMode.VIEW_FACING);
  assert.equal(title.markers[0].text, 'Hello');
  assert.equal(title.markers[0].pose.position.z, 2.8);
});

test('menus as trees, in their order', () => {
  const tree = menuTree([
    { id: 1, parent_id: 0, title: 'First', command: '', command_type: 0 },
    { id: 2, parent_id: 0, title: 'Second', command: '', command_type: 0 },
    { id: 3, parent_id: 2, title: 'Sub 1', command: '', command_type: 0 },
    { id: 4, parent_id: 2, title: 'Sub 2', command: 'rviz', command_type: 1 },
    // Its parent is not there: at the top
    { id: 5, parent_id: 9, title: 'Lost', command: '', command_type: 0 },
  ]);
  assert.deepEqual(
    tree.map((node) => [node.title, node.children.map((child) => child.title)]),
    [
      ['First', []],
      ['Second', ['Sub 1', 'Sub 2']],
      ['Lost', []],
    ],
  );
  assert.equal(tree[1].children[1].commandType, 1);
});

test('feedback: the pose in the marker frame, the point pressed if any', () => {
  const im = autoComplete({ header: { frame_id: 'map' }, name: 'goal', controls: [{ name: 'c' }] });
  const pose = { position: { x: 1, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
  const sent = feedback('tassello/1', im, 'move_x', FeedbackEvent.MOUSE_DOWN, pose, { mousePoint: { x: 1, y: 2, z: 3 } });
  assert.equal(sent.header.frame_id, 'map');
  assert.equal(sent.marker_name, 'goal');
  assert.equal(sent.control_name, 'move_x');
  assert.equal(sent.event_type, FeedbackEvent.MOUSE_DOWN);
  assert.equal(sent.mouse_point_valid, true);
  assert.equal(feedback('tassello/1', im, '', FeedbackEvent.POSE_UPDATE, pose).mouse_point_valid, false);
});

test('messages missing fields, or with text and bigint numbers, are whole', () => {
  const u = update({ seq_num: '12', markers: [{ name: 'x', controls: [{}] }] });
  assert.equal(u.seq_num, 12);
  assert.equal(u.type, 0);
  assert.equal(u.markers[0].controls[0].interaction_mode, InteractionMode.NONE);
  assert.deepEqual(u.markers[0].pose.orientation, { x: 0, y: 0, z: 0, w: 1 });
  assert.equal(update({ seq_num: 7n }).seq_num, 7);
});
