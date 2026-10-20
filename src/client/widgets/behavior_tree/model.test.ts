import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BehaviorTreeInfo, BehaviorTreeUpdate, BtNode } from '../../../shared/protocol.ts';
import { activeNodes, EMPTY, reduce } from './model.ts';

const node = (name: string, parent: number): BtNode => ({ name, type: name, kind: 'action', parent, ports: {} });
const info: BehaviorTreeInfo = {
  type: 'bt.tree',
  id: 1,
  treeId: 'Main',
  nodes: [node('Root', -1), node('A', 0), node('B', 0), node('B1', 2)],
  error: null,
  warnings: [],
};

function update(fields: Partial<BehaviorTreeUpdate>): BehaviorTreeUpdate {
  return { type: 'bt', id: 1, reset: false, added: [], states: [], transitions: [], mismatch: null, ...fields };
}

const state = (index: number, status: string) => ({
  node: index,
  status,
  result: null,
  since: 1,
  changes: 1,
  successes: 0,
  failures: 0,
});

test('the tree, then its states and transitions', () => {
  let model = reduce(EMPTY, { type: 'tree', tree: info });
  assert.deepEqual(model.children, [[1, 2], [], [3], []]);
  assert.deepEqual(model.depths, [0, 1, 1, 2]);
  model = reduce(model, {
    type: 'update',
    update: update({
      reset: true,
      states: [state(0, 'RUNNING'), state(2, 'RUNNING'), state(3, 'RUNNING')],
      transitions: [{ time: 5, node: 3, from: 'IDLE', to: 'RUNNING' }],
    }),
  });
  assert.deepEqual(activeNodes(model), [3]);
  // Folded away, B1 shows as B
  assert.deepEqual(activeNodes(model, (n) => (n === 3 ? 2 : n)), [2]);
  model = reduce(model, {
    type: 'update',
    update: update({
      added: [node('Docking', -1)],
      states: [state(3, 'SUCCESS')],
      transitions: [{ time: 6, node: 3, from: 'RUNNING', to: 'SUCCESS' }],
      mismatch: 'A node of the log not in the tree file',
    }),
  });
  assert.equal(model.nodes.length, 5);
  assert.equal(model.treeSize, 4);
  assert.equal(model.states[0]?.status, 'RUNNING');
  assert.equal(model.states[3]?.status, 'SUCCESS');
  assert.deepEqual(model.transitions.map((t) => t.id), [0, 1]);
  assert.deepEqual(activeNodes(model), [2]);
});

test('a reset replaces the states and the nodes added', () => {
  let model = reduce(EMPTY, { type: 'tree', tree: info });
  model = reduce(model, { type: 'update', update: update({ added: [node('X', -1)], states: [state(1, 'FAILURE')] }) });
  model = reduce(model, { type: 'update', update: update({ reset: true, added: [node('Y', -1)], states: [state(2, 'IDLE')] }) });
  assert.deepEqual(model.nodes.map((n) => n.name), ['Root', 'A', 'B', 'B1', 'Y']);
  assert.equal(model.states[1], undefined);
  assert.equal(model.states[2]?.status, 'IDLE');
});

test('the same tree again (the connection came back) keeps what is shown until the reset', () => {
  let model = reduce(EMPTY, { type: 'tree', tree: info });
  model = reduce(model, { type: 'update', update: update({ reset: true, states: [state(1, 'RUNNING')] }) });
  const again = reduce(model, { type: 'tree', tree: { ...info } });
  assert.equal(again.version, model.version);
  assert.equal(again.states[1]?.status, 'RUNNING');
  const other = reduce(model, { type: 'tree', tree: { ...info, nodes: info.nodes.slice(0, 2) } });
  assert.equal(other.version, model.version + 1);
  assert.equal(other.states.length, 0);
});
