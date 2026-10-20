// What a file manager holds: the folder shown, those gone back from and to,
// those unfolded, and the files open in its tabs: text files as edited, with
// their changes to undo, the version the next save overwrites and what the
// robot's file became meanwhile; images. Kept for the page's life by widget,
// as the behavior tree editors are: it survives being shown again.

import type { FsText } from '../../../shared/file_manager.ts';
import { languageOf, type Language } from './highlight.ts';
import { baseName, isWithin } from './model.ts';
import {
  detectEol,
  detectIndent,
  EMPTY_HISTORY,
  recordStep,
  redo,
  undo,
  type EditKind,
  type Eol,
  type History,
  type Indent,
  type Selection,
  type Step,
} from './text_edit.ts';

// Gone back from, at most
const MAX_BACK = 50;

export interface TextTab {
  kind: 'text';
  id: number;
  path: string;
  // As edited, with \n line ends; null until read
  text: string | null;
  // As last read or saved: the changes are counted from it
  saved: string | null;
  // The version the next save overwrites, and the stamp the robot's file is
  // polled with
  base: string | null;
  stamp: string | null;
  // The file's own line ends, written back on save
  eol: Eol;
  readOnly: string | null;
  // Why it could not be read
  error: string | null;
  // Deleted on the robot: a save makes it again
  missing: boolean;
  // The robot's file changed while this one had changes, or a save found it
  // changed: its text (null until read) and version, for the user to load or
  // to overwrite
  external: { text: string | null; version: string; stamp: string | null } | null;
  history: History;
  selection: Selection;
  scroll: { top: number; left: number };
  language: Language;
  indent: Indent;
  // Counts the reads asked: the same again is read again
  reads: number;
}

export interface ImageTab {
  kind: 'image';
  id: number;
  path: string;
  reads: number;
}

export type Tab = TextTab | ImageTab;

export interface FileManagerState {
  folder: string;
  back: string[];
  forward: string[];
  // Folders unfolded in the list, under the one shown
  expanded: ReadonlySet<string>;
  tabs: Tab[];
  // The tab shown, null: the files
  active: number | null;
  nextId: number;
}

export type FileManagerAction =
  | { type: 'go'; folder: string }
  // The folder as typed (~/maps) is that one (/home/robot/maps)
  | { type: 'resolved'; from: string; folder: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'fold'; folder: string; open: boolean }
  | { type: 'open'; path: string; kind: Tab['kind'] }
  | { type: 'activate'; id: number | null }
  | { type: 'close'; id: number }
  | { type: 'read'; id: number; file: FsText }
  // Read again by the poll: changed on the robot
  | { type: 'changed'; id: number; file: FsText }
  | { type: 'failed'; id: number; error: string }
  | { type: 'missing'; id: number }
  | { type: 'edit'; id: number; text: string; step: Step; kind: EditKind; time: number }
  | { type: 'undo' | 'redo'; id: number }
  | { type: 'view'; id: number; selection: Selection; scroll?: { top: number; left: number } }
  | { type: 'saved'; id: number; text: string; version: string; stamp: string; path?: string }
  | { type: 'conflict'; id: number; version: string; stamp: string }
  // Of the robot's file changed: load it, or keep this one, the next save
  // overwriting it
  | { type: 'reload'; id: number }
  | { type: 'keep'; id: number }
  | { type: 'settings'; id: number; language?: Language; indent?: Indent; eol?: Eol }
  // Entries renamed or moved, or deleted, in this widget or another: the
  // tabs and the folders follow
  | { type: 'moved'; from: string; to: string }
  | { type: 'deleted'; paths: string[] };

export function initialState(folder: string): FileManagerState {
  return { folder, back: [], forward: [], expanded: new Set(), tabs: [], active: null, nextId: 1 };
}

// The text of a file as edited: \n line ends
function editable(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function clamp(selection: Selection, length: number): Selection {
  return { start: Math.min(selection.start, length), end: Math.min(selection.end, length) };
}

function readInto(tab: TextTab, file: FsText, keepView: boolean): TextTab {
  const text = editable(file.text);
  return {
    ...tab,
    text,
    saved: text,
    base: file.version,
    stamp: file.stamp,
    eol: detectEol(file.text),
    readOnly: file.readOnly,
    error: null,
    missing: false,
    external: null,
    history: EMPTY_HISTORY,
    selection: keepView ? clamp(tab.selection, text.length) : { start: 0, end: 0 },
    scroll: keepView ? tab.scroll : { top: 0, left: 0 },
    // Of an empty or new file: its extension's, or its first line's
    language: tab.text === null ? languageOf(baseName(tab.path), text.split('\n', 1)[0]) : tab.language,
    indent: tab.text === null ? detectIndent(text, tab.language === 'python' ? 4 : 2) : tab.indent,
  };
}

export function isDirty(tab: Tab): boolean {
  return tab.kind === 'text' && tab.text !== null && (tab.text !== tab.saved || tab.missing);
}

// Moved from one path to another: those under it go along
function movedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}

function updateTab(state: FileManagerState, id: number, update: (tab: TextTab) => TextTab): FileManagerState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id && tab.kind === 'text' ? update(tab) : tab)),
  };
}

export function reduce(state: FileManagerState, action: FileManagerAction): FileManagerState {
  switch (action.type) {
    case 'go':
      if (action.folder === state.folder) {
        return { ...state, active: null };
      }
      return {
        ...state,
        folder: action.folder,
        back: [...state.back, state.folder].slice(-MAX_BACK),
        forward: [],
        active: null,
      };
    case 'resolved':
      return state.folder === action.from ? { ...state, folder: action.folder } : state;
    case 'back':
    case 'forward': {
      const from = action.type === 'back' ? state.back : state.forward;
      const to = from[from.length - 1];
      if (to === undefined) {
        return state;
      }
      return {
        ...state,
        folder: to,
        back: action.type === 'back' ? state.back.slice(0, -1) : [...state.back, state.folder],
        forward: action.type === 'back' ? [...state.forward, state.folder] : state.forward.slice(0, -1),
        active: null,
      };
    }
    case 'fold': {
      const expanded = new Set(state.expanded);
      if (action.open) {
        expanded.add(action.folder);
      } else {
        // Those under it too: unfolded again, they start folded
        for (const folder of expanded) {
          if (isWithin(folder, action.folder)) {
            expanded.delete(folder);
          }
        }
      }
      return { ...state, expanded };
    }
    case 'open': {
      const open = state.tabs.find((tab) => tab.path === action.path && tab.kind === action.kind);
      if (open) {
        return { ...state, active: open.id };
      }
      const id = state.nextId;
      const tab: Tab =
        action.kind === 'image'
          ? { kind: 'image', id, path: action.path, reads: 0 }
          : {
              kind: 'text',
              id,
              path: action.path,
              text: null,
              saved: null,
              base: null,
              stamp: null,
              eol: '\n',
              readOnly: null,
              error: null,
              missing: false,
              external: null,
              history: EMPTY_HISTORY,
              selection: { start: 0, end: 0 },
              scroll: { top: 0, left: 0 },
              language: languageOf(baseName(action.path)),
              indent: 2,
              reads: 0,
            };
      return { ...state, tabs: [...state.tabs, tab], active: id, nextId: id + 1 };
    }
    case 'activate':
      return { ...state, active: action.id };
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      // The one after it, or before it, or the files
      const active = state.active === action.id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.active;
      return { ...state, tabs, active };
    }
    case 'read':
      return updateTab(state, action.id, (tab) => readInto(tab, action.file, tab.text !== null));
    case 'changed':
      return updateTab(state, action.id, (tab) => {
        // Read before a save of this page's came back
        if (action.file.version === tab.base) {
          return { ...tab, stamp: action.file.stamp };
        }
        if (tab.text === null || !isDirty(tab)) {
          return readInto(tab, action.file, true);
        }
        return { ...tab, stamp: action.file.stamp, external: { text: editable(action.file.text), version: action.file.version, stamp: action.file.stamp } };
      });
    case 'failed':
      return updateTab(state, action.id, (tab) => ({ ...tab, error: action.error }));
    case 'missing':
      return updateTab(state, action.id, (tab) => ({ ...tab, missing: tab.text !== null, error: tab.text === null ? `No file ${tab.path}` : null }));
    case 'edit':
      return updateTab(state, action.id, (tab) => ({
        ...tab,
        text: action.text,
        history: recordStep(tab.history, action.step, action.kind, action.time),
        selection: action.step.after,
      }));
    case 'undo':
    case 'redo':
      return updateTab(state, action.id, (tab) => {
        const done = tab.text === null ? null : (action.type === 'undo' ? undo : redo)(tab.text, tab.history);
        return done ? { ...tab, text: done.text, history: done.history, selection: done.selection } : tab;
      });
    case 'view':
      return updateTab(state, action.id, (tab) => ({ ...tab, selection: action.selection, scroll: action.scroll ?? tab.scroll }));
    case 'saved':
      return updateTab(state, action.id, (tab) => ({
        ...tab,
        path: action.path ?? tab.path,
        saved: action.text,
        base: action.version,
        stamp: action.stamp,
        readOnly: action.path && action.path !== tab.path ? null : tab.readOnly,
        missing: false,
        external: null,
      }));
    case 'conflict':
      return updateTab(state, action.id, (tab) => ({ ...tab, external: { text: null, version: action.version, stamp: action.stamp } }));
    case 'reload':
      return updateTab(state, action.id, (tab) =>
        tab.external?.text != null
          ? readInto(tab, { path: tab.path, text: tab.external.text, version: tab.external.version, stamp: tab.external.stamp ?? '', readOnly: tab.readOnly }, true)
          : { ...tab, external: null, reads: tab.reads + 1 },
      );
    case 'keep':
      return updateTab(state, action.id, (tab) =>
        tab.external ? { ...tab, base: tab.external.version, stamp: tab.external.stamp ?? tab.stamp, external: null } : tab,
      );
    case 'settings':
      return updateTab(state, action.id, (tab) => ({
        ...tab,
        language: action.language ?? tab.language,
        indent: action.indent ?? tab.indent,
        eol: action.eol ?? tab.eol,
      }));
    case 'moved': {
      const move = (path: string) => movedPath(path, action.from, action.to);
      return {
        ...state,
        folder: move(state.folder),
        back: state.back.map(move),
        forward: state.forward.map(move),
        expanded: new Set([...state.expanded].map(move)),
        tabs: state.tabs.map((tab) => (isWithin(tab.path, action.from) ? { ...tab, path: move(tab.path) } : tab)),
      };
    }
    case 'deleted': {
      const gone = (path: string) => action.paths.some((deleted) => isWithin(path, deleted));
      return {
        ...state,
        // Images close; texts stay, to be saved again
        tabs: state.tabs
          .filter((tab) => tab.kind === 'text' || !gone(tab.path))
          .map((tab) => (tab.kind === 'text' && gone(tab.path) && tab.text !== null ? { ...tab, missing: true } : tab)),
        active: state.tabs.some((tab) => tab.id === state.active && tab.kind === 'image' && gone(tab.path)) ? null : state.active,
        expanded: new Set([...state.expanded].filter((folder) => !gone(folder))),
      };
    }
  }
}

export interface Session {
  // The widget's start folder it began with: another starts afresh
  config: string;
  state: FileManagerState;
}

// By panel and widget
export const sessions = new Map<string, Session>();

// Whether a page leaving would lose changes
export function unsavedFiles(): boolean {
  return [...sessions.values()].some((session) => session.state.tabs.some(isDirty));
}
