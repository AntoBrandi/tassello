import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadBehaviorTree, resolveTreeFile } from './behavior_tree_file.ts';

async function withFiles(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-bt-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('trees are XML files of the robot, of packages and uploads', () => {
  assert.equal(resolveTreeFile('~/trees/main.xml', '/up', '/home/robot'), '/home/robot/trees/main.xml');
  assert.equal(resolveTreeFile('/a/../b/tree.XML', '/up'), '/b/tree.XML');
  assert.equal(resolveTreeFile('uploads/0123456789abcdef.xml', '/up'), '/up/0123456789abcdef.xml');
  assert.throws(() => resolveTreeFile('trees/main.xml', '/up'), /Not a path/);
  assert.throws(() => resolveTreeFile('/etc/passwd', '/up'), /Not an XML file/);
  assert.throws(() => resolveTreeFile('uploads/../../panels/a.json', '/up'), /No upload/);
  assert.throws(() => resolveTreeFile('package://no_such_package_here/tree.xml', '/up'), /No package/);
});

test('the main tree, its subtrees expanded in BT.CPP order', async () => {
  await withFiles(
    {
      'main.xml': `<root BTCPP_format="4" main_tree_to_execute="Main">
        <include path="sub/recovery.xml"/>
        <BehaviorTree ID="Main">
          <Sequence name="Navigate">
            <Action ID="ComputePath" goal="{goal}"/>
            <SubTree ID="Recovery" name="Recover" _autoremap="true"/>
            <Follow/>
          </Sequence>
        </BehaviorTree>
        <TreeNodesModel><Condition ID="Follow"/></TreeNodesModel>
      </root>`,
      'sub/recovery.xml': `<root>
        <BehaviorTree ID="Recovery">
          <RetryUntilSuccessful num_attempts="3"><Spin/></RetryUntilSuccessful>
        </BehaviorTree>
      </root>`,
    },
    async (dir) => {
      const tree = await loadBehaviorTree(path.join(dir, 'main.xml'));
      assert.equal(tree.treeId, 'Main');
      assert.deepEqual(tree.warnings, []);
      assert.deepEqual(tree.files, [path.join(dir, 'main.xml'), path.join(dir, 'sub/recovery.xml')]);
      assert.deepEqual(tree.nodes, [
        { name: 'Navigate', type: 'Sequence', kind: 'control', parent: -1, ports: {} },
        { name: 'ComputePath', type: 'ComputePath', kind: 'action', parent: 0, ports: { goal: '{goal}' } },
        { name: 'Recover', type: 'SubTree', kind: 'subtree', parent: 0, ports: { ID: 'Recovery', _autoremap: 'true' } },
        { name: 'RetryUntilSuccessful', type: 'RetryUntilSuccessful', kind: 'decorator', parent: 2, ports: { num_attempts: '3' } },
        { name: 'Spin', type: 'Spin', kind: 'action', parent: 3, ports: {} },
        { name: 'Follow', type: 'Follow', kind: 'condition', parent: 0, ports: {} },
      ]);
    },
  );
});

test('without main_tree_to_execute, the tree no other uses', async () => {
  await withFiles(
    {
      'trees.xml': `<root>
        <BehaviorTree ID="Helper"><AlwaysSuccess/></BehaviorTree>
        <BehaviorTree ID="Top"><Fallback><SubTree ID="Helper"/><IsStuck/><Custom><A/></Custom></Fallback></BehaviorTree>
      </root>`,
    },
    async (dir) => {
      const tree = await loadBehaviorTree(path.join(dir, 'trees.xml'));
      assert.equal(tree.treeId, 'Top');
      assert.deepEqual(
        tree.nodes.map((node) => [node.name, node.kind, node.parent]),
        [
          ['Fallback', 'control', -1],
          ['Helper', 'subtree', 0],
          ['AlwaysSuccess', 'action', 1],
          ['IsStuck', 'condition', 0],
          ['Custom', 'decorator', 0],
          ['A', 'action', 4],
        ],
      );
    },
  );
});

test('what cannot be expanded is reported, what cannot be read throws', async () => {
  await withFiles(
    {
      'broken.xml': `<root main_tree_to_execute="Missing">
        <include path="nowhere.xml"/>
        <BehaviorTree ID="Main">
          <Sequence><SubTree ID="Undefined"/><SubTree ID="Main"/></Sequence>
        </BehaviorTree>
      </root>`,
      'other.xml': '<robot name="r"/>',
      'bad.xml': '<root><BehaviorTree ID="A"><Sequence></BehaviorTree></root>',
    },
    async (dir) => {
      const tree = await loadBehaviorTree(path.join(dir, 'broken.xml'));
      assert.equal(tree.treeId, 'Main');
      assert.equal(tree.nodes.length, 3);
      assert.equal(tree.warnings.length, 4);
      assert.match(tree.warnings[0], /Not included: Cannot read .*nowhere\.xml: ENOENT/);
      assert.match(tree.warnings[1], /No BehaviorTree Missing, the main_tree_to_execute/);
      assert.match(tree.warnings[2], /No BehaviorTree Undefined, for the SubTree of line 4/);
      assert.match(tree.warnings[3], /The subtree Main includes itself/);
      await assert.rejects(loadBehaviorTree(path.join(dir, 'other.xml')), /not a behavior tree: its root element is <robot>/);
      await assert.rejects(loadBehaviorTree(path.join(dir, 'bad.xml')), /Line 1: <\/BehaviorTree> closes <Sequence>/);
      await assert.rejects(loadBehaviorTree(path.join(dir, 'gone.xml')), /ENOENT/);
    },
  );
});
