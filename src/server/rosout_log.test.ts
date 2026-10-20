import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LogHistory, logEntry, nodeNames } from './rosout_log.ts';

// As rclnodejs gives an rcl_interfaces/msg/Log
const log = (msg: string, level = 20) => ({
  stamp: { sec: 1729435407, nanosec: 512_345_678 },
  level,
  name: 'robot1.amcl',
  msg,
  file: 'amcl_node.cpp',
  function: 'initialPoseReceived',
  line: 42,
});

test('log messages, their stamp in milliseconds', () => {
  const entry = logEntry(log('Setting pose', 30), 7);
  assert.equal(entry.seq, 7);
  assert.equal(entry.level, 30);
  assert.equal(entry.name, 'robot1.amcl');
  assert.equal(entry.msg, 'Setting pose');
  assert.equal(entry.function, 'initialPoseReceived');
  assert.equal(entry.line, 42);
  assert.ok(Math.abs(entry.stamp - 1729435407512.3457) < 0.001);
});

test('missing or mistyped fields are empty', () => {
  assert.deepEqual(logEntry({ level: 40n, msg: 3 }, 1), {
    seq: 1,
    stamp: 0,
    level: 40,
    name: '',
    msg: '',
    file: '',
    function: '',
    line: 0,
  });
  assert.equal(logEntry(null, 2).msg, '');
});

test('the latest messages are kept, numbered as they come', () => {
  const history = new LogHistory(10);
  for (let i = 1; i <= 25; i++) {
    history.add(log(`message ${i}`));
  }
  const kept = history.snapshot();
  assert.equal(kept.length, 10);
  assert.deepEqual(
    kept.map((entry) => entry.seq),
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  );
  assert.equal(kept[0].msg, 'message 16');
});

test('batches: what came since the last, the oldest skipped beyond the maximum', () => {
  const history = new LogHistory(100);
  assert.equal(history.takeBatch(5), null);
  history.add(log('a'));
  history.add(log('b'));
  assert.deepEqual(
    history.takeBatch(5)?.entries.map((entry) => entry.msg),
    ['a', 'b'],
  );
  assert.equal(history.takeBatch(5), null);
  for (let i = 0; i < 8; i++) {
    history.add(log(`burst ${i}`));
  }
  const batch = history.takeBatch(5);
  assert.equal(batch?.skipped, 3);
  assert.deepEqual(
    batch?.entries.map((entry) => entry.msg),
    ['burst 3', 'burst 4', 'burst 5', 'burst 6', 'burst 7'],
  );
});

test('a batch never holds more than the history', () => {
  const history = new LogHistory(4);
  for (let i = 0; i < 9; i++) {
    history.add(log(`m${i}`));
  }
  const batch = history.takeBatch(100);
  assert.equal(batch?.entries.length, 4);
  assert.equal(batch?.skipped, 5);
  assert.deepEqual(
    batch?.entries.map((entry) => entry.seq),
    [6, 7, 8, 9],
  );
});

test('the nodes of the graph, by full name, without the hidden ones', () => {
  assert.deepEqual(
    nodeNames([
      { name: 'talker', namespace: '/' },
      { name: 'amcl', namespace: '/robot1' },
      { name: '_ros2cli_daemon_0_90392a34', namespace: '/' },
      { name: 'talker', namespace: '/' },
      { name: 'planner_server', namespace: '/robot1/nav/' },
    ]),
    ['/robot1/amcl', '/robot1/nav/planner_server', '/talker'],
  );
});
