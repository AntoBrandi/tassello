import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FsEntry, FsListing } from '../../../shared/file_manager.ts';
import {
  ago,
  baseName,
  buildRows,
  crumbs,
  displayPath,
  fileType,
  formatMode,
  formatSize,
  freeName,
  listNames,
  parentOf,
  rowRange,
  sortEntries,
  typedPath,
  typeLabel,
} from './model.ts';

function entry(name: string, kind: FsEntry['kind'] = 'file', more: Partial<FsEntry> = {}): FsEntry {
  return { name, kind, link: null, size: 0, modified: 0, mode: 0o644, owner: 'robot', group: 'robot', readable: true, writable: true, bag: false, ...more };
}

function listing(path: string, entries: FsEntry[]): FsListing {
  return { path, parent: parentOf(path), entries, truncated: 0, writable: true, version: '', space: null };
}

test('paths: parents, names, home as ~', () => {
  assert.equal(parentOf('/'), null);
  assert.equal(parentOf('/home'), '/');
  assert.equal(parentOf('/home/robot/maps'), '/home/robot');
  assert.equal(baseName('/home/robot/maps'), 'maps');
  assert.equal(baseName('/'), '/');
  assert.equal(displayPath('/home/robot/maps', '/home/robot'), '~/maps');
  assert.equal(displayPath('/home/robotics', '/home/robot'), '/home/robotics');
});

test('the address bar: from home, from the root, or from the folder it is confined to', () => {
  assert.deepEqual(crumbs('/home/robot/ws/src', '/home/robot'), [
    { name: '~', path: '/home/robot' },
    { name: 'ws', path: '/home/robot/ws' },
    { name: 'src', path: '/home/robot/ws/src' },
  ]);
  assert.deepEqual(crumbs('/opt/ros', '/home/robot'), [
    { name: '/', path: '/' },
    { name: 'opt', path: '/opt' },
    { name: 'ros', path: '/opt/ros' },
  ]);
  assert.deepEqual(crumbs('/data/bags/run_1', '/home/robot', '/data/bags'), [
    { name: 'bags', path: '/data/bags' },
    { name: 'run_1', path: '/data/bags/run_1' },
  ]);
  assert.equal(typedPath('~/maps/', '/opt', '/home/robot'), '/home/robot/maps');
  assert.equal(typedPath('../share', '/opt/ros/jazzy', '/home/robot'), '/opt/ros/share');
  assert.equal(typedPath('/a/./b/../c', '/', '/home/robot'), '/a/c');
  assert.equal(typedPath('package://nav2_bringup/maps', '/', '/home/robot'), 'package://nav2_bringup/maps');
});

test('sizes, permissions and times in words', () => {
  assert.equal(formatSize(1), '1 byte');
  assert.equal(formatSize(999), '999 bytes');
  assert.equal(formatSize(4_210_000), '4.2 MB');
  assert.equal(formatSize(123_456_789), '123 MB');
  assert.equal(formatSize(999_600), '1.0 MB');
  assert.equal(formatSize(1.5e12), '1.5 TB');
  assert.equal(formatMode(0o755, 'dir'), 'drwxr-xr-x');
  assert.equal(formatMode(0o644, 'file'), '-rw-r--r--');
  assert.equal(formatMode(0o4755, 'file'), '-rwsr-xr-x');
  assert.equal(formatMode(0o1777, 'dir'), 'drwxrwxrwt');
  assert.equal(formatMode(0o2644, 'file', true), 'lrw-r-Sr--');
  assert.equal(ago(10_000, 10_000), 'just now');
  assert.equal(ago(0, 3 * 60_000), '3 minutes ago');
  assert.equal(ago(0, 26 * 3_600_000), '1 day ago');
});

test('folders first, then by name in natural order, size or time', () => {
  const entries = [
    entry('b10.txt', 'file', { size: 5, modified: 3 }),
    entry('maps', 'dir', { modified: 1 }),
    entry('b2.txt', 'file', { size: 50, modified: 1 }),
    entry('Bags', 'dir', { modified: 2 }),
  ];
  const names = (key: 'name' | 'size' | 'modified', descending = false) =>
    sortEntries(entries, { key, descending }).map((e) => e.name);
  assert.deepEqual(names('name'), ['Bags', 'maps', 'b2.txt', 'b10.txt']);
  assert.deepEqual(names('name', true), ['maps', 'Bags', 'b10.txt', 'b2.txt']);
  assert.deepEqual(names('size', true), ['maps', 'Bags', 'b2.txt', 'b10.txt']);
  assert.deepEqual(names('modified'), ['maps', 'Bags', 'b2.txt', 'b10.txt']);
});

test('rows: unfolded folders under their entry, hidden ones and the filter applied', () => {
  const listings = new Map([
    ['/ws', listing('/ws', [entry('src', 'dir'), entry('build', 'dir'), entry('.git', 'dir'), entry('README.md')])],
    ['/ws/src', listing('/ws/src', [entry('robot', 'dir'), entry('CMakeLists.txt')])],
  ]);
  const expanded = new Set(['/ws/src', '/ws/src/robot', '/ws/build']);
  const errors = new Map([['/ws/build', 'Cannot list /ws/build: permission denied']]);
  const sort = { key: 'name', descending: false } as const;
  const rows = buildRows('/ws', listings, errors, expanded, sort, { hidden: false, text: '' });
  assert.deepEqual(
    rows.map((row) => (row.type === 'entry' ? `${row.depth} ${row.entry.name}${row.open === null ? '' : row.open ? ' v' : ' >'}` : `${row.depth} (${row.text})`)),
    ['0 build v', '1 (Cannot list /ws/build: permission denied)', '0 src v', '1 robot v', '2 (Reading…)', '1 CMakeLists.txt', '0 README.md'],
  );
  const filtered = buildRows('/ws', listings, errors, new Set(), sort, { hidden: true, text: 'GI' });
  assert.deepEqual(filtered.map((row) => row.path), ['/ws/.git']);
  assert.deepEqual(rowRange(rows, '/ws/README.md', '/ws/src'), ['/ws/src', '/ws/src/robot', '/ws/src/CMakeLists.txt', '/ws/README.md']);
});

test('new names are free, and lists of names short', () => {
  const entries = [entry('New folder', 'dir'), entry('New folder (2)', 'dir'), entry('notes.txt')];
  assert.equal(freeName(entries, 'New folder'), 'New folder (3)');
  assert.equal(freeName(entries, 'notes.txt'), 'notes (2).txt');
  assert.equal(freeName(entries, 'other'), 'other');
  assert.equal(listNames(['a']), 'a');
  assert.equal(listNames(['a', 'b', 'c']), 'a, b and c');
  assert.equal(listNames(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
});

test('files by type: what opening them does', () => {
  assert.equal(fileType(entry('params.yaml')), 'text');
  assert.equal(fileType(entry('robot.urdf.xacro')), 'text');
  assert.equal(fileType(entry('CMakeLists.txt')), 'text');
  assert.equal(fileType(entry('.bashrc')), 'text');
  assert.equal(fileType(entry('map.pgm')), 'image');
  assert.equal(fileType(entry('run_1_0.mcap')), 'bag');
  assert.equal(fileType(entry('run_1', 'dir', { bag: true })), 'bag');
  assert.equal(fileType(entry('ros2', 'file', { mode: 0o755 })), 'program');
  assert.equal(fileType(entry('libnav2.so')), 'program');
  assert.equal(fileType(entry('logs.tar.gz')), 'archive');
  assert.equal(fileType(entry('model.onnx')), 'other');
  assert.equal(typeLabel(entry('map.pgm')), 'Image (PGM)');
  assert.equal(typeLabel(entry('x', 'other', { link: 'gone' })), 'Broken link');
  assert.equal(typeLabel(entry('maps', 'dir', { link: '/data/maps' })), 'Folder, a link');
});
