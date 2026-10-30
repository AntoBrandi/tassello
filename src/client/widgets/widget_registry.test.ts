import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineStatusWidget, defineWidget, type RegisteredStatusWidget, type RegisteredWidget } from './types.ts';
import { resolveConfig, StatusWidgetRegistry, WidgetRegistry } from './widget_registry.ts';

function widget(type: string): RegisteredWidget {
  return defineWidget<{ topic: string; speed: number; mode: 'a' | 'b' }>({
    type,
    name: type,
    description: '',
    icon: () => null,
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    component: () => null,
    properties: [
      { key: 'topic', label: 'Topic', kind: 'string', default: 'cmd_vel' },
      { key: 'speed', label: 'Speed', kind: 'number', default: 0.2 },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        default: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ],
  });
}

test('plugins add widgets, after the core ones, by plugin', () => {
  const registry = new WidgetRegistry([widget('teleop')]);
  assert.deepEqual(registry.registerPlugin('robot', { widgets: [widget('robot.gripper')] }), []);
  assert.deepEqual(
    registry.entries().map((e) => [e.definition.type, e.plugin]),
    [
      ['teleop', null],
      ['robot.gripper', 'robot'],
    ],
  );
  // A type taken is refused
  assert.match(registry.registerPlugin('other', { widgets: [widget('teleop')] })[0], /already Tassello's/);
  assert.match(registry.registerPlugin('other', { widgets: [widget('robot.gripper')] })[0], /already robot's/);
  assert.equal(registry.entries().length, 2);
});

test('plugins change the defaults of the properties, if they fit', () => {
  const registry = new WidgetRegistry([widget('teleop')]);
  const problems = registry.registerPlugin('robot', {
    defaults: { teleop: { topic: 'web_vel', speed: '0.06', mode: 'b', missing: 1 }, later: { x: 1 } },
  });
  assert.equal(problems.length, 2);
  const teleop = registry.definition('teleop')!;
  assert.deepEqual(resolveConfig(teleop, {}), { topic: 'web_vel', speed: 0.2, mode: 'b' });
  // What the panel sets wins
  assert.deepEqual(resolveConfig(teleop, { topic: '/cmd', speed: 1, mode: 'c' }), { topic: '/cmd', speed: 1, mode: 'b' });
  // Defaults for a widget a later plugin adds
  registry.registerPlugin('other', { widgets: [widget('later')] });
  assert.equal(registry.definition('later')!.properties.length, 3);
});

test('selects with options known at run time keep any value of their type', () => {
  const robot = defineWidget<{ robot: string }>({
    type: 'robot',
    name: 'robot',
    description: '',
    icon: () => null,
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    component: () => null,
    properties: [
      {
        key: 'robot',
        label: 'Robot',
        kind: 'select',
        default: '',
        options: [{ value: '', label: 'None' }],
        useOptions: () => [],
      },
    ],
  });
  assert.deepEqual(resolveConfig(robot, { robot: 'tiago-1' }), { robot: 'tiago-1' });
  assert.deepEqual(resolveConfig(robot, { robot: 1 }), { robot: '' });
});

function statusWidget(type: string): RegisteredStatusWidget {
  return defineStatusWidget<{ warnAbove: number }>({
    type,
    name: type,
    description: '',
    icon: () => null,
    defaultWidth: 3,
    minWidth: 1,
    component: () => null,
    properties: [{ key: 'warnAbove', label: 'Warn above', kind: 'number', default: 75 }],
  });
}

test('status widgets: a registry of their own, their types unique across both', () => {
  const widgets: WidgetRegistry = new WidgetRegistry([widget('teleop')], (type) => statuses.owner(type));
  const statuses: StatusWidgetRegistry = new StatusWidgetRegistry([statusWidget('cpu-status')], (type) => widgets.owner(type));
  const register = (name: string, plugin: Parameters<WidgetRegistry['registerPlugin']>[1]) => [
    ...widgets.registerPlugin(name, plugin),
    ...statuses.registerPlugin(name, plugin),
  ];
  assert.deepEqual(
    register('robot', { widgets: [widget('robot.battery')], statusWidgets: [statusWidget('robot.battery-status')] }),
    [],
  );
  assert.deepEqual(
    statuses.entries().map((e) => [e.definition.type, e.plugin]),
    [
      ['cpu-status', null],
      ['robot.battery-status', 'robot'],
    ],
  );
  assert.equal(widgets.entries().length, 2);
  // Taken in the other registry, or in this one
  assert.deepEqual(register('other', { widgets: [widget('cpu-status')], statusWidgets: [statusWidget('teleop'), statusWidget('robot.battery-status')] }), [
    'its widget type "cpu-status" is already Tassello\'s, as a status widget',
    'its status widget type "teleop" is already Tassello\'s, as a widget',
    'its status widget type "robot.battery-status" is already robot\'s',
  ]);

  // The defaults go to the registry of their type; only its own are checked
  assert.deepEqual(register('defaults', { defaults: { 'cpu-status': { warnAbove: 90 }, teleop: { speed: 1 } } }), []);
  assert.deepEqual(resolveConfig(statuses.definition('cpu-status')!, {}), { warnAbove: 90 });
  assert.equal(register('wrong', { defaults: { 'cpu-status': { warnAbove: 'high' } } }).length, 1);
});
