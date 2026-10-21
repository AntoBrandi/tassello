import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GraphSnapshot } from '../../../shared/monitor.ts';
import {
  filterEntries,
  formatBytes,
  formatRate,
  formatSeconds,
  hasTruncated,
  isHiddenName,
  listText,
  numberValue,
  parseList,
  qosSummary,
  setAt,
  sheetEntries,
  shortType,
  yamlText,
} from './model.ts';

const GRAPH: GraphSnapshot = {
  topics: [
    { name: '/chatter', types: ['std_msgs/msg/String'], publishers: 1, subscribers: 2 },
    { name: '/navigate_to_pose/_action/status', types: ['action_msgs/msg/GoalStatusArray'], publishers: 1, subscribers: 0 },
  ],
  services: [
    { name: '/add_two_ints', types: ['example_interfaces/srv/AddTwoInts'], servers: ['/server'], clients: [] },
    { name: '/talker/get_parameters', types: ['rcl_interfaces/srv/GetParameters'], servers: ['/talker'], clients: [] },
  ],
  actions: [{ name: '/fibonacci', types: ['action_tutorials_interfaces/action/Fibonacci'], servers: ['/s'], clients: ['/a', '/b'] }],
  nodes: ['/server', '/talker'],
  self: '/tassello',
};

test('the sheets’ rows, hidden ones marked: underscored names, every node’s own services', () => {
  assert.deepEqual(sheetEntries(GRAPH, 'topics'), [
    { name: '/chatter', types: ['std_msgs/msg/String'], out: 1, in: 2, hidden: false },
    { name: '/navigate_to_pose/_action/status', types: ['action_msgs/msg/GoalStatusArray'], out: 1, in: 0, hidden: true },
  ]);
  assert.deepEqual(
    sheetEntries(GRAPH, 'services').map((e) => [e.name, e.hidden]),
    [
      ['/add_two_ints', false],
      ['/talker/get_parameters', true],
    ],
  );
  assert.deepEqual(sheetEntries(GRAPH, 'actions')[0], {
    name: '/fibonacci',
    types: ['action_tutorials_interfaces/action/Fibonacci'],
    out: 1,
    in: 2,
    hidden: false,
  });
  assert.deepEqual(sheetEntries(null, 'topics'), []);
  assert.equal(isHiddenName('/robot/_internal'), true);
  assert.equal(isHiddenName('/robot/internal_'), false);
});

test('filtered by name or type, the hidden ones on demand', () => {
  const entries = sheetEntries(GRAPH, 'topics');
  assert.deepEqual(
    filterEntries(entries, false, null).map((e) => e.name),
    ['/chatter'],
  );
  assert.equal(filterEntries(entries, true, null).length, 2);
  assert.deepEqual(
    filterEntries(entries, true, (text) => text.includes('GoalStatus')).map((e) => e.name),
    ['/navigate_to_pose/_action/status'],
  );
});

test('figures as people read them', () => {
  assert.equal(shortType('std_msgs/msg/String'), 'std_msgs/String');
  assert.equal(formatRate(9.98765), '9.99 Hz');
  assert.equal(formatRate(1234), '1.23 kHz');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.54 KB');
  assert.equal(formatBytes(3_200_000), '3.2 MB');
  assert.equal(formatSeconds(0.000012), '12 µs');
  assert.equal(formatSeconds(0.0035), '3.5 ms');
  assert.equal(formatSeconds(1.25), '1.25 s');
  assert.equal(formatSeconds(0.99996), '1 s');
  assert.equal(formatSeconds(-0.002), '−2 ms');
  assert.equal(formatSeconds(600), '10 min');
  assert.equal(
    qosSummary({
      reliability: 'best_effort',
      durability: 'transient_local',
      history: 'keep_last',
      depth: 5,
      deadline: null,
      lifespan: null,
      liveliness: 'automatic',
      leaseDuration: null,
    }),
    'best effort · transient local · keep last 5',
  );
});

test('messages as ros2 topic echo prints them', () => {
  assert.equal(
    yamlText({
      header: { stamp: { sec: 1, nanosec: 2 }, frame_id: 'map' },
      data: 'Hello World: 1',
      ranges: { $truncated: 720, head: [1.5, { $number: 'inf' }] },
      big: { $int: '9007199254740993' },
      empty: [],
      poses: [{ x: 1, y: 2 }],
      flag: true,
      label: '',
    }),
    [
      'header:',
      '  stamp:',
      '    sec: 1',
      '    nanosec: 2',
      '  frame_id: map',
      "data: 'Hello World: 1'",
      'ranges:',
      '  - 1.5',
      '  - .inf',
      '  - … 720 items in all',
      'big: 9007199254740993',
      'empty: []',
      'poses:',
      '  - x: 1',
      '    y: 2',
      'flag: true',
      "label: ''",
    ].join('\n'),
  );
  assert.equal(yamlText(5), '5');
  assert.equal(hasTruncated({ a: [{ b: { $truncated: 3, head: 'abc' } }] }), true);
  assert.equal(hasTruncated({ a: [1, 2], b: { $int: '1' } }), false);
});

test('edits of a message: a value replaced, the rest kept', () => {
  const message = { pose: { position: { x: 0, y: 0 } }, points: [{ x: 1 }, { x: 2 }] };
  const edited = setAt(message, ['pose', 'position', 'x'], 1.5) as typeof message;
  assert.deepEqual(edited.pose.position, { x: 1.5, y: 0 });
  assert.equal(message.pose.position.x, 0);
  assert.equal(edited.points, message.points);
  assert.deepEqual((setAt(message, ['points', 1, 'x'], 5) as typeof message).points, [{ x: 1 }, { x: 5 }]);
});

test('numbers and lists as typed in the form', () => {
  assert.equal(numberValue('1.5'), 1.5);
  assert.equal(numberValue('-'), '-');
  assert.equal(numberValue(' 9007199254740993 '), '9007199254740993');
  assert.deepEqual(parseList('1, 2.5, inf', 'float64'), { value: [1, 2.5, 'inf'] });
  assert.deepEqual(parseList('', 'int32'), { value: [] });
  assert.deepEqual(parseList('1, x', 'int32'), { error: 'Not a number: x' });
  assert.deepEqual(parseList('"a, b", "c"', 'string'), { value: ['a, b', 'c'] });
  assert.deepEqual(parseList('true, false', 'bool'), { value: [true, false] });
  assert.equal(listText([1, 2.5]), '1, 2.5');
  assert.equal(listText(['a']), '"a"');
});
