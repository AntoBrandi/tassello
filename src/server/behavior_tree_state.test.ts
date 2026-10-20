import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BtNode } from '../shared/protocol.ts';
import { logTransitions, type LogTransition } from './behavior_tree_log.ts';
import { BehaviorTreeState } from './behavior_tree_state.ts';

// Nav2's navigate_to_pose_w_replanning_and_recovery.xml (Humble), as
// behavior_tree_file.ts makes it: [name, type, parent]
const NAV2: [string, string, number][] = [
  ['NavigateRecovery', 'RecoveryNode', -1], // 0
  ['NavigateWithReplanning', 'PipelineSequence', 0],
  ['RateController', 'RateController', 1],
  ['ComputePathToPose', 'RecoveryNode', 2], // 3
  ['ComputePathToPose', 'ComputePathToPose', 3], // 4
  ['ClearGlobalCostmap-Context', 'ClearEntireCostmap', 3],
  ['FollowPath', 'RecoveryNode', 1], // 6
  ['FollowPath', 'FollowPath', 6], // 7
  ['ClearLocalCostmap-Context', 'ClearEntireCostmap', 6], // 8
  ['RecoveryFallback', 'ReactiveFallback', 0],
  ['GoalUpdated', 'GoalUpdated', 9],
  ['RecoveryActions', 'RoundRobin', 9], // 11
  ['ClearingActions', 'Sequence', 11],
  ['ClearLocalCostmap-Subtree', 'ClearEntireCostmap', 12],
  ['ClearGlobalCostmap-Subtree', 'ClearEntireCostmap', 12],
  ['Spin', 'Spin', 11], // 15
  ['Wait', 'Wait', 11],
  ['BackUp', 'BackUp', 11],
];
const tree: BtNode[] = NAV2.map(([name, type, parent]) => ({ name, type, kind: null, parent, ports: {} }));

// [name, from, to, the node expected], uid: its index + offset if given
function play(state: BehaviorTreeState, steps: [string, string, string, number][], uidOffset: number | null = null) {
  steps.forEach(([name, from, to, expected], i) => {
    const uid = uidOffset === null ? null : expected + uidOffset;
    state.apply({ uid, name, from, to, time: 1000 + i }, 5000 + i);
    const changes = state.takeChanges();
    assert.equal(changes?.transitions[0].node, expected, `step ${i}: ${name} ${from} -> ${to}`);
  });
}

// What BT.CPP logs as Nav2 starts navigating, replans once, and recovers
// from FollowPath failing
const NAVIGATING: [string, string, string, number][] = [
  ['NavigateRecovery', 'IDLE', 'RUNNING', 0],
  ['NavigateWithReplanning', 'IDLE', 'RUNNING', 1],
  ['RateController', 'IDLE', 'RUNNING', 2],
  ['ComputePathToPose', 'IDLE', 'RUNNING', 3],
  ['ComputePathToPose', 'IDLE', 'RUNNING', 4],
  // The planner is done: the RecoveryNode halts its children, then succeeds
  ['ComputePathToPose', 'RUNNING', 'SUCCESS', 4],
  ['ComputePathToPose', 'SUCCESS', 'IDLE', 4],
  ['ComputePathToPose', 'RUNNING', 'IDLE', 3],
  ['ComputePathToPose', 'IDLE', 'SUCCESS', 3],
  ['ComputePathToPose', 'SUCCESS', 'IDLE', 3],
  ['RateController', 'RUNNING', 'SUCCESS', 2],
  ['FollowPath', 'IDLE', 'RUNNING', 6],
  ['FollowPath', 'IDLE', 'RUNNING', 7],
  // The controller fails: the local costmap is cleared, and it goes again
  ['FollowPath', 'RUNNING', 'FAILURE', 7],
  ['ClearLocalCostmap-Context', 'IDLE', 'RUNNING', 8],
  ['ClearLocalCostmap-Context', 'RUNNING', 'SUCCESS', 8],
  ['FollowPath', 'FAILURE', 'IDLE', 7],
  ['ClearLocalCostmap-Context', 'SUCCESS', 'IDLE', 8],
  ['FollowPath', 'IDLE', 'RUNNING', 7],
  // Done
  ['FollowPath', 'RUNNING', 'SUCCESS', 7],
  ['FollowPath', 'SUCCESS', 'IDLE', 7],
  ['FollowPath', 'RUNNING', 'IDLE', 6],
  ['FollowPath', 'IDLE', 'SUCCESS', 6],
];

test('without UIDs, nodes of the same name are told apart by their status and parents', () => {
  play(new BehaviorTreeState(tree), NAVIGATING);
});

test('with UIDs, nodes are known by them once their offset is found', () => {
  // BT.CPP numbers from 1; ambiguous names until two transitions agree
  play(new BehaviorTreeState(tree), NAVIGATING, 1);
  // The heuristics would get this wrong: the UID tells
  const state = new BehaviorTreeState(tree);
  play(state, NAVIGATING.slice(0, 5), 1);
  state.apply({ uid: 4, name: 'ComputePathToPose', from: 'RUNNING', to: 'FAILURE', time: 0 }, 0);
  assert.equal(state.takeChanges()?.transitions[0].node, 3);
});

test('a page that comes while navigating tells nodes of the same name apart too', () => {
  const state = new BehaviorTreeState(tree);
  // Replanning shows the branch running; FollowPath's nodes are not known yet
  play(state, NAVIGATING.slice(3, 11));
  play(state, NAVIGATING.slice(19));
});

test('a node and its counts', () => {
  const state = new BehaviorTreeState(tree);
  play(state, NAVIGATING);
  const followPath = state.snapshot().states.find((s) => s.node === 7);
  assert.deepEqual(followPath, {
    node: 7,
    status: 'IDLE',
    result: 'SUCCESS',
    since: 5000 + 20,
    changes: 6,
    successes: 1,
    failures: 1,
  });
});

test('a running node shows its ancestors running, as they were before the page came', () => {
  const state = new BehaviorTreeState(tree);
  state.apply({ uid: null, name: 'Spin', from: 'IDLE', to: 'RUNNING', time: 0 }, 10);
  const changes = state.takeChanges()!;
  assert.deepEqual(
    changes.states.map((s) => [s.node, s.status, s.since]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [
      [0, 'RUNNING', 0],
      [9, 'RUNNING', 0],
      [11, 'RUNNING', 0],
      [15, 'RUNNING', 10],
    ],
  );
  assert.equal(state.takeChanges(), null);
});

test('nodes not in the tree are added, and reported', () => {
  const state = new BehaviorTreeState(tree);
  state.apply({ uid: null, name: 'DockRobot', from: 'IDLE', to: 'RUNNING', time: 0 }, 0);
  const changes = state.takeChanges()!;
  assert.deepEqual(changes.added, [{ name: 'DockRobot', type: 'DockRobot', kind: null, parent: -1, ports: {} }]);
  assert.equal(changes.transitions[0].node, tree.length);
  assert.match(changes.mismatch ?? '', /^A node of the log not in the tree file \(DockRobot\)/);
  assert.deepEqual(state.snapshot().added.map((node) => node.name), ['DockRobot']);
});

test('UIDs that do not fit the tree are reported, and nodes found by name', () => {
  const state = new BehaviorTreeState(tree);
  for (const [name, uid] of [['Spin', 50], ['Wait', 90], ['BackUp', 7]] as const) {
    state.apply({ uid, name, from: 'IDLE', to: 'RUNNING', time: 0 }, 0);
  }
  const changes = state.takeChanges()!;
  assert.deepEqual(changes.transitions.map((t) => t.node), [15, 16, 17]);
  assert.match(changes.mismatch ?? '', /^UIDs of the log that do not fit/);
});

test('without a tree, the nodes are the log’s, by UID and name', () => {
  const state = new BehaviorTreeState([]);
  const transitions: LogTransition[] = [
    { uid: 3, name: 'Sequence', from: 'IDLE', to: 'RUNNING', time: 0 },
    { uid: 7, name: 'Sequence', from: 'IDLE', to: 'RUNNING', time: 0 },
    { uid: 3, name: 'Sequence', from: 'RUNNING', to: 'SUCCESS', time: 0 },
  ];
  transitions.forEach((t) => state.apply(t, 0));
  const changes = state.takeChanges()!;
  assert.deepEqual(changes.added.map((node) => node.name), ['Sequence', 'Sequence']);
  assert.deepEqual(changes.transitions.map((t) => t.node), [0, 1, 0]);
  assert.equal(changes.mismatch, null);
});

test('the log’s messages are read, with UIDs or without', () => {
  const stamp = { sec: 10, nanosec: 500_000_000 };
  assert.deepEqual(
    logTransitions({
      timestamp: stamp,
      event_log: [
        { timestamp: stamp, node_name: 'Spin', uid: 4, previous_status: 'IDLE', current_status: 'RUNNING' },
        { timestamp: { sec: 0, nanosec: 0 }, node_name: 'Wait', previous_status: 'running', current_status: 'success' },
      ],
    }),
    [
      { uid: 4, name: 'Spin', from: 'IDLE', to: 'RUNNING', time: 10500 },
      { uid: null, name: 'Wait', from: 'RUNNING', to: 'SUCCESS', time: 10500 },
    ],
  );
  assert.throws(() => logTransitions({ data: 'hello' }), /not a log of transitions/);
});
