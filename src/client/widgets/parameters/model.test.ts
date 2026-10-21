import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParamInfo } from '../../../shared/parameters.ts';
import { inferValue, isHiddenNode, paramRows, parseValueText, rangeText, setCommand, valueText } from './model.ts';

const param = (name: string, readOnly = false, description = ''): ParamInfo => ({
  name,
  value: { type: 'integer', value: 1 },
  descriptor: { type: 'integer', description, additionalConstraints: '', readOnly, dynamicTyping: false, range: null },
});

const PARAMS = [
  param('use_sim_time'),
  param('background_r', false, 'Red channel'),
  param('qos_overrides./parameter_events.publisher.depth', true),
  param('qos_overrides./parameter_events.publisher.history', true),
  param('controller.gains.p'),
  param('controller.gains.d'),
];

const shape = (rows: ReturnType<typeof paramRows>) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'group' ? `${r.open ? 'v' : '>'} ${r.label} (${r.count})` : r.label}`);

test('parameters as a tree of their prefixes; read-only groups folded until opened', () => {
  assert.deepEqual(shape(paramRows(PARAMS, null, new Map())), [
    'background_r',
    'v controller (2)',
    '  v gains (2)',
    '    d',
    '    p',
    '> qos_overrides (2)',
    'use_sim_time',
  ]);
  const chosen = new Map([
    ['qos_overrides', true],
    ['controller.gains', false],
  ]);
  assert.deepEqual(shape(paramRows(PARAMS, null, chosen)), [
    'background_r',
    'v controller (2)',
    '  > gains (2)',
    'v qos_overrides (2)',
    '  v /parameter_events (2)',
    '    v publisher (2)',
    '      depth',
    '      history',
    'use_sim_time',
  ]);
});

test('filtered by name or description, every group with a match open', () => {
  const test = (text: string) => text.toLowerCase().includes('depth') || text.includes('Red');
  assert.deepEqual(shape(paramRows(PARAMS, test, new Map([['qos_overrides', false]]))), [
    'background_r',
    'v qos_overrides (1)',
    '  v /parameter_events (1)',
    '    v publisher (1)',
    '      depth',
  ]);
});

test('values as text to edit, and back', () => {
  assert.equal(valueText({ type: 'double_array', value: [0.5, 'inf'] }), '0.5, inf');
  assert.equal(valueText({ type: 'string_array', value: ['a, b', 'c'] }), '"a, b", "c"');
  assert.deepEqual(parseValueText('42', 'integer'), { value: { type: 'integer', value: 42 } });
  assert.deepEqual(parseValueText('9007199254740993', 'integer'), { value: { type: 'integer', value: '9007199254740993' } });
  assert.deepEqual(parseValueText('4.2', 'integer'), { error: 'An integer' });
  assert.deepEqual(parseValueText('-.inf', 'double'), { value: { type: 'double', value: '-inf' } });
  assert.deepEqual(parseValueText('0.5, inf', 'double_array'), { value: { type: 'double_array', value: [0.5, 'inf'] } });
  assert.deepEqual(parseValueText('', 'integer_array'), { value: { type: 'integer_array', value: [] } });
  assert.deepEqual(parseValueText('"a, b", "c"', 'string_array'), { value: { type: 'string_array', value: ['a, b', 'c'] } });
  assert.deepEqual(parseValueText(' spaced ', 'string'), { value: { type: 'string', value: ' spaced ' } });
  assert.deepEqual(parseValueText('yes', 'bool'), { error: 'true or false' });
});

test('a new parameter’s type, as ros2 param set reads its value', () => {
  assert.deepEqual(inferValue('true'), { type: 'bool', value: true });
  assert.deepEqual(inferValue('3'), { type: 'integer', value: 3 });
  assert.deepEqual(inferValue('3.0'), { type: 'double', value: 3 });
  assert.deepEqual(inferValue('1e3'), { type: 'double', value: 1000 });
  assert.deepEqual(inferValue('.inf'), { type: 'double', value: 'inf' });
  assert.deepEqual(inferValue('map'), { type: 'string', value: 'map' });
  assert.deepEqual(inferValue('"42"'), { type: 'string', value: '42' });
  assert.deepEqual(inferValue('[1, 2]'), { type: 'integer_array', value: [1, 2] });
  assert.deepEqual(inferValue('[1, 2.5]'), { type: 'double_array', value: [1, 2.5] });
  assert.deepEqual(inferValue('[a, b]'), { type: 'string_array', value: ['a', 'b'] });
  assert.deepEqual(inferValue('[true, false]'), { type: 'bool_array', value: [true, false] });
});

test('ranges, ros2 param set commands, hidden nodes', () => {
  assert.equal(
    rangeText({ type: 'integer', description: '', additionalConstraints: '', readOnly: false, dynamicTyping: false, range: { from: 0, to: 255, step: 1 } }),
    '0 … 255, in steps of 1',
  );
  assert.equal(rangeText(null), null);
  assert.equal(setCommand('/turtlesim', 'background_r', { type: 'integer', value: 40 }), "ros2 param set /turtlesim background_r '40'");
  assert.equal(setCommand('/n', 'frame', { type: 'string', value: "it's" }), `ros2 param set /n frame '"it'\\''s"'`);
  assert.equal(setCommand('/n', 'limits', { type: 'double_array', value: [0.5, '-inf'] }), "ros2 param set /n limits '[0.5, -.inf]'");
  assert.equal(isHiddenNode('/_ros2cli_daemon_0'), true);
  assert.equal(isHiddenNode('/robot/amcl'), false);
});
