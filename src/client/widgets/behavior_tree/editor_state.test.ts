import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BehaviorTreeFile } from '../../../shared/protocol.ts';
import { documentText, editorReducer, initialState, isDirty, type EditorState } from './editor_state.ts';
import { isNode, setAttribute } from './xml_document.ts';

const TEXT = '<root>\n  <BehaviorTree ID="Main">\n    <Wait wait_duration="5"/>\n  </BehaviorTree>\n</root>\n';

const file = (text: string | null, version: string | null, extra: Partial<BehaviorTreeFile> = {}): BehaviorTreeFile => ({
  type: 'bt.file',
  id: 1,
  file: '/trees/main.xml',
  text,
  version,
  readOnly: null,
  error: null,
  ...extra,
});

// The Wait's duration set, typed in its field
function type(state: EditorState, value: string): EditorState {
  const wait = state.document!.root.children.filter(isNode)[0].children.filter(isNode)[0];
  return editorReducer(state, { type: 'edit', document: setAttribute(state.document!, wait.key, 'wait_duration', value), tag: 'wait' });
}

// Of the document, and of the file as last read or saved
const duration = (state: EditorState) => /wait_duration="(\d+)"/.exec(documentText(state.document!))?.[1];
const savedDuration = (state: EditorState) => /wait_duration="(\d+)"/.exec(state.savedText ?? '')?.[1];

test('read, edited, undone as typed, saved', () => {
  let state = editorReducer(initialState('/trees/main.xml'), { type: 'file', file: file(TEXT, 'v1') });
  assert.equal(state.base, 'v1');
  assert.equal(isDirty(state), false);
  assert.ok(state.tree !== null);

  state = type(type(state, '1'), '12');
  assert.equal(state.past.length, 1);
  assert.equal(isDirty(state), true);
  state = editorReducer(state, { type: 'seal' });
  state = type(state, '3');
  assert.equal(state.past.length, 2);

  state = editorReducer(state, { type: 'undo' });
  assert.equal(duration(state), '12');
  state = editorReducer(state, { type: 'redo' });
  assert.equal(duration(state), '3');
  state = editorReducer(state, { type: 'undo' });
  state = editorReducer(state, { type: 'undo' });
  assert.equal(duration(state), '5');
  assert.equal(isDirty(state), false);
  state = editorReducer(state, { type: 'redo' });

  const saved = documentText(state.document!);
  assert.equal(saved, TEXT.replace('"5"', '"12"'));
  state = editorReducer(state, { type: 'saved', text: saved, version: 'v2' });
  assert.equal(savedDuration(state), '12');
  assert.equal(isDirty(state), false);
  // Its own save, told by the server: nothing to do
  assert.equal(editorReducer(state, { type: 'file', file: file(saved, 'v2') }), state);
});

test('changed on the robot: read again, or the user chooses', () => {
  let state = editorReducer(initialState('/trees/main.xml'), { type: 'file', file: file(TEXT, 'v1') });
  const robot = TEXT.replace('5', '7');
  // No changes here: read again
  state = editorReducer(state, { type: 'file', file: file(robot, 'v2') });
  assert.equal(duration(state), '7');
  assert.equal(state.external, null);

  // Changes here: kept, the robot's offered
  state = type(state, '9');
  state = editorReducer(state, { type: 'file', file: file(TEXT.replace('5', '8'), 'v3') });
  assert.deepEqual(state.external, { text: TEXT.replace('5', '8'), version: 'v3' });
  const kept = editorReducer(state, { type: 'keep' });
  assert.equal(kept.base, 'v3');
  assert.equal(isDirty(kept), true);
  const reloaded = editorReducer(state, { type: 'reload' });
  assert.equal(duration(reloaded), '8');
  assert.equal(isDirty(reloaded), false);
  assert.equal(reloaded.past.length, 0);
});

test('a save refused: the version found, its text when it comes', () => {
  let state = editorReducer(initialState('/trees/main.xml'), { type: 'file', file: file(TEXT, 'v1') });
  state = type(state, '9');
  state = editorReducer(state, { type: 'conflict', version: 'v2' });
  assert.deepEqual(state.external, { text: null, version: 'v2' });
  // Nothing to load yet
  assert.equal(editorReducer(state, { type: 'reload' }), state);
  state = editorReducer(state, { type: 'file', file: file(TEXT.replace('5', '6'), 'v2') });
  assert.equal(state.external?.text, TEXT.replace('5', '6'));
});

test('not XML: mended as text', () => {
  let state = editorReducer(initialState('/trees/main.xml'), { type: 'file', file: file('<root>', 'v1') });
  assert.equal(state.document, null);
  assert.match(state.error ?? '', /Not XML: Line 1: <root> not closed/);
  assert.equal(state.savedText, '<root>');
  state = editorReducer(state, { type: 'file', file: file(null, null, { error: 'No file /trees/main.xml' }) });
  assert.match(state.error ?? '', /No file/);
  state = editorReducer(state, { type: 'open', path: '/trees/other.xml' });
  assert.equal(state.opened, 1);
  assert.equal(state.path, '/trees/other.xml');
});
