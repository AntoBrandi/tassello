import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LogEntry, RosoutUpdate } from '../../../shared/protocol.ts';
import {
  EMPTY,
  filterLog,
  indexOfSeq,
  levelIndex,
  levelsFrom,
  logLine,
  nodeScope,
  reduce,
  runningNode,
  shortCount,
  textMatch,
  type Filter,
  type Model,
} from './model.ts';

const entry = (seq: number, name = 'talker', level = 20, msg = `message ${seq}`): LogEntry => ({
  seq,
  stamp: 1729435407512.3457 + seq,
  level,
  name,
  msg,
  file: 'talker.cpp',
  function: 'on_timer',
  line: 10,
});

function update(fields: Partial<RosoutUpdate>): RosoutUpdate {
  return { type: 'rosout', id: 1, reset: false, started: 100, entries: [], skipped: 0, nodes: null, ...fields };
}

const seqs = (entries: LogEntry[]) => entries.map((e) => e.seq);

function opened(entries: LogEntry[], nodes: string[] = []): Model {
  return reduce(EMPTY, { type: 'update', update: update({ reset: true, entries, nodes }) });
}

const ALL: Filter = { scope: null, nodes: new Set(), levels: levelsFrom('debug'), include: null, exclude: null };

test('levels, from rcl_interfaces/msg/Log', () => {
  assert.deepEqual([0, 10, 20, 30, 40, 50, 55].map(levelIndex), [0, 0, 1, 2, 3, 4, 4]);
  assert.deepEqual([...levelsFrom('warn')], ['warn', 'error', 'fatal']);
});

test('the history, then the new messages, and the nodes running', () => {
  let model = opened([entry(1), entry(2)], ['/talker', '/robot1/amcl']);
  assert.equal(model.received, true);
  assert.equal(model.running.get('robot1.amcl'), '/robot1/amcl');
  model = reduce(model, { type: 'update', update: update({ entries: [entry(3)], skipped: 4 }) });
  assert.deepEqual(seqs(model.entries), [1, 2, 3]);
  assert.equal(model.skipped, 4);
  // nodes null: as before
  assert.equal(model.running.size, 2);
});

test('paused, the new messages wait until resumed', () => {
  let model = reduce(opened([entry(1)]), { type: 'pause' });
  model = reduce(model, { type: 'update', update: update({ entries: [entry(2), entry(3)] }) });
  assert.deepEqual(seqs(model.entries), [1]);
  assert.deepEqual(seqs(model.pending), [2, 3]);
  model = reduce(model, { type: 'resume' });
  assert.deepEqual(seqs(model.entries), [1, 2, 3]);
  assert.deepEqual(model.pending, []);
});

test('a reconnection keeps what was cleared away, and what paused shows', () => {
  let model = opened([entry(1), entry(2)]);
  model = reduce(model, { type: 'clear' });
  assert.deepEqual(model.entries, []);
  model = reduce(model, { type: 'update', update: update({ entries: [entry(3)] }) });
  model = reduce(model, { type: 'pause' });
  const version = model.version;
  // The server sends its history again
  model = reduce(model, { type: 'update', update: update({ reset: true, entries: [1, 2, 3, 4, 5].map((s) => entry(s)) }) });
  assert.deepEqual(seqs(model.entries), [3]);
  assert.deepEqual(seqs(model.pending), [4, 5]);
  assert.equal(model.version, version);
});

test('a log started over is another: what was cleared of the last one is not', () => {
  let model = reduce(opened([entry(1), entry(2), entry(3)]), { type: 'clear' });
  const version = model.version;
  model = reduce(model, { type: 'update', update: update({ reset: true, started: 200, entries: [entry(1), entry(2)] }) });
  assert.deepEqual(seqs(model.entries), [1, 2]);
  assert.equal(model.cleared, null);
  assert.equal(model.version, version + 1);
});

test('messages by seq', () => {
  const entries = [2, 4, 6, 8].map((s) => entry(s));
  assert.equal(indexOfSeq(entries, 4), 1);
  assert.equal(indexOfSeq(entries, 5), 2);
  assert.equal(indexOfSeq(entries, 1), 0);
  assert.equal(indexOfSeq(entries, 9), 4);
});

test('the loggers of the nodes running, their children too', () => {
  const running = new Map([['robot1.amcl', '/robot1/amcl']]);
  assert.equal(runningNode('robot1.amcl', running), '/robot1/amcl');
  assert.equal(runningNode('robot1.amcl.costmap', running), '/robot1/amcl');
  assert.equal(runningNode('robot1', running), null);
  assert.equal(runningNode('talker', running), null);
});

test('text filters: any of their terms, or a regular expression, case aside', () => {
  const terms = textMatch(' Timeout; costmap ;', false);
  assert.equal(terms.test?.('Planner TIMEOUT'), true);
  assert.equal(terms.test?.('Clearing the costmap'), true);
  assert.equal(terms.test?.('Goal reached'), false);
  assert.equal(textMatch('  ', false).test, null);
  const regex = textMatch('^goal (reached|aborted)$', true);
  assert.equal(regex.test?.('Goal reached'), true);
  assert.equal(regex.test?.('A goal reached'), false);
  const invalid = textMatch('goal (', true);
  assert.equal(invalid.test, null);
  assert.ok(invalid.error);
});

test('the nodes of a widget: by name or logger, with globs and child loggers', () => {
  const scope = nodeScope('/robot1/amcl, *_server;bt_navigator')!;
  assert.equal(scope('robot1.amcl'), true);
  assert.equal(scope('robot1.amcl.costmap'), true);
  assert.equal(scope('robot1.amcl_extra'), false);
  assert.equal(scope('planner_server'), true);
  assert.equal(scope('bt_navigator'), true);
  assert.equal(scope('talker'), false);
  assert.equal(nodeScope(' ; '), null);
});

test('filtered: by scope, node, text and level, counted along the way', () => {
  const entries = [
    entry(1, 'talker', 20, 'Publishing: hello'),
    entry(2, 'talker', 30, 'Slow down'),
    entry(3, 'amcl', 40, 'No map received'),
    entry(4, 'amcl', 20, 'Publishing: pose'),
    entry(5, 'planner_server', 50, 'Out of memory'),
  ];
  const running = new Map([
    ['amcl', '/amcl'],
    ['listener', '/listener'],
  ]);

  const all = filterLog(entries, running, ALL);
  assert.deepEqual(seqs(all.shown), [1, 2, 3, 4, 5]);
  assert.deepEqual(all.levels, [0, 2, 1, 1, 1]);
  assert.deepEqual(
    all.nodes.map((n) => [n.name, n.node, n.total]),
    [
      ['amcl', '/amcl', 2],
      ['listener', '/listener', 0],
      ['planner_server', null, 1],
      ['talker', null, 2],
    ],
  );

  const some = filterLog(entries, running, {
    ...ALL,
    scope: nodeScope('talker amcl'),
    levels: levelsFrom('warn'),
    exclude: textMatch('map', false).test,
  });
  assert.deepEqual(seqs(some.shown), [2]);
  // Of the levels not shown too
  assert.deepEqual(some.levels, [0, 2, 1, 0, 0]);
  assert.equal(some.total, 4);
  assert.deepEqual(
    some.nodes.map((n) => n.name),
    ['amcl', 'talker'],
  );

  const chosen = filterLog(entries, running, { ...ALL, nodes: new Set(['amcl', 'gone']), include: textMatch('publishing', false).test });
  assert.deepEqual(seqs(chosen.shown), [4]);
  // Chosen, it stays listed
  assert.ok(chosen.nodes.some((n) => n.name === 'gone' && n.total === 0));
});

test('lines as ROS prints them, and short counts', () => {
  assert.equal(logLine(entry(1, 'robot1.amcl', 30, 'Setting pose')), '[WARN] [1729435407.513346] [robot1.amcl]: Setting pose');
  assert.deepEqual([7, 999, 1000, 1250, 9999, 12_400].map(shortCount), ['7', '999', '1k', '1.3k', '10k', '12k']);
});
