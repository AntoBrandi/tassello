import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageField, MessageSchema } from '../shared/monitor.ts';
import {
  defaultMessage,
  echoJson,
  expandDefinition,
  fieldAt,
  nestedFieldType,
  parseType,
  partTypes,
  toRosMessage,
} from './message_format.ts';

const field = (name: string, type: string, parts: Partial<MessageField> = {}): MessageField => ({
  name,
  type,
  primitive: !type.includes('/'),
  array: 'none',
  size: null,
  stringBound: null,
  default: null,
  ...parts,
});

const SCHEMAS: Record<string, MessageSchema> = {
  'builtin_interfaces/msg/Time': { fields: [field('sec', 'int32'), field('nanosec', 'uint32')], constants: [] },
  'std_msgs/msg/Header': {
    fields: [field('stamp', 'builtin_interfaces/msg/Time'), field('frame_id', 'string')],
    constants: [],
  },
  'test_msgs/msg/Sample': {
    fields: [
      field('header', 'std_msgs/msg/Header'),
      field('count', 'int64'),
      field('ratio', 'float64', { default: 0.5 }),
      field('enabled', 'bool'),
      field('covariance', 'float64', { array: 'fixed', size: 3 }),
      field('names', 'string', { array: 'bounded', size: 2, stringBound: 4 }),
      field('stamps', 'builtin_interfaces/msg/Time', { array: 'dynamic' }),
      field('level', 'uint8'),
    ],
    constants: [{ name: 'OK', type: 'uint8', value: 0 }],
  },
};

const NOW = () => ({ sec: 1729435407, nanosec: 5 });

test('default messages: zero, false, empty; the definition’s defaults; fixed arrays full', () => {
  assert.deepEqual(defaultMessage('test_msgs/msg/Sample', SCHEMAS), {
    header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
    count: 0,
    ratio: 0.5,
    enabled: false,
    covariance: [0, 0, 0],
    names: [],
    stamps: [],
    level: 0,
  });
});

test('messages from JSON: every field, 64 bit integers as BigInt, now and auto', () => {
  const message = toRosMessage(
    { header: 'auto', count: '9007199254740993', covariance: [1, 'inf', 'nan'], stamps: ['now', { sec: 3 }] },
    'test_msgs/msg/Sample',
    SCHEMAS,
    NOW,
  );
  assert.deepEqual(message.header, { stamp: { sec: 1729435407, nanosec: 5 }, frame_id: '' });
  assert.equal(message.count, 9007199254740993n);
  assert.equal(message.ratio, 0.5);
  assert.deepEqual(message.covariance, [1, Infinity, NaN]);
  assert.deepEqual(message.stamps, [
    { sec: 1729435407, nanosec: 5 },
    { sec: 3, nanosec: 0 },
  ]);
  assert.equal(toRosMessage({ count: 7 }, 'test_msgs/msg/Sample', SCHEMAS, NOW).count, 7n);
  // As echoed
  assert.equal(toRosMessage({ count: { $int: '-5' } }, 'test_msgs/msg/Sample', SCHEMAS, NOW).count, -5n);
});

test('messages from JSON: what is wrong, with the field’s path', () => {
  const refused = (value: unknown, message: RegExp) =>
    assert.throws(() => toRosMessage(value, 'test_msgs/msg/Sample', SCHEMAS, NOW), message);
  refused({ cout: 1 }, /test_msgs\/msg\/Sample has no field cout/);
  refused({ header: { stamp: { secs: 1 } } }, /has no field header\.stamp\.secs/);
  refused({ count: 1.5 }, /count must be an integer \(int64\), not 1\.5/);
  refused({ level: 256 }, /level must be within 0 and 255/);
  refused({ enabled: 'yes' }, /enabled must be true or false/);
  refused({ covariance: [1, 2] }, /covariance must have 3 items, not 2/);
  refused({ names: ['a', 'b', 'c'] }, /names must have 2 items at most/);
  refused({ names: ['abcde'] }, /names\[0\] must be 4 characters at most/);
  refused({ stamps: [{ sec: 'x' }] }, /stamps\[0\]\.sec must be an integer/);
  refused([], /The message must be an object/);
});

test('a field of a message by its path', () => {
  const message = { pose: { position: { x: 1 } }, ranges: new Float32Array([4, 5]), points: [{ x: 7 }] };
  assert.equal(fieldAt(message, 'pose.position.x'), 1);
  assert.equal(fieldAt(message, 'ranges[1]'), 5);
  assert.equal(fieldAt(message, 'points.0.x'), 7);
  assert.equal(fieldAt(message, 'pose.orientation'), undefined);
  assert.equal(fieldAt(message, 'ranges[2]'), undefined);
});

test('echoed: long lists and strings cut, big integers as text, NaN and infinities named', () => {
  assert.deepEqual(
    echoJson(
      {
        ranges: new Float32Array([1, Infinity, NaN, -Infinity]),
        data: 'abcdef',
        id: 2n ** 60n,
        small: 5n,
        nested: [{ a: [1, 2, 3, 4, 5] }],
      },
      3,
    ),
    {
      ranges: { $truncated: 4, head: [1, { $number: 'inf' }, { $number: 'nan' }] },
      data: { $truncated: 6, head: 'abc' },
      id: { $int: '1152921504606846976' },
      small: 5,
      nested: [{ a: { $truncated: 5, head: [1, 2, 3] } }],
    },
  );
});

test('definitions as ros2 interface show prints them: nested ones indented, without comments', () => {
  const files: Record<string, string> = {
    'std_msgs/Header': '# Standard metadata\nbuiltin_interfaces/Time stamp\n\n# Frame\nstring frame_id\n',
    'builtin_interfaces/Time': 'int32 sec\nuint32 nanosec\n',
    'geometry_msgs/Point': 'float64 x\nfloat64 y\nfloat64 z\n',
  };
  const text = expandDefinition(
    '# A point\nstd_msgs/Header header # stamped\nPoint[] points\nuint8 OK=0\nstring name "a#b"\n',
    'geometry_msgs',
    (pkg, name) => files[`${pkg}/${name}`] ?? null,
  );
  assert.equal(
    text,
    [
      '# A point',
      'std_msgs/Header header # stamped',
      '\tbuiltin_interfaces/Time stamp',
      '\t\tint32 sec',
      '\t\tuint32 nanosec',
      '\tstring frame_id',
      'Point[] points',
      '\tfloat64 x',
      '\tfloat64 y',
      '\tfloat64 z',
      'uint8 OK=0',
      'string name "a#b"',
    ].join('\n'),
  );
});

test('interfaces’ parts: those of services and actions, and the messages they are made of', () => {
  assert.deepEqual(parseType('nav2_msgs/action/NavigateToPose'), { pkg: 'nav2_msgs', kind: 'action', name: 'NavigateToPose' });
  assert.throws(() => parseType('std_msgs/String'), /not a ROS interface type/);
  const parts = (type: string) => partTypes(type).map((p) => `${p.name} ${p.type}`);
  assert.deepEqual(parts('std_msgs/msg/String'), ['message std_msgs/msg/String']);
  assert.deepEqual(parts('std_srvs/srv/SetBool'), ['request std_srvs/srv/SetBool_Request', 'response std_srvs/srv/SetBool_Response']);
  assert.deepEqual(parts('a/action/Fibonacci'), [
    'goal a/action/Fibonacci_Goal',
    'result a/action/Fibonacci_Result',
    'feedback a/action/Fibonacci_Feedback',
  ]);
  // An action's feedback topic, its goal service; a service's events
  assert.deepEqual(parts('a/action/Fibonacci_FeedbackMessage'), ['message a/action/Fibonacci_FeedbackMessage']);
  assert.deepEqual(parts('a/action/Fibonacci_SendGoal'), [
    'request a/action/Fibonacci_SendGoal_Request',
    'response a/action/Fibonacci_SendGoal_Response',
  ]);
  assert.deepEqual(parts('std_srvs/srv/SetBool_Event'), ['message std_srvs/srv/SetBool_Event']);
});

test('the message types fields declare', () => {
  assert.deepEqual(nestedFieldType('Pose pose', 'geometry_msgs'), ['geometry_msgs', 'Pose']);
  assert.deepEqual(nestedFieldType('std_msgs/Header header  # x', 'nav_msgs'), ['std_msgs', 'Header']);
  assert.deepEqual(nestedFieldType('geometry_msgs/msg/Point[<=10] points', 'x'), ['geometry_msgs', 'Point']);
  assert.equal(nestedFieldType('float64[9] covariance', 'x'), null);
  assert.equal(nestedFieldType('string<=5 name', 'x'), null);
  assert.equal(nestedFieldType('int8 STATUS_FIX = 0', 'x'), null);
  assert.equal(nestedFieldType('# Pose pose', 'x'), null);
  assert.equal(nestedFieldType('---', 'x'), null);
});
