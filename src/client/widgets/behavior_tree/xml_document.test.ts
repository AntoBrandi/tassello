import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloneNode,
  createNode,
  insertNode,
  isNode,
  locate,
  moveNode,
  parseDocument,
  removeNode,
  renameAttribute,
  setAttribute,
  unwrapNode,
  wrapNode,
  writeDocument,
  type XmlDocument,
  type XmlNode,
} from './xml_document.ts';

const FILE = `<?xml version="1.0"?>
<!--
  A tree, its comments kept
-->
<root BTCPP_format="4"
      main_tree_to_execute="Main">
    <BehaviorTree ID="Main">
        <Sequence name="Navigate">
            <!-- First, the path -->
            <ComputePathToPose goal="{goal}"   path="{path}"/>

            <FollowPath path="{path}" />
            <RetryUntilSuccessful num_attempts="3"><Spin spin_dist="1.57"/></RetryUntilSuccessful>
        </Sequence>
    </BehaviorTree>
    <TreeNodesModel>
        <Action ID="Spin"><input_port name="spin_dist">How far, in radians &amp; more</input_port></Action>
    </TreeNodesModel>
</root>
`;

// The node of the path of node children, from the root
function at(document: XmlDocument, ...path: number[]): XmlNode {
  let node = document.root;
  for (const index of path) {
    node = node.children.filter(isNode)[index];
  }
  return node;
}

test('a file is written back as it was read', () => {
  const document = parseDocument(FILE);
  assert.equal(writeDocument(document), FILE);
  assert.equal(document.indent, '    ');
  assert.equal(at(document, 0, 0).attributes.name, 'Navigate');
  const crlf = FILE.replaceAll('\n', '\r\n');
  assert.equal(writeDocument(parseDocument(crlf)), crlf);
});

test('only what changed is written anew', () => {
  const document = parseDocument(FILE);
  const follow = at(document, 0, 0, 1);
  const edited = setAttribute(document, follow.key, 'controller_id', 'Fast & "precise"\nfirst');
  assert.equal(
    writeDocument(edited),
    FILE.replace('<FollowPath path="{path}" />', '<FollowPath path="{path}" controller_id="Fast &amp; &quot;precise&quot;&#10;first"/>'),
  );
  // Read back as written
  assert.equal(at(parseDocument(writeDocument(edited)), 0, 0, 1).attributes.controller_id, 'Fast & "precise"\nfirst');
  // The others, and the document edited, untouched
  assert.equal(writeDocument(document), FILE);
  assert.equal(at(edited, 0, 0, 0), at(document, 0, 0, 0));
});

test('a name comes first; attributes renamed in place', () => {
  const document = parseDocument(FILE);
  const compute = at(document, 0, 0, 0);
  const named = setAttribute(document, compute.key, 'name', 'Plan');
  assert.deepEqual(Object.keys(at(named, 0, 0, 0).attributes), ['name', 'goal', 'path']);
  const renamed = renameAttribute(named, compute.key, 'goal', 'pose');
  assert.deepEqual(Object.entries(at(renamed, 0, 0, 0).attributes), [
    ['name', 'Plan'],
    ['pose', '{goal}'],
    ['path', '{path}'],
  ]);
  assert.deepEqual(at(setAttribute(renamed, compute.key, 'pose', null), 0, 0, 0).attributes, { name: 'Plan', path: '{path}' });
});

test('nodes removed with their comments, inserted and moved', () => {
  const document = parseDocument(FILE);
  const sequence = at(document, 0, 0);
  const compute = at(document, 0, 0, 0);
  const removed = removeNode(document, compute.key);
  assert.equal(
    writeDocument(removed),
    FILE.replace('            <!-- First, the path -->\n            <ComputePathToPose goal="{goal}"   path="{path}"/>\n', ''),
  );

  const inserted = insertNode(document, sequence.key, 1, createNode('Wait', { wait_duration: '1' }));
  assert.match(writeDocument(inserted), /path="\{path\}"\/>\n            <Wait wait_duration="1"\/>\n\n            <FollowPath/);

  // Last, with its comment
  const moved = moveNode(document, compute.key, sequence.key, 3)!;
  assert.deepEqual(
    at(moved, 0, 0).children.filter(isNode).map((node) => node.name),
    ['FollowPath', 'RetryUntilSuccessful', 'ComputePathToPose'],
  );
  assert.match(writeDocument(moved), /<\/RetryUntilSuccessful>\n            <!-- First, the path -->\n            <ComputePathToPose/);
  // Into the retry, as its second child: indented anew
  const retry = at(document, 0, 0, 2);
  const deeper = moveNode(document, compute.key, retry.key, 1)!;
  assert.match(
    writeDocument(deeper),
    /<RetryUntilSuccessful num_attempts="3">\n                <Spin spin_dist="1.57"\/>\n                <!-- First, the path -->\n                <ComputePathToPose goal="\{goal\}"   path="\{path\}"\/>\n            <\/RetryUntilSuccessful>/,
  );
  // Never into itself
  assert.equal(moveNode(document, sequence.key, retry.key, 0), null);
  assert.equal(moveNode(document, sequence.key, sequence.key, 0), null);
});

test('moved within its parent, to before a node as it is now', () => {
  const document = parseDocument(FILE);
  const sequence = at(document, 0, 0);
  const order = (doc: XmlDocument) => at(doc, 0, 0).children.filter(isNode).map((node) => node.name);
  assert.deepEqual(order(moveNode(document, at(document, 0, 0, 0).key, sequence.key, 2)!), ['FollowPath', 'ComputePathToPose', 'RetryUntilSuccessful']);
  assert.deepEqual(order(moveNode(document, at(document, 0, 0, 2).key, sequence.key, 0)!), ['RetryUntilSuccessful', 'ComputePathToPose', 'FollowPath']);
});

test('wrapped, unwrapped, cloned', () => {
  const document = parseDocument(FILE);
  const follow = at(document, 0, 0, 1);
  const wrapped = wrapNode(document, follow.key, createNode('Inverter'));
  assert.match(writeDocument(wrapped), /\n\n            <Inverter>\n                <FollowPath path="\{path\}" \/>\n            <\/Inverter>\n/);
  const inverter = at(wrapped, 0, 0, 1);
  assert.equal(writeDocument(unwrapNode(wrapped, inverter.key)), FILE);

  const copy = cloneNode(at(document, 0, 0));
  assert.notEqual(copy.key, at(document, 0, 0).key);
  assert.equal(copy.source, null);
  assert.equal(locate(document, copy.key), null);
  assert.deepEqual(locate(document, follow.key)?.ancestors.map((node) => node.name), ['root', 'BehaviorTree', 'Sequence']);
});
