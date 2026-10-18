import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineWidget, type RegisteredWidget } from './types.ts';
import { resolveConfig, WidgetRegistry } from './widget_registry.ts';

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
