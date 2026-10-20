import assert from 'node:assert/strict';
import { test } from 'node:test';

import { languageOf, tokenizeLine, type Language } from './highlight.ts';

// The line's tokens, as text: plain parts left out
function tokens(language: Language, line: string, state = 0): { parts: string[]; state: number } {
  const { spans, state: next } = tokenizeLine(language, line, state);
  assert.equal(
    spans.reduce((sum, [length]) => sum + length, 0),
    line.length,
    'the spans make the line',
  );
  const parts: string[] = [];
  let at = 0;
  for (const [length, token] of spans) {
    const text = line.slice(at, at + length);
    if (token && text.trim()) {
      parts.push(`${token}:${text}`);
    }
    at += length;
  }
  return { parts, state: next };
}

test('languages by name, extension and first line', () => {
  assert.equal(languageOf('nav2_params.yaml'), 'yaml');
  assert.equal(languageOf('robot.urdf.xacro'), 'xml');
  assert.equal(languageOf('bringup.launch.py'), 'python');
  assert.equal(languageOf('CMakeLists.txt'), 'cmake');
  assert.equal(languageOf('Pose.msg'), 'ros');
  assert.equal(languageOf('robot.service'), 'ini');
  assert.equal(languageOf('.bashrc'), 'shell');
  assert.equal(languageOf('setup', '#!/usr/bin/env bash'), 'shell');
  assert.equal(languageOf('node', '#!/usr/bin/python3'), 'python');
  assert.equal(languageOf('notes'), 'plain');
});

test('YAML: keys, list marks, values and comments', () => {
  assert.deepEqual(tokens('yaml', 'controller_server:').parts, ['key:controller_server:']);
  assert.deepEqual(tokens('yaml', '  - name: lidar # front').parts, ['punctuation:-', 'key:name:', 'comment:# front']);
  assert.deepEqual(tokens('yaml', '    use_sim_time: false').parts, ['key:use_sim_time:', 'atom:false']);
  assert.deepEqual(tokens('yaml', '    max_vel_x: 0.26').parts, ['key:max_vel_x:', 'number:0.26']);
  assert.deepEqual(tokens('yaml', '    plugin: "nav2_navfn_planner/NavfnPlanner"').parts, [
    'key:plugin:',
    'string:"nav2_navfn_planner/NavfnPlanner"',
  ]);
  assert.deepEqual(tokens('yaml', '    url: http://robot:8080/x').parts, ['key:url:']);
  assert.deepEqual(tokens('yaml', '/**:').parts, ['key:/**:']);
});

test('XML: tags, attributes and comments, over lines', () => {
  assert.deepEqual(tokens('xml', '<link name="base_link">').parts, [
    'punctuation:<',
    'tag:link',
    'attribute:name',
    'punctuation:=',
    'string:"base_link"',
    'punctuation:>',
  ]);
  const open = tokens('xml', '<joint name="j1"');
  assert.equal(open.state, 3);
  assert.deepEqual(tokens('xml', '       type="revolute"/>', open.state).parts, [
    'attribute:type',
    'punctuation:=',
    'string:"revolute"',
    'punctuation:/>',
  ]);
  const comment = tokens('xml', 'x <!-- a comment');
  assert.deepEqual(comment.parts, ['comment:<!-- a comment']);
  assert.deepEqual(tokens('xml', 'still --> <a/>', comment.state).parts, ['comment:still -->', 'punctuation:<', 'tag:a', 'punctuation:/>']);
  assert.deepEqual(tokens('xml', '<arg name="m" default="$(find-pkg-share x)/m.yaml"/>').parts.slice(-2), [
    'string:"$(find-pkg-share x)/m.yaml"',
    'punctuation:/>',
  ]);
});

test('Python: keywords, names defined, strings over lines', () => {
  assert.deepEqual(tokens('python', 'def generate_launch_description():').parts, ['keyword:def', 'function:generate_launch_description']);
  assert.deepEqual(tokens('python', 'from launch import LaunchDescription  # x').parts, ['keyword:from', 'keyword:import', 'comment:# x']);
  assert.deepEqual(tokens('python', "    return f'{x}' if True else 0x1F").parts, [
    'keyword:return',
    "string:f'{x}'",
    'keyword:if',
    'atom:True',
    'keyword:else',
    'number:0x1F',
  ]);
  const doc = tokens('python', '"""A node,');
  assert.equal(doc.state, 1);
  assert.deepEqual(tokens('python', 'documented""" + x', doc.state), { parts: ['string:documented"""'], state: 0 });
});

test('C++: preprocessor, types, block comments', () => {
  assert.deepEqual(tokens('cpp', '#include <rclcpp/rclcpp.hpp>').parts, ['meta:#include', 'string:<rclcpp/rclcpp.hpp>']);
  assert.deepEqual(tokens('cpp', 'const uint8_t n = 10u; // ten').parts, ['keyword:const', 'type:uint8_t', 'number:10u', 'comment:// ten']);
  const block = tokens('cpp', 'int x; /* start');
  assert.equal(block.state, 1);
  assert.deepEqual(tokens('cpp', 'end */ return x;', block.state).parts, ['comment:end */', 'keyword:return']);
});

test('the others: JSON, shell, CMake, INI, Markdown, ROS interfaces', () => {
  assert.deepEqual(tokens('json', '{"rate": 10.5, "on": true}').parts, ['punctuation:{', 'key:"rate"', 'punctuation::', 'number:10.5', 'punctuation:,', 'key:"on"', 'punctuation::', 'atom:true', 'punctuation:}']);
  assert.deepEqual(tokens('shell', 'export ROS_DOMAIN_ID=42 # x').parts, ['keyword:export', 'variable:ROS_DOMAIN_ID', 'punctuation:=', 'number:42', 'comment:# x']);
  assert.deepEqual(tokens('shell', 'source "${HOME}/ws/install/setup.bash"').parts, ['keyword:source', 'string:"${HOME}/ws/install/setup.bash"']);
  assert.deepEqual(tokens('cmake', 'find_package(rclcpp REQUIRED)').parts, ['function:find_package', 'atom:REQUIRED']);
  assert.deepEqual(tokens('ini', 'ExecStart=/usr/bin/tassello --port 8080').parts, ['key:ExecStart', 'punctuation:=', 'number:8080']);
  assert.deepEqual(tokens('ini', '[Service]').parts, ['tag:[Service]']);
  assert.deepEqual(tokens('markdown', '## Install').parts, ['heading:## Install']);
  assert.equal(tokens('markdown', '```bash').state, 1);
  assert.deepEqual(tokens('markdown', 'colcon build', 1).parts, ['string:colcon build']);
  assert.deepEqual(tokens('ros', 'geometry_msgs/Pose[] poses  # the way').parts, ['type:geometry_msgs/Pose[]', 'comment:# the way']);
  assert.deepEqual(tokens('ros', 'uint8 MODE_AUTO=1').parts, ['type:uint8', 'atom:MODE_AUTO', 'punctuation:=', 'number:1']);
  assert.deepEqual(tokens('plain', 'just text').parts, []);
});

test('lines too long are plain past a point', () => {
  const line = `${'"a",'.repeat(2000)}`;
  const { spans } = tokenizeLine('json', line, 0);
  assert.equal(spans.at(-1)![1], '');
  assert.equal(spans.reduce((sum, [length]) => sum + length, 0), line.length);
});
