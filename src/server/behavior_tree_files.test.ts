import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BehaviorTreeFiles, type FileState, type ModelsState } from './behavior_tree_files.ts';
import { contentVersion } from './util.ts';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const TREE = `<root BTCPP_format="4">
  <include path="sub.xml"/>
  <BehaviorTree ID="Main"><SubTree ID="Recovery"/></BehaviorTree>
</root>
`;

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-btf-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function until<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error('Timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('saved over behavior trees only, unless changed since read', async () => {
  await withDir(async (dir) => {
    const files = new BehaviorTreeFiles(path.join(dir, 'uploads'), logger);
    const file = path.join(dir, 'tree.xml');
    await writeFile(file, TREE, { mode: 0o640 });
    const edited = TREE.replace('Main', 'Navigate');

    assert.deepEqual(await files.save(file, edited, contentVersion(TREE), false), { version: contentVersion(edited), conflict: false });
    assert.equal(await readFile(file, 'utf8'), edited);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    // Changed since: not saved, the version found told
    assert.deepEqual(await files.save(file, TREE, contentVersion(TREE), false), { version: contentVersion(edited), conflict: true });
    assert.equal(await readFile(file, 'utf8'), edited);
    // Whatever it is
    assert.equal((await files.save(file, TREE, null, false)).conflict, false);

    // Through a link, the file linked to (colcon's --symlink-install)
    const link = path.join(dir, 'link.xml');
    await symlink(file, link);
    await files.save(link, edited, null, false);
    assert.equal(await readFile(file, 'utf8'), edited);
    assert.ok((await import('node:fs')).lstatSync(link).isSymbolicLink());

    await assert.rejects(files.save(file, '<robot/>', null, false), /root element is <robot>/);
    await assert.rejects(files.save(file, '<root>', null, false), /Line 1: <root> not closed/);
    const urdf = path.join(dir, 'robot.xml');
    await writeFile(urdf, '<robot name="r"/>');
    await assert.rejects(files.save(urdf, TREE, null, false), /not a behavior tree.*not overwritten/);
    await assert.rejects(files.save(path.join(dir, 'none.xml'), TREE, null, false), /No file/);
    await assert.rejects(files.save('uploads/0123456789abcdef.xml', TREE, null, false), /Uploads are not saved/);
    await assert.rejects(files.save(path.join(dir, 'tree.txt'), TREE, null, false), /Not an XML file/);

    // New, in new folders; never over a file
    const created = path.join(dir, 'new', 'folder', 'tree.xml');
    await files.save(created, TREE, null, true);
    assert.equal(await readFile(created, 'utf8'), TREE);
    await assert.rejects(files.save(created, TREE, null, true), /exists already/);
  });
});

test('watched: the file as it changes, the models of its includes and libraries', async () => {
  await withDir(async (dir) => {
    const files = new BehaviorTreeFiles(path.join(dir, 'uploads'), logger);
    const file = path.join(dir, 'tree.xml');
    await writeFile(file, TREE);
    await writeFile(
      path.join(dir, 'sub.xml'),
      `<root><BehaviorTree ID="Recovery"><Spin/></BehaviorTree>
        <TreeNodesModel><Action ID="Spin"><input_port name="spin_dist" default="1.57">How far &amp; more</input_port></Action></TreeNodesModel>
      </root>`,
    );
    await writeFile(
      path.join(dir, 'library.xml'),
      `<root><TreeNodesModel><Condition ID="IsDocked"><output_port name="dock" type="std::string"/></Condition></TreeNodesModel></root>`,
    );
    const states: FileState[] = [];
    let models: ModelsState | undefined;
    const stop = files.watch(file, [path.join(dir, 'library.xml'), '~/no/such/library.xml'], {
      onFile: (state) => states.push(state),
      onModels: (state) => (models = state),
    });
    try {
      const first = await until(() => states[0]);
      assert.deepEqual(first, { file, text: TREE, version: contentVersion(TREE), readOnly: null, error: null });
      const withIncludes = await until(() => (models?.trees.length ? models : undefined));
      assert.deepEqual(withIncludes.trees, [{ id: 'Recovery', file: path.join(dir, 'sub.xml') }]);
      const libraries = withIncludes.libraries.filter((library) => library.name !== 'Nav2');
      assert.deepEqual(libraries, [
        {
          name: 'sub.xml',
          file: path.join(dir, 'sub.xml'),
          models: [
            {
              id: 'Spin',
              kind: 'action',
              description: '',
              ports: [{ name: 'spin_dist', direction: 'input', type: '', default: '1.57', description: 'How far & more' }],
            },
          ],
        },
        {
          name: 'library.xml',
          file: path.join(dir, 'library.xml'),
          models: [
            {
              id: 'IsDocked',
              kind: 'condition',
              description: '',
              ports: [{ name: 'dock', direction: 'output', type: 'std::string', default: null, description: '' }],
            },
          ],
        },
      ]);
      assert.match(withIncludes.warnings.join('\n'), /Library ~\/no\/such\/library.xml: Cannot read .*ENOENT/);

      // Saved by another page: told at once
      const edited = TREE.replace('<include path="sub.xml"/>', '');
      await files.save(file, edited, contentVersion(TREE), false);
      assert.equal(states.at(-1)?.text, edited);
      await until(() => (models?.trees.length === 0 ? models : undefined));
      // Edited on the robot: told soon
      await writeFile(file, TREE);
      await until(() => (states.at(-1)?.text === TREE ? true : undefined));
    } finally {
      stop();
      files.stopAll();
    }
  });
});

test('files that cannot be read or saved say so', async () => {
  await withDir(async (dir) => {
    const files = new BehaviorTreeFiles(path.join(dir, 'uploads'), logger);
    const states: FileState[] = [];
    const watcher = { onFile: (state: FileState) => states.push(state), onModels: () => {} };
    files.watch('not/a/path.xml', [], watcher)();
    assert.match(states[0].error ?? '', /Not a path/);
    const stop = files.watch(path.join(dir, 'missing.xml'), [], watcher);
    try {
      assert.match((await until(() => states[1])).error ?? '', /No file/);
    } finally {
      stop();
    }
  });
});
