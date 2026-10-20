import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FsText } from '../../../shared/file_manager.ts';
import { initialState, isDirty, reduce, type FileManagerState, type TextTab } from './session.ts';
import { diffText } from './text_edit.ts';

function file(path: string, text: string, version = 'v1', stamp = 's1'): FsText {
  return { path, text, version, stamp, readOnly: null };
}

function textTab(state: FileManagerState, id: number): TextTab {
  const tab = state.tabs.find((t) => t.id === id);
  assert.ok(tab && tab.kind === 'text');
  return tab;
}

function edit(state: FileManagerState, id: number, text: string): FileManagerState {
  const change = diffText(textTab(state, id).text!, text)!;
  const end = change.from + change.inserted.length;
  return reduce(state, {
    type: 'edit',
    id,
    text,
    step: { change, before: { start: change.from, end: change.from }, after: { start: end, end } },
    kind: 'other',
    time: 0,
  });
}

test('folders gone to are gone back from, and forward again', () => {
  let state = initialState('/home/robot');
  state = reduce(state, { type: 'go', folder: '/home/robot/maps' });
  state = reduce(state, { type: 'go', folder: '/data' });
  assert.deepEqual(state.back, ['/home/robot', '/home/robot/maps']);
  state = reduce(state, { type: 'back' });
  assert.equal(state.folder, '/home/robot/maps');
  assert.deepEqual(state.forward, ['/data']);
  state = reduce(state, { type: 'forward' });
  assert.equal(state.folder, '/data');
  state = reduce(state, { type: 'back' });
  state = reduce(state, { type: 'go', folder: '/tmp' });
  assert.deepEqual(state.forward, []);
  state = reduce(state, { type: 'fold', folder: '/tmp/a', open: true });
  state = reduce(state, { type: 'fold', folder: '/tmp/a/b', open: true });
  state = reduce(state, { type: 'fold', folder: '/tmp/a', open: false });
  assert.deepEqual([...state.expanded], []);
});

test('a file opens once, read with its line ends and indentation; edits make it dirty', () => {
  let state = initialState('/');
  state = reduce(state, { type: 'open', path: '/ws/params.yaml', kind: 'text' });
  state = reduce(state, { type: 'open', path: '/ws/map.pgm', kind: 'image' });
  state = reduce(state, { type: 'open', path: '/ws/params.yaml', kind: 'text' });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.active, 1);
  state = reduce(state, { type: 'read', id: 1, file: file('/ws/params.yaml', 'a:\r\n    b: 1\r\n') });
  let tab = textTab(state, 1);
  assert.equal(tab.text, 'a:\n    b: 1\n');
  assert.equal(tab.eol, '\r\n');
  assert.equal(tab.indent, 4);
  assert.equal(tab.language, 'yaml');
  assert.equal(isDirty(tab), false);
  state = edit(state, 1, 'a:\n    b: 2\n');
  assert.equal(isDirty(textTab(state, 1)), true);
  state = reduce(state, { type: 'undo', id: 1 });
  assert.equal(isDirty(textTab(state, 1)), false);
  state = reduce(state, { type: 'redo', id: 1 });
  tab = textTab(state, 1);
  assert.equal(tab.text, 'a:\n    b: 2\n');
  state = reduce(state, { type: 'saved', id: 1, text: tab.text!, version: 'v2', stamp: 's2' });
  assert.equal(isDirty(textTab(state, 1)), false);
  assert.equal(textTab(state, 1).base, 'v2');
});

test('changes on the robot: loaded at once if none here, else asked about', () => {
  let state = initialState('/');
  state = reduce(state, { type: 'open', path: '/a.txt', kind: 'text' });
  state = reduce(state, { type: 'read', id: 1, file: file('/a.txt', 'one') });
  state = reduce(state, { type: 'changed', id: 1, file: file('/a.txt', 'two', 'v2', 's2') });
  assert.equal(textTab(state, 1).text, 'two');
  assert.equal(textTab(state, 1).external, null);

  state = edit(state, 1, 'two!');
  state = reduce(state, { type: 'changed', id: 1, file: file('/a.txt', 'three', 'v3', 's3') });
  assert.equal(textTab(state, 1).text, 'two!');
  assert.deepEqual(textTab(state, 1).external, { text: 'three', version: 'v3', stamp: 's3' });
  // Kept: the next save overwrites v3
  const kept = reduce(state, { type: 'keep', id: 1 });
  assert.equal(textTab(kept, 1).base, 'v3');
  assert.equal(textTab(kept, 1).external, null);
  assert.equal(textTab(kept, 1).text, 'two!');
  // Loaded: this one's changes go
  const loaded = reduce(state, { type: 'reload', id: 1 });
  assert.equal(textTab(loaded, 1).text, 'three');
  assert.equal(isDirty(textTab(loaded, 1)), false);

  // A save refused: the file is read again when loaded
  const refused = reduce(kept, { type: 'conflict', id: 1, version: 'v4', stamp: 's4' });
  const again = reduce(refused, { type: 'reload', id: 1 });
  assert.equal(textTab(again, 1).reads, 1);
});

test('tabs follow their files moved, and those deleted', () => {
  let state = initialState('/ws/src');
  state = reduce(state, { type: 'go', folder: '/ws/src/robot' });
  state = reduce(state, { type: 'open', path: '/ws/src/robot/a.yaml', kind: 'text' });
  state = reduce(state, { type: 'read', id: 1, file: file('/ws/src/robot/a.yaml', 'x') });
  state = reduce(state, { type: 'open', path: '/ws/src/robot/map.png', kind: 'image' });
  state = reduce(state, { type: 'moved', from: '/ws/src', to: '/ws/source' });
  assert.equal(state.folder, '/ws/source/robot');
  assert.deepEqual(state.back, ['/ws/source']);
  assert.deepEqual(state.tabs.map((t) => t.path), ['/ws/source/robot/a.yaml', '/ws/source/robot/map.png']);
  state = reduce(state, { type: 'deleted', paths: ['/ws/source/robot'] });
  assert.deepEqual(state.tabs.map((t) => t.path), ['/ws/source/robot/a.yaml']);
  assert.equal(state.active, null);
  // Kept, to be saved again
  assert.equal(textTab(state, 1).missing, true);
  assert.equal(isDirty(textTab(state, 1)), true);
  state = reduce(state, { type: 'close', id: 1 });
  assert.deepEqual(state.tabs, []);
});
