import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { fromDescriptor, fromParameterValue, toParameterValue, type ParameterValueMessage } from './param_format.ts';
import { dumpParameters, parseParameterFile } from './param_yaml.ts';

// As rclnodejs gives an rcl_interfaces/msg/ParameterValue
const message = (type: number, parts: Partial<ParameterValueMessage>): ParameterValueMessage => ({
  type,
  bool_value: false,
  integer_value: 0n,
  double_value: 0,
  string_value: '',
  byte_array_value: [],
  bool_array_value: [],
  integer_array_value: new BigInt64Array(0),
  double_array_value: new Float64Array(0),
  string_array_value: [],
  ...parts,
});

test('parameter values from rclnodejs: 64 bit integers beyond JavaScript’s as text, infinities named', () => {
  assert.deepEqual(fromParameterValue(message(1, { bool_value: true })), { type: 'bool', value: true });
  assert.deepEqual(fromParameterValue(message(2, { integer_value: 42n })), { type: 'integer', value: 42 });
  assert.deepEqual(fromParameterValue(message(2, { integer_value: 2n ** 60n })), {
    type: 'integer',
    value: '1152921504606846976',
  });
  assert.deepEqual(fromParameterValue(message(3, { double_value: -Infinity })), { type: 'double', value: '-inf' });
  assert.deepEqual(fromParameterValue(message(7, { integer_array_value: BigInt64Array.from([1n, 2n]) })), {
    type: 'integer_array',
    value: [1, 2],
  });
  assert.deepEqual(fromParameterValue(message(8, { double_array_value: Float64Array.from([0.5, NaN]) })), {
    type: 'double_array',
    value: [0.5, 'nan'],
  });
  assert.deepEqual(fromParameterValue(message(0, {})), { type: 'not_set', value: null });
});

test('parameter values for rclnodejs: integers as BigInt, from numbers or text; what is wrong named', () => {
  assert.deepEqual(toParameterValue({ type: 'integer', value: '9007199254740993' }), {
    type: 2,
    integer_value: 9007199254740993n,
  });
  assert.deepEqual(toParameterValue({ type: 'double', value: 'inf' }), { type: 3, double_value: Infinity });
  assert.deepEqual(toParameterValue({ type: 'integer_array', value: [1, '2'] }), {
    type: 7,
    integer_array_value: [1n, 2n],
  });
  // ros2 param delete
  assert.deepEqual(toParameterValue({ type: 'not_set', value: null }), { type: 0 });
  assert.throws(() => toParameterValue({ type: 'integer', value: 1.5 }, 'max_speed'), /max_speed must be an integer, not 1.5/);
  assert.throws(() => toParameterValue({ type: 'bool', value: 'yes' }, 'enabled'), /enabled must be true or false/);
  assert.throws(() => toParameterValue({ type: 'byte_array', value: [256] }, 'key'), /key\[0\] must be within 0 and 255/);
  assert.throws(() => toParameterValue({ type: 'double_array', value: 3 }, 'gains'), /gains must be a list/);
});

test('descriptors: their ranges, integer or floating point', () => {
  const descriptor = {
    name: 'background_r',
    type: 2,
    description: 'Red channel',
    additional_constraints: '',
    read_only: false,
    dynamic_typing: false,
    floating_point_range: [],
    integer_range: [{ from_value: 0n, to_value: 255n, step: 1n }],
  };
  assert.deepEqual(fromDescriptor(descriptor), {
    type: 'integer',
    description: 'Red channel',
    additionalConstraints: '',
    readOnly: false,
    dynamicTyping: false,
    range: { from: 0, to: 255, step: 1 },
  });
  assert.equal(fromDescriptor({ ...descriptor, integer_range: [] }).range, null);
});

const hasYaml = (() => {
  try {
    execFileSync('python3', ['-c', 'import yaml']);
    return true;
  } catch {
    return false;
  }
})();

test('parameter files as ros2 param dump writes them', { skip: !hasYaml && 'no python3 with yaml' }, async () => {
  const yaml = await dumpParameters('/turtlesim', [
    { name: 'background_r', value: { type: 'integer', value: 40 }, descriptor: null },
    { name: 'scale', value: { type: 'double', value: 1 }, descriptor: null },
    { name: 'qos_overrides./tf.publisher.depth', value: { type: 'integer', value: 100 }, descriptor: null },
    { name: 'limits', value: { type: 'double_array', value: [0.5, 'inf'] }, descriptor: null },
  ]);
  assert.equal(
    yaml,
    [
      '/turtlesim:',
      '  ros__parameters:',
      '    background_r: 40',
      '    limits:',
      '    - 0.5',
      '    - .inf',
      '    qos_overrides:',
      '      /tf:',
      '        publisher:',
      '          depth: 100',
      // A double stays one
      '    scale: 1.0',
      '',
    ].join('\n'),
  );
});

test('parameter files as ros2 param load reads them', { skip: !hasYaml && 'no python3 with yaml' }, async () => {
  const file = [
    '/**:',
    '  ros__parameters:',
    '    use_sim_time: true',
    'turtlesim:',
    '  ros__parameters:',
    '    background_r: 9007199254740993',
    '    gains: [1, 2.5]',
    '    names: [a, b]',
    '    empty: []',
    '    nested:',
    '      max: .inf',
  ].join('\n');
  const loaded = await parseParameterFile('/turtlesim', file);
  assert.deepEqual(loaded.parameters, [
    { name: 'use_sim_time', value: { type: 'bool', value: true } },
    { name: 'background_r', value: { type: 'integer', value: '9007199254740993' } },
    { name: 'gains', value: { type: 'double_array', value: [1, 2.5] } },
    { name: 'names', value: { type: 'string_array', value: ['a', 'b'] } },
    { name: 'nested.max', value: { type: 'double', value: 'inf' } },
  ]);
  assert.deepEqual(loaded.errors, [
    { name: 'empty', successful: false, reason: 'Not loaded: an empty list, whose type is unknown' },
  ]);
  await assert.rejects(parseParameterFile('/turtlesim', '/other:\n  ros__parameters:\n    x: 1\n'), /only of \/other/);
  await assert.rejects(parseParameterFile('/turtlesim', 'a: ['), /Not YAML/);
});
