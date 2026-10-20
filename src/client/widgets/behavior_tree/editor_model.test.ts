import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BtNodeLibrary } from '../../../shared/protocol.ts';
import {
  addTree,
  behaviorTrees,
  buildCatalog,
  canUnwrap,
  dropTarget,
  insertionPoint,
  mainTree,
  newNode,
  removeTree,
  renameTree,
  treeFormat,
  treeGraph,
  withType,
} from './editor_model.ts';
import { layoutTree } from './layout.ts';
import { isNode, parseDocument, writeDocument } from './xml_document.ts';

const FILE = `<root BTCPP_format="4">
  <BehaviorTree ID="Main">
    <Sequence>
      <Action ID="Plan" goal="{goal}"/>
      <SubTree ID="Recover" _autoremap="true"/>
      <Inverter/>
      <Follow><Oops/></Follow>
    </Sequence>
  </BehaviorTree>
  <BehaviorTree ID="Recover">
    <Spin/>
  </BehaviorTree>
  <TreeNodesModel>
    <Action ID="Follow"><input_port name="path">The path</input_port></Action>
  </TreeNodesModel>
</root>`;

const NAV2: BtNodeLibrary = {
  name: 'Nav2',
  file: '/opt/ros/jazzy/share/nav2_behavior_tree/nav2_tree_nodes.xml',
  models: [{ id: 'Spin', kind: 'action', ports: [], description: '' }],
};

test('the trees of a file, and its main one', () => {
  const document = parseDocument(FILE);
  assert.deepEqual(behaviorTrees(document).map((tree) => tree.id), ['Main', 'Recover']);
  // Main: the tree no other uses
  assert.equal(mainTree(document)?.id, 'Main');
  assert.equal(treeFormat(document), 4);
  assert.equal(mainTree(parseDocument('<root main_tree_to_execute="B"><BehaviorTree ID="A"/><BehaviorTree ID="B"/></root>'))?.id, 'B');
});

test('a tree as the graph shows it: kinds, ports, what is wrong', () => {
  const document = parseDocument(FILE);
  const catalog = buildCatalog(document, [NAV2], [{ id: 'Elsewhere', file: '/trees/other.xml' }]);
  assert.equal(catalog.byId.get('Spin')?.library, 'Nav2');
  assert.equal(catalog.byId.get('Follow')?.library, 'This file');
  assert.equal(catalog.byId.get('Sequence')?.library, 'BT.CPP');
  assert.deepEqual(catalog.trees, ['Main', 'Recover', 'Elsewhere']);
  assert.equal(catalog.treeFiles.get('Elsewhere'), '/trees/other.xml');

  const graph = treeGraph(behaviorTrees(document)[0].node, catalog);
  assert.deepEqual(
    graph.nodes.map((node) => [node.type, node.name, node.kind, node.parent, node.capacity]),
    [
      ['BehaviorTree', 'Main', null, -1, 1],
      ['Sequence', 'Sequence', 'control', 0, Infinity],
      // In no library, but an Action
      ['Plan', 'Plan', 'action', 1, 0],
      ['SubTree', 'Recover', 'subtree', 1, 0],
      ['Inverter', 'Inverter', 'decorator', 1, 1],
      ['Follow', 'Follow', 'action', 1, 0],
      ['Oops', 'Oops', 'action', 5, 0],
    ],
  );
  assert.deepEqual(graph.nodes[2].ports, { goal: '{goal}' });
  assert.deepEqual(graph.nodes[3].ports, { ID: 'Recover', _autoremap: 'true' });
  assert.deepEqual(graph.children, [[1], [2, 3, 4, 5], [], [], [], [6], []]);
  assert.deepEqual(graph.nodes[4].problems, ['A decorator has one child, not 0']);
  assert.deepEqual(graph.nodes[5].problems, ['An action has no children: it has 1']);
  assert.equal(graph.problems, 2);

  const missing = treeGraph(parseDocument('<root><BehaviorTree ID="A"><SubTree ID="Nowhere"/><Spin/></BehaviorTree></root>').root.children.filter(isNode)[0], catalog);
  assert.deepEqual(missing.nodes[0].problems, ['A tree has one node at its root, not 2']);
  assert.deepEqual(missing.nodes[1].problems, ['No tree Nowhere, in the file nor its includes']);
});

test('where nodes may go', () => {
  const document = parseDocument(FILE);
  const catalog = buildCatalog(document, [NAV2], []);
  const graph = treeGraph(behaviorTrees(document)[0].node, catalog);
  const size = { width: 100, height: 40 };
  const { boxes } = layoutTree([0], (node) => graph.children[node], () => size, 'vertical', { siblings: 20, levels: 40 });
  const at = (node: number, along: number) => {
    const box = boxes.get(node)!;
    return { x: box.x + box.width * along, y: box.y + box.height / 2 };
  };
  // Into a control node at its middle, beside it at its sides
  assert.deepEqual(dropTarget(graph, boxes, at(1, 0.5), null, true), { parent: 1, index: 4, mode: 'into', node: 1 });
  // Beside the subtree, a leaf, whichever its side
  assert.deepEqual(dropTarget(graph, boxes, at(3, 0.4), null, true), { parent: 1, index: 1, mode: 'before', node: 3 });
  assert.deepEqual(dropTarget(graph, boxes, at(3, 0.6), null, true), { parent: 1, index: 2, mode: 'after', node: 3 });
  // Into the empty decorator
  assert.deepEqual(dropTarget(graph, boxes, at(4, 0.5), null, true), { parent: 4, index: 0, mode: 'into', node: 4 });
  // Not into the tree, which has its node; not beside it
  assert.equal(dropTarget(graph, boxes, at(0, 0.5), null, true), null);
  // A node moved: not into itself, nor where it is
  assert.equal(dropTarget(graph, boxes, at(6, 0.5), 5, true), null);
  assert.equal(dropTarget(graph, boxes, at(2, 0.9), 3, true), null);
  assert.equal(dropTarget(graph, boxes, at(4, 0.1), 3, true), null);
  assert.deepEqual(dropTarget(graph, boxes, at(4, 0.9), 3, true), { parent: 1, index: 3, mode: 'after', node: 4 });
  // Nowhere near a node
  assert.equal(dropTarget(graph, boxes, { x: -500, y: -500 }, null, true), null);

  // Added with the selection: into it, else after it
  assert.deepEqual(insertionPoint(graph, 1), { parent: 1, index: 4 });
  assert.deepEqual(insertionPoint(graph, 3), { parent: 1, index: 2 });
  assert.deepEqual(insertionPoint(graph, null), null);
  // Its children where it is: not four at the tree's root, not none
  assert.equal(canUnwrap(graph, 5), true);
  assert.equal(canUnwrap(graph, 1), false);
  assert.equal(canUnwrap(graph, 3), false);
});

test('trees added, renamed with their subtrees, removed', () => {
  const document = parseDocument(FILE);
  const added = addTree(document, 'Dock');
  assert.deepEqual(behaviorTrees(added.document).map((tree) => tree.id), ['Main', 'Recover', 'Dock']);
  assert.match(writeDocument(added.document), /<\/BehaviorTree>\n  <BehaviorTree ID="Dock"\/>\n  <TreeNodesModel>/);

  const recover = behaviorTrees(document)[1];
  const renamed = renameTree(document, recover.key, 'Recovery');
  assert.match(writeDocument(renamed), /<SubTree ID="Recovery" _autoremap="true"\/>/);
  assert.match(writeDocument(renamed), /<BehaviorTree ID="Recovery">/);

  const main = parseDocument('<root main_tree_to_execute="A"><BehaviorTree ID="A"/><BehaviorTree ID="B"/></root>');
  const [a] = behaviorTrees(main);
  assert.equal(renameTree(main, a.key, 'C').root.attributes.main_tree_to_execute, 'C');
  assert.equal(removeTree(main, a.key).root.attributes.main_tree_to_execute, undefined);
});

test('new nodes, and nodes of another type', () => {
  assert.deepEqual(newNode({ id: 'Spin', kind: 'action', ports: [], description: '' }, 4).attributes, {});
  assert.deepEqual(newNode({ id: 'Recover', kind: 'subtree', ports: [], description: '' }, 4).attributes, { ID: 'Recover', _autoremap: 'true' });
  assert.deepEqual(newNode({ id: 'Recover', kind: 'subtree', ports: [], description: '' }, 3).attributes, { ID: 'Recover', __shared_blackboard: 'true' });

  const document = parseDocument(FILE);
  const plan = behaviorTrees(document)[0].node.children.filter(isNode)[0].children.filter(isNode)[0];
  const replaced = withType(plan, { id: 'ComputePathToPose', kind: 'action', ports: [], description: '' }, 4);
  assert.equal(replaced.name, 'ComputePathToPose');
  assert.deepEqual(replaced.attributes, { goal: '{goal}' });
});
