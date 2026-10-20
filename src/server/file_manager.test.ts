import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  analyzeFolder,
  archiveArguments,
  changeMode,
  checkName,
  deleteEntries,
  entryDetails,
  listFolder,
  listPlaces,
  makeFile,
  makeFolder,
  numberedName,
  readText,
  receiveFile,
  renameEntry,
  resolvePath,
  saveText,
  transfer,
  uploadTarget,
} from './file_manager.ts';
import { HttpError } from './panels.ts';
import { contentVersion } from './util.ts';

async function withFolder(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'tassello-fm-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejectsWith(promise: Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status, e.message);
    if (message) {
      assert.match(e.message, message);
    }
    return true;
  });
}

test('paths are absolute, ~ or package://, normalized', () => {
  assert.equal(resolvePath('~', '/home/robot'), '/home/robot');
  assert.equal(resolvePath(' ~/maps/../bags/ ', '/home/robot'), '/home/robot/bags');
  assert.equal(resolvePath('/a//b/./c/'), '/a/b/c');
  assert.throws(() => resolvePath('maps'), HttpError);
  assert.throws(() => resolvePath(''), HttpError);
  assert.throws(() => resolvePath(42), HttpError);
  assert.throws(() => resolvePath('package://no_such_package_here/x'), HttpError);
});

test('names have no separator, and are not . nor ..', () => {
  assert.equal(checkName('map (2).yaml'), 'map (2).yaml');
  assert.equal(checkName('.bashrc'), '.bashrc');
  for (const name of ['', '.', '..', 'a/b', 'a\0b', 'x'.repeat(256), 7]) {
    assert.throws(() => checkName(name), HttpError);
  }
});

test('copies are numbered before their extension', () => {
  assert.equal(numberedName('map.yaml', 2), 'map (2).yaml');
  assert.equal(numberedName('map (2).yaml', 3), 'map (3).yaml');
  assert.equal(numberedName('logs.tar.gz', 2), 'logs (2).tar.gz');
  assert.equal(numberedName('.bashrc', 2), '.bashrc (2)');
  assert.equal(numberedName('README', 4), 'README (4)');
});

test('the ROS workspaces sourced are places, overlays first', () => {
  const { home, ros } = listPlaces(
    '/home/robot',
    '/home/robot/ws/install/my_robot:/home/robot/ws/install/my_nav:/home/robot/other/install:/opt/ros/jazzy',
  );
  assert.equal(home, '/home/robot');
  assert.deepEqual(ros, [
    { name: 'ws', path: '/home/robot/ws' },
    { name: 'other', path: '/home/robot/other' },
    { name: 'ROS 2 jazzy', path: '/opt/ros/jazzy' },
  ]);
});

test('folders list their entries, folders first in natural order, links followed', async () => {
  await withFolder(async (root) => {
    await mkdir(path.join(root, 'maps'));
    await mkdir(path.join(root, 'run_1'));
    await writeFile(path.join(root, 'run_1', 'metadata.yaml'), 'rosbag2_bagfile_information:\n');
    await writeFile(path.join(root, 'file10.txt'), 'ten');
    await writeFile(path.join(root, 'file2.txt'), 'two');
    await writeFile(path.join(root, '.hidden'), '');
    await symlink('maps', path.join(root, 'to_maps'));
    await symlink('nowhere', path.join(root, 'broken'));
    const listing = await listFolder(root);
    assert.equal(listing.path, root);
    assert.equal(listing.parent, path.dirname(root));
    assert.equal(listing.truncated, 0);
    assert.equal(listing.writable, true);
    assert.deepEqual(
      listing.entries.map(({ name, kind, link, bag }) => ({ name, kind, link, bag })),
      [
        { name: 'maps', kind: 'dir', link: null, bag: false },
        { name: 'run_1', kind: 'dir', link: null, bag: true },
        { name: 'to_maps', kind: 'dir', link: 'maps', bag: false },
        { name: '.hidden', kind: 'file', link: null, bag: false },
        { name: 'broken', kind: 'other', link: 'nowhere', bag: false },
        { name: 'file2.txt', kind: 'file', link: null, bag: false },
        { name: 'file10.txt', kind: 'file', link: null, bag: false },
      ],
    );
    const file = listing.entries.find((entry) => entry.name === 'file10.txt')!;
    assert.equal(file.size, 3);
    assert.equal(file.readable, true);
    assert.equal(file.writable, true);
    assert.ok(file.owner);
    // Unchanged, the same version; changed, another
    assert.equal((await listFolder(root)).version, listing.version);
    await writeFile(path.join(root, 'file2.txt'), 'two, longer');
    assert.notEqual((await listFolder(root)).version, listing.version);
    await rejectsWith(listFolder(path.join(root, 'nope')), 404);
    await rejectsWith(listFolder(path.join(root, 'file2.txt')), 400);
  });
});

test('details of a folder count its entries', async () => {
  await withFolder(async (root) => {
    await writeFile(path.join(root, 'a'), '');
    await writeFile(path.join(root, '.b'), '');
    const details = await entryDetails(root);
    assert.equal(details.kind, 'dir');
    assert.equal(details.items, 2);
    assert.equal(details.hidden, 1);
    assert.equal(details.path, root);
    await rejectsWith(entryDetails(path.join(root, 'nope')), 404);
  });
});

test('entries are made, renamed, and not over others', async () => {
  await withFolder(async (root) => {
    assert.deepEqual((await makeFolder(path.join(root, 'maps'))).paths, [path.join(root, 'maps')]);
    await rejectsWith(makeFolder(path.join(root, 'maps')), 409, /exists already/);
    await makeFile(path.join(root, 'notes.txt'));
    await rejectsWith(makeFile(path.join(root, 'notes.txt')), 409);
    assert.deepEqual((await renameEntry(path.join(root, 'notes.txt'), 'todo.txt')).paths, [path.join(root, 'todo.txt')]);
    await rejectsWith(renameEntry(path.join(root, 'todo.txt'), 'maps'), 409, /exists already/);
    await rejectsWith(renameEntry(path.join(root, 'todo.txt'), '../escape'), 400);
    await rejectsWith(renameEntry('/usr', 'usr2'), 403, /system/);
    assert.deepEqual((await readdir(root)).sort(), ['maps', 'todo.txt']);
  });
});

test('moves and copies ask about the names taken, then skip, keep both or replace them', async () => {
  await withFolder(async (root) => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    await writeFile(path.join(a, 'map.yaml'), 'new');
    await writeFile(path.join(a, 'map.pgm'), 'pgm');
    await writeFile(path.join(b, 'map.yaml'), 'old');
    const sources = [path.join(a, 'map.yaml'), path.join(a, 'map.pgm')];

    assert.deepEqual(await transfer('copy', sources, b, 'ask'), { paths: [], conflicts: ['map.yaml'] });
    assert.deepEqual((await readdir(b)).sort(), ['map.yaml']);

    assert.deepEqual(await transfer('copy', sources, b, 'skip'), { paths: [path.join(b, 'map.pgm')], conflicts: [] });
    assert.equal(await readFile(path.join(b, 'map.yaml'), 'utf8'), 'old');

    await transfer('copy', [sources[0]], b, 'keep-both');
    assert.equal(await readFile(path.join(b, 'map (2).yaml'), 'utf8'), 'new');

    await transfer('move', [sources[0]], b, 'replace');
    assert.equal(await readFile(path.join(b, 'map.yaml'), 'utf8'), 'new');
    assert.deepEqual(await readdir(a), ['map.pgm']);
  });
});

test('copies into their own folder are duplicates; folders do not go into themselves', async () => {
  await withFolder(async (root) => {
    const maps = path.join(root, 'maps');
    await mkdir(path.join(maps, 'inner'), { recursive: true });
    await writeFile(path.join(maps, 'inner', 'x'), 'x');
    assert.deepEqual((await transfer('copy', [maps], root, 'ask')).paths, [path.join(root, 'maps (2)')]);
    assert.equal(await readFile(path.join(root, 'maps (2)', 'inner', 'x'), 'utf8'), 'x');
    // Moved where it is: nothing to do
    assert.deepEqual(await transfer('move', [maps], root, 'ask'), { paths: [], conflicts: [] });
    await rejectsWith(transfer('move', [maps], path.join(maps, 'inner'), 'ask'), 400, /into itself/);
    await rejectsWith(transfer('copy', [maps], maps, 'ask'), 400, /into itself/);
    await rejectsWith(transfer('move', [maps], path.join(root, 'nope'), 'ask'), 404);
  });
});

test('deletes, but never the system’s top folders nor home', async () => {
  await withFolder(async (root) => {
    await mkdir(path.join(root, 'full', 'deep'), { recursive: true });
    await writeFile(path.join(root, 'full', 'deep', 'f'), '');
    await writeFile(path.join(root, 'file'), '');
    await deleteEntries([path.join(root, 'full'), path.join(root, 'file'), path.join(root, 'gone already')]);
    assert.deepEqual(await readdir(root), []);
    await rejectsWith(deleteEntries(['/']), 403);
    await rejectsWith(deleteEntries(['/etc']), 403);
    await rejectsWith(deleteEntries([root], root), 403, /home/);
  });
});

test('permissions change', async () => {
  await withFolder(async (root) => {
    const file = path.join(root, 'run.sh');
    await writeFile(file, '#!/bin/sh\n');
    await changeMode(file, 0o755);
    assert.equal((await stat(file)).mode & 0o7777, 0o755);
    await rejectsWith(changeMode(file, 0o10000), 400);
    await rejectsWith(changeMode(file, '755'), 400);
  });
});

test('text files are read, and saved only over the version read', async () => {
  await withFolder(async (root) => {
    const file = path.join(root, 'params.yaml');
    await writeFile(file, '﻿speed: 1\n');
    const read = (await readText(file))!;
    // The byte order mark kept, to be saved again
    assert.equal(read.text, '﻿speed: 1\n');
    assert.equal(read.version, contentVersion(read.text));
    assert.equal(read.readOnly, null);
    assert.equal(await readText(file, read.stamp), null);

    const saved = await saveText(file, 'speed: 2\n', read.version, false);
    assert.deepEqual({ ...saved, stamp: '' }, { version: contentVersion('speed: 2\n'), stamp: '', conflict: false });
    assert.equal(await readFile(file, 'utf8'), 'speed: 2\n');
    assert.notEqual((await readText(file, read.stamp))?.stamp, read.stamp);

    // Changed since: not saved
    const conflict = await saveText(file, 'speed: 3\n', read.version, false);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.version, contentVersion('speed: 2\n'));
    assert.equal(await readFile(file, 'utf8'), 'speed: 2\n');
    // Whatever it is
    await saveText(file, 'speed: 3\n', null, false);
    assert.equal(await readFile(file, 'utf8'), 'speed: 3\n');

    await saveText(path.join(root, 'new.yaml'), 'a: 1\n', null, true);
    await rejectsWith(saveText(path.join(root, 'new.yaml'), 'a: 2\n', null, true), 409);
    await rejectsWith(saveText(path.join(root, 'gone.yaml'), 'a: 2\n', null, false), 404);
  });
});

test('binary files, folders and files not UTF-8 are not text', async () => {
  await withFolder(async (root) => {
    await writeFile(path.join(root, 'map.pgm'), Buffer.from([0x50, 0x35, 0x0a, 0x00, 0xff]));
    await writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await rejectsWith(readText(path.join(root, 'map.pgm')), 415, /not a text file/);
    await rejectsWith(readText(path.join(root, 'latin1.txt')), 415, /UTF-8/);
    await rejectsWith(readText(root), 400);
    await rejectsWith(readText(path.join(root, 'nope')), 404);
  });
});

test('files of others are read-only', { skip: process.getuid?.() === 0 && 'root writes anything' }, async () => {
  await withFolder(async (root) => {
    const file = path.join(root, 'locked.txt');
    await writeFile(file, 'x');
    await chmod(file, 0o444);
    assert.ok((await readText(file))?.readOnly);
    const listing = await listFolder(root);
    assert.equal(listing.entries[0].writable, false);
  });
});

test('uploads go into their folders, made, complete or not at all', async () => {
  await withFolder(async (root) => {
    const target = (await uploadTarget(root, 'bags/run_1/metadata.yaml', 'ask'))!;
    assert.equal(target, path.join(root, 'bags', 'run_1', 'metadata.yaml'));
    assert.equal(await receiveFile(Readable.from([Buffer.from('a: '), Buffer.from('1\n')]), target, 100), 5);
    assert.equal(await readFile(target, 'utf8'), 'a: 1\n');

    await rejectsWith(uploadTarget(root, 'bags/run_1/metadata.yaml', 'ask'), 409);
    assert.equal(await uploadTarget(root, 'bags/run_1/metadata.yaml', 'skip'), null);
    assert.equal(await uploadTarget(root, 'bags/run_1/metadata.yaml', 'keep-both'), path.join(root, 'bags', 'run_1', 'metadata (2).yaml'));
    assert.equal(await uploadTarget(root, 'bags/run_1/metadata.yaml', 'replace'), target);
    await rejectsWith(uploadTarget(root, '../escape.txt', 'ask'), 400);
    await rejectsWith(uploadTarget(root, 'a//b.txt', 'ask'), 400);

    // Too large: nothing left behind
    await rejectsWith(receiveFile(Readable.from([Buffer.alloc(80), Buffer.alloc(80)]), path.join(root, 'big'), 100), 413);
    assert.deepEqual((await readdir(root)).sort(), ['bags']);
  });
});

test('archives are of entries of one folder, their names never options', () => {
  assert.deepEqual(archiveArguments(['/home/robot/maps', '/home/robot/--checkpoint-action=exec=x']), [
    '-czf',
    '-',
    '-C',
    '/home/robot',
    './maps',
    './--checkpoint-action=exec=x',
  ]);
  assert.throws(() => archiveArguments(['/home/robot/maps', '/tmp/x']), HttpError);
  assert.throws(() => archiveArguments(['/']), HttpError);
});

test('analyses sum folders up, by entry and by type', async () => {
  await withFolder(async (root) => {
    await mkdir(path.join(root, 'bags', 'run_1'), { recursive: true });
    await mkdir(path.join(root, 'maps'));
    await writeFile(path.join(root, 'bags', 'run_1', 'run_1_0.mcap'), Buffer.alloc(3000));
    await writeFile(path.join(root, 'bags', 'run_1', 'metadata.yaml'), Buffer.alloc(100));
    await writeFile(path.join(root, 'maps', 'map.pgm'), Buffer.alloc(1000));
    await writeFile(path.join(root, 'maps', 'map.yaml'), Buffer.alloc(50));
    await writeFile(path.join(root, 'notes'), Buffer.alloc(10));
    await symlink('maps', path.join(root, 'link'));
    const analysis = await analyzeFolder(root);
    assert.equal(analysis.size, 4160);
    assert.equal(analysis.files, 5);
    assert.equal(analysis.folders, 3);
    assert.equal(analysis.links, 1);
    assert.equal(analysis.partial, null);
    assert.deepEqual(
      analysis.children.map(({ name, kind, size, files }) => [name, kind, size, files]),
      [
        ['bags', 'dir', 3100, 2],
        ['maps', 'dir', 1050, 2],
        ['notes', 'file', 10, 1],
        ['link', 'other', 0, 0],
      ],
    );
    assert.deepEqual(
      analysis.types.map(({ type, files, size }) => [type, files, size]),
      [
        ['.mcap', 1, 3000],
        ['.pgm', 1, 1000],
        ['.yaml', 2, 150],
        ['', 1, 10],
      ],
    );
    assert.deepEqual(analysis.largest[0], { path: path.join('bags', 'run_1', 'run_1_0.mcap'), size: 3000 });
    assert.equal(analysis.largest.length, 5);
    // Cut short
    const partial = await analyzeFolder(root, { ms: 60_000, entries: 1 });
    assert.match(partial.partial ?? '', /Stopped after 1 entries/);
    await rejectsWith(analyzeFolder(path.join(root, 'notes')), 400);
  });
});
