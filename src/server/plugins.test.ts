import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type rclnodejs from 'rclnodejs';

import { findPlugins, PluginHost, readPlugin } from './plugins.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function plugin(dir: string, manifest: unknown, name = path.basename(dir)): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', tassello: manifest }),
  );
  return dir;
}

test('a plugin is read from its manifest, whose files stay in its folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tassello-plugins-'));
  try {
    const dir = await plugin(path.join(root, 'p'), {
      client: 'dist/client/index.js',
      styles: ['dist/client/index.css'],
      server: 'dist/server.js',
      panels: 'panels',
    });
    const read = await readPlugin({ dir, source: 'test' });
    assert.equal(read.name, 'p');
    assert.equal(read.clientDir, path.join(dir, 'dist/client'));
    assert.equal(read.client, 'index.js');
    assert.deepEqual(read.styles, ['index.css']);
    assert.equal(read.server, path.join(dir, 'dist/server.js'));
    assert.equal(read.panelsDir, path.join(dir, 'panels'));

    for (const manifest of [
      { client: '../elsewhere.js' },
      { client: 'dist/client/index.js', styles: ['dist/other/index.css'] },
      { styles: ['a.css'] },
      { server: '/etc/passwd' },
    ]) {
      await plugin(path.join(root, 'bad'), manifest);
      await assert.rejects(readPlugin({ dir: path.join(root, 'bad'), source: 'test' }), JSON.stringify(manifest));
    }
    await mkdir(path.join(root, 'none'));
    await writeFile(path.join(root, 'none/package.json'), JSON.stringify({ name: 'none' }));
    await assert.rejects(readPlugin({ dir: path.join(root, 'none'), source: 'test' }), /not a Tassello plugin/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('plugins are found on the command line, in the ament index and in node_modules', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tassello-find-'));
  const cwd = process.cwd();
  const ament = process.env.AMENT_PREFIX_PATH;
  try {
    // A ROS package registering its share folder
    const prefix = path.join(root, 'install');
    await plugin(path.join(prefix, 'share/my_robot'), {});
    await mkdir(path.join(prefix, 'share/ament_index/resource_index/tassello_plugins'), { recursive: true });
    await writeFile(path.join(prefix, 'share/ament_index/resource_index/tassello_plugins/my_robot'), '');
    // npm packages, next to Tassello and in the working directory's node_modules
    const modules = path.join(root, 'lib/node_modules');
    const tassello = path.join(modules, 'tassello');
    await mkdir(tassello, { recursive: true });
    await plugin(path.join(modules, 'tassello-plugin-a'), {});
    await plugin(path.join(modules, '@me/tassello-plugin-b'), {}, '@me/tassello-plugin-b');
    await plugin(path.join(modules, 'unrelated'), {});
    const project = path.join(root, 'project');
    await plugin(path.join(project, 'node_modules/tassello-plugin-c'), {});
    const local = await plugin(path.join(root, 'local'), {});

    process.env.AMENT_PREFIX_PATH = `${prefix}:/nonexistent`;
    process.chdir(project);
    const found = await findPlugins([local, 'tassello-plugin-a'], true, tassello);
    assert.deepEqual(
      found.map((f) => path.relative(root, f.dir)),
      [
        'local',
        'lib/node_modules/tassello-plugin-a',
        'install/share/my_robot',
        // Once, though also found by the command line
        'lib/node_modules/@me/tassello-plugin-b',
        'project/node_modules/tassello-plugin-c',
      ],
    );
    assert.deepEqual(
      (await findPlugins([local], false, tassello)).map((f) => f.dir),
      [local],
    );
    await assert.rejects(findPlugins(['tassello-plugin-missing'], false, tassello), /no such folder/);
  } finally {
    process.chdir(cwd);
    process.env.AMENT_PREFIX_PATH = ament;
    await rm(root, { recursive: true });
  }
});

test('the host activates the server sides and dispatches to them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tassello-host-'));
  try {
    const good = await plugin(path.join(root, 'good'), { server: 'server.js' });
    await writeFile(
      path.join(good, 'server.js'),
      `export default {
        activate(ctx) {
          ctx.handle('echo', (params, session) => ({ params, session: session.id, plugin: ctx.name }));
          ctx.handle('fail', () => { throw new Error('no'); });
          ctx.stream('count', (params, emit) => { emit(params.from); emit(params.from + 1); return () => emit('closed'); });
          ctx.commandWidget('good.runner', { property: 'command' });
        },
      };`,
    );
    const broken = await plugin(path.join(root, 'broken'), { server: 'server.js' });
    await writeFile(path.join(broken, 'server.js'), 'export default {};');

    const commands: string[] = [];
    const host = new PluginHost([
      await readPlugin({ dir: good, source: 'test' }),
      await readPlugin({ dir: broken, source: 'test' }),
    ]);
    await host.activate({
      node: {} as rclnodejs.Node,
      rclnodejs: {} as typeof rclnodejs,
      logger: silent,
      commandWidget: (type) => commands.push(type),
    });
    assert.deepEqual(commands, ['good.runner']);
    assert.equal(host.info()[0].error, null);
    assert.match(host.info()[1].error ?? '', /no activate/);

    const session = { id: 'page' };
    assert.deepEqual(await host.request('good', 'echo', 1, session), { params: 1, session: 'page', plugin: 'good' });
    await assert.rejects(host.request('good', 'fail', null, session), /no/);
    await assert.rejects(host.request('good', 'other', null, session), /has no request "other"/);
    await assert.rejects(host.request('broken', 'x', null, session), /did not start/);
    await assert.rejects(host.request('missing', 'x', null, session), /No plugin "missing"/);

    const emitted: unknown[] = [];
    const close = host.open('good', 'count', { from: 5 }, (data) => emitted.push(data), session);
    close();
    assert.deepEqual(emitted, [5, 6, 'closed']);
    assert.throws(() => host.open('good', 'other', null, () => {}, session), /has no stream "other"/);
  } finally {
    await rm(root, { recursive: true });
  }
});
