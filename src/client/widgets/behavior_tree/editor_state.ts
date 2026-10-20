// What a behavior tree editor holds: the file, its document as edited, the
// changes to undo and redo, the version the next save overwrites, and what
// the robot's file became meanwhile. Kept for the page's life by widget: the
// editor survives being shown again (another device's layout, another panel).

import type { BehaviorTreeFile } from '../../../shared/protocol.ts';
import { behaviorTrees, mainTree } from './editor_model.ts';
import { parseDocument, writeDocument, type XmlDocument } from './xml_document.ts';

// Undone at most
const HISTORY = 200;

export interface EditorState {
  // The file edited: the widget's, or one opened since
  path: string;
  // null until read, or while it is not XML (see error)
  document: XmlDocument | null;
  // Why the file cannot be edited: not read, not XML
  error: string | null;
  // The file as last read or saved: changes are counted from it
  savedText: string | null;
  // The version the next save overwrites
  base: string | null;
  readOnly: string | null;
  // The robot's file changed while this one had changes: its text (null
  // until known) and version, for the user to reload or overwrite
  external: { text: string | null; version: string } | null;
  past: XmlDocument[];
  future: XmlDocument[];
  // Of the last change: the next one of the same tag (typing in a field)
  // makes one with it, to undo at once
  tag: string | null;
  // The BehaviorTree shown, by key
  tree: number | null;
  // Counts the files opened: the same opened again is read again
  opened: number;
}

export type EditorAction =
  // Another file
  | { type: 'open'; path: string }
  | { type: 'file'; file: BehaviorTreeFile }
  | { type: 'edit'; document: XmlDocument; tag?: string; tree?: number }
  // The tag's change done: the next one is another
  | { type: 'seal' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'tree'; key: number }
  // Saved, maybe as another file
  | { type: 'saved'; text: string; version: string; path?: string }
  | { type: 'conflict'; version: string }
  // The robot's file over the changes, or the changes kept over it
  | { type: 'reload' }
  | { type: 'keep' };

export function initialState(path: string, opened = 0): EditorState {
  return {
    opened,
    path,
    document: null,
    error: null,
    savedText: null,
    base: null,
    readOnly: null,
    external: null,
    past: [],
    future: [],
    tag: null,
    tree: null,
  };
}

const written = new WeakMap<XmlDocument, string>();

// The document's text: once for each version
export function documentText(document: XmlDocument): string {
  let text = written.get(document);
  if (text === undefined) {
    text = writeDocument(document);
    written.set(document, text);
  }
  return text;
}

export function isDirty(state: EditorState): boolean {
  return state.document !== null && documentText(state.document) !== state.savedText;
}

// The tree to show in a document: the one of the same ID as before, else
// the main one
function treeIn(document: XmlDocument, previous: XmlDocument | null, key: number | null): number | null {
  const id = previous && key !== null ? behaviorTrees(previous).find((tree) => tree.key === key)?.id : undefined;
  const same = id === undefined ? undefined : behaviorTrees(document).find((tree) => tree.id === id);
  return (same ?? mainTree(document))?.key ?? null;
}

// The text read anew: a new document, no history
function load(state: EditorState, text: string, version: string): EditorState {
  const loaded = { ...state, savedText: text, base: version, external: null, past: [], future: [], tag: null };
  try {
    const document = parseDocument(text);
    return { ...loaded, document, error: null, tree: treeIn(document, state.document, state.tree) };
  } catch (e) {
    return { ...loaded, document: null, error: `Not XML: ${e instanceof Error ? e.message : e}`, tree: null };
  }
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'open':
      return initialState(action.path, state.opened + 1);
    case 'file': {
      const { text, version, readOnly, error } = action.file;
      if (text === null || version === null) {
        return { ...state, readOnly, error: state.document ? state.error : error, external: null };
      }
      const next = readOnly === state.readOnly ? state : { ...state, readOnly };
      if (state.document === null && state.past.length === 0 && state.savedText !== text) {
        return load(next, text, version);
      }
      if (version === state.base) {
        return next;
      }
      const current = state.document ? documentText(state.document) : state.savedText;
      if (current === text) {
        // Its own save, or the same
        return { ...next, savedText: text, base: version, external: null };
      }
      if (!isDirty(state) && state.document !== null) {
        return load(next, text, version);
      }
      return { ...next, external: { text, version } };
    }
    case 'edit': {
      if (action.document === state.document) {
        return state;
      }
      // Its XML mended: a document again
      if (!state.document) {
        return { ...state, document: action.document, error: null, tag: action.tag ?? null, tree: treeIn(action.document, null, null) };
      }
      const merge = action.tag !== undefined && action.tag === state.tag;
      return {
        ...state,
        document: action.document,
        error: null,
        past: merge ? state.past : [...state.past, state.document].slice(-HISTORY),
        future: [],
        tag: action.tag ?? null,
        tree: action.tree ?? state.tree,
      };
    }
    case 'seal':
      return state.tag === null ? state : { ...state, tag: null };
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous || !state.document) {
        return state;
      }
      return {
        ...state,
        document: previous,
        past: state.past.slice(0, -1),
        future: [state.document, ...state.future],
        tag: null,
        tree: treeIn(previous, state.document, state.tree),
      };
    }
    case 'redo': {
      const [next, ...future] = state.future;
      if (!next || !state.document) {
        return state;
      }
      return {
        ...state,
        document: next,
        past: [...state.past, state.document],
        future,
        tag: null,
        tree: treeIn(next, state.document, state.tree),
      };
    }
    case 'tree':
      return { ...state, tree: action.key };
    case 'saved':
      return {
        ...state,
        path: action.path ?? state.path,
        savedText: action.text,
        base: action.version,
        readOnly: action.path ? null : state.readOnly,
        external: null,
      };
    case 'conflict':
      return { ...state, external: state.external?.version === action.version ? state.external : { text: null, version: action.version } };
    case 'reload':
      return state.external?.text != null ? load(state, state.external.text, state.external.version) : state;
    case 'keep':
      return state.external ? { ...state, base: state.external.version, savedText: state.external.text ?? state.savedText, external: null } : state;
  }
}

export interface EditorSession {
  // The widget's file it started from: another one, it starts again
  config: string;
  state: EditorState;
  // Loaded in the page, besides the widget's
  libraries: string[];
}

// By widget: the editors as they were last shown
export const editorSessions = new Map<string, EditorSession>();

// Whether a page leaving would lose changes
export function unsavedEditors(): boolean {
  return [...editorSessions.values()].some((session) => isDirty(session.state));
}
