// The file manager: the robot's files, as GNOME's Files shows them and in
// the behavior tree editor's look. A folder's entries a row each, folders
// unfolded in place; the places (home, the ROS workspaces, bookmarks, the
// disks and their free space) beside them; an entry's details (its
// permissions changed there); an overview of the disks and of what takes a
// folder's space. Entries are made, renamed in place, cut, copied and pasted,
// moved and copied by dragging them onto folders (Ctrl: copied), deleted,
// downloaded (folders as .tar.gz), uploaded by dropping files and folders
// onto the widget. Text files open in tabs, edited as gedit does (see
// TextEditor.tsx), images (PGM maps too) shown.
//
// The server reads and changes the files, as its user (src/server/
// file_manager.ts); the folders shown are read again every few seconds, and
// the files open too: a save never overwrites changes made on the robot
// since the file was read.

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import type { FsConflict, FsDisk, FsEntry, FsOperation, FsPlaces, FsResult } from '../../../shared/file_manager.ts';
import { ApiError, fsApi, type Upload } from '../../api.ts';
import { useDialogs } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  InfoIcon,
  MoreIcon,
  PieChartIcon,
  RedoIcon,
  SaveIcon,
  SearchIcon,
  SidebarIcon,
  UndoIcon,
  UploadIcon,
  WrapIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { Details } from './Details.tsx';
import { FileList, type ListHandlers } from './FileList.tsx';
import {
  baseName,
  buildRows,
  counted,
  crumbs,
  displayPath,
  fileType,
  freeName,
  isWithin,
  items,
  joinPath,
  listNames,
  parentOf,
  rowRange,
  takenNames,
  typedPath,
  type Sort,
  type SortKey,
} from './model.ts';
import { copyText, droppedFiles, errorMessage, POLL_MS, startDownload, useListings } from './folders.ts';
import { Overview } from './Overview.tsx';
import { ConflictDialog, ContextMenu, SaveAsDialog, type ConflictQuestion, type MenuItem } from './parts.tsx';
import { initialState, isDirty, reduce, sessions, unsavedFiles, type FileManagerAction, type Tab, type TextTab } from './session.ts';
import { Sidebar, type Place } from './Sidebar.tsx';
import { StatusLine, type UploadProgress } from './StatusLine.tsx';
import { ImageView, TabStrip } from './Tabs.tsx';
import { TextEditor, type TextEditorHandle } from './TextEditor.tsx';
import { lineAt, lineStarts } from './text_edit.ts';

interface FileManagerConfig {
  folder: string;
  bookmarks: string;
  showHidden: boolean;
  confine: boolean;
  readOnly: boolean;
  wrap: boolean;
}

// Narrower than this, the places cover the files, and start closed
const NARROW_PX = 620;
// Of the details (.bt-details), with their margin: beside the files when
// these keep this much room
const DETAILS_PX = 316;
const BESIDE_DETAILS_PX = 420;
// The disks', while shown
const DISKS_MS = 30_000;
// Folders unfolded read at once, at most
const MAX_UNFOLDED = 12;
// Bookmarks made in a page, by widget: kept by the browser
const BOOKMARKS_KEY = 'tassello.fileManager.bookmarks';
// Of the entries dragged from a file manager: their paths
const DRAG_TYPE = 'application/x-tassello-files';
// Typing a name's first letters goes to it: within this
const TYPE_AHEAD_MS = 800;
// Of a path's folders shown, at most: the first and the last ones; on
// narrow widgets the last one
const MAX_CRUMBS = 5;
const NARROW_CRUMBS_PX = 520;

// Cut or copied: pasted into any file manager of the page
let clipboard: { paths: string[]; cut: boolean } | null = null;
const clipboardListeners = new Set<() => void>();

function setClipboard(next: typeof clipboard): void {
  clipboard = next;
  clipboardListeners.forEach((listener) => listener());
}

function subscribeClipboard(listener: () => void): () => void {
  clipboardListeners.add(listener);
  return () => clipboardListeners.delete(listener);
}

// Entries moved or deleted by one file manager: the tabs of every one follow
const fileEvents = new Set<(action: FileManagerAction) => void>();

function announce(action: FileManagerAction): void {
  fileEvents.forEach((listener) => listener(action));
}

// A page leaving with changes not saved asks first
let guarding = false;
function guardUnload(): void {
  if (!guarding) {
    guarding = true;
    window.addEventListener('beforeunload', (event) => {
      if (unsavedFiles()) {
        event.preventDefault();
      }
    });
  }
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function storedBookmarks(key: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '{}') as Record<string, string[]>;
    return Array.isArray(stored[key]) ? stored[key] : [];
  } catch {
    return [];
  }
}

function storeBookmarks(key: string, bookmarks: string[]): void {
  try {
    const stored = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '{}') as Record<string, string[]>;
    if (bookmarks.length > 0) {
      stored[key] = bookmarks;
    } else {
      delete stored[key];
    }
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(stored));
  } catch {
    // No storage: for this page only
  }
}

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

function FileManagerWidget({ config, instance, panelId }: WidgetProps<FileManagerConfig>) {
  const sessionKey = `${panelId}/${instance.id}`;
  const start = config.folder.trim() || '~';
  const [session] = useState(() => {
    const kept = sessions.get(sessionKey);
    return kept?.config === start ? kept : { config: start, state: initialState(start) };
  });
  const [state, dispatch] = useReducer(reduce, session.state);
  const startedFrom = useRef(session.config);
  const dialogs = useDialogs();
  const readOnly = config.readOnly;

  const [places, setPlaces] = useState<FsPlaces | null>(null);
  const [disks, setDisks] = useState<FsDisk[] | null>(null);
  const [disksAsked, setDisksAsked] = useState(0);
  const [root, setRoot] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: 'name', descending: false });
  const [filterText, setFilterText] = useState('');
  const [showHidden, setShowHidden] = useState(config.showHidden);
  const [wrap, setWrap] = useState(config.wrap);
  const [view, setView] = useState<'list' | 'overview'>('list');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [conflict, setConflict] = useState<ConflictQuestion | null>(null);
  const [picker, setPicker] = useState<{ paths: string[]; copy: boolean } | null>(null);
  const [saveAs, setSaveAs] = useState<number | null>(null);
  const [uploads, setUploads] = useState<UploadProgress | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [droppingHere, setDroppingHere] = useState(false);
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [imageSize, setImageSize] = useState('');
  const [width, setWidth] = useState(0);
  const [pageBookmarks, setPageBookmarks] = useState(() => storedBookmarks(sessionKey));
  const shownClipboard = useSyncExternalStore(subscribeClipboard, () => clipboard);
  const now = useNow(30_000);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<TextEditorHandle>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFolderRef = useRef<HTMLInputElement>(null);
  const pointer = useRef('mouse');
  const dragged = useRef<string[] | null>(null);
  const typeAhead = useRef({ text: '', at: 0 });
  // To select once its folder is shown
  const pendingSelect = useRef<string | null>(null);
  const folderRef = useRef(state.folder);
  folderRef.current = state.folder;
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;

  useEffect(guardUnload, []);

  useEffect(() => {
    fileEvents.add(dispatch);
    return () => void fileEvents.delete(dispatch);
  }, []);

  useEffect(() => {
    sessions.set(sessionKey, { config: startedFrom.current, state });
  }, [sessionKey, state]);

  // The widget's folder changed (edit mode): it, afresh
  useEffect(() => {
    if (start !== startedFrom.current) {
      startedFrom.current = start;
      dispatch({ type: 'go', folder: start });
    }
  }, [start]);

  useEffect(() => setShowHidden(config.showHidden), [config.showHidden]);
  useEffect(() => setWrap(config.wrap), [config.wrap]);

  useEffect(() => {
    fsApi.places().then(setPlaces, () => setPlaces({ home: '', user: '', ros: [] }));
  }, []);

  // A folder named as typed: ~/maps, package://my_robot/maps
  useEffect(() => {
    if (state.folder.startsWith('/')) {
      setStartError(null);
      return;
    }
    let current = true;
    fsApi.list(state.folder).then(
      (listing) => current && listing && dispatch({ type: 'resolved', from: state.folder, folder: listing.path }),
      (e: unknown) => current && setStartError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [state.folder]);

  // The folder the widget stays in
  useEffect(() => {
    if (!config.confine) {
      setRoot(null);
      return;
    }
    if (start.startsWith('/')) {
      setRoot(typedPath(start, '/', ''));
      return;
    }
    fsApi.list(start).then(
      (listing) => listing && setRoot(listing.path),
      () => setRoot(null),
    );
  }, [config.confine, start]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const home = places?.home ?? '';
  const folder = state.folder.startsWith('/') ? state.folder : '';
  const narrow = width > 0 && width < NARROW_PX;
  const activeTab = state.tabs.find((tab) => tab.id === state.active) ?? null;
  const filesShown = activeTab === null;
  const showSidebar = sidebarOpen ?? !narrow;
  const confined = config.confine && root !== null;

  useEffect(() => {
    if (!(showSidebar || view === 'overview') || config.confine) {
      return;
    }
    let current = true;
    const read = () => {
      if (document.visibilityState === 'visible') {
        fsApi.disks().then(
          (found) => current && setDisks(found),
          () => {},
        );
      }
    };
    read();
    const timer = setInterval(read, DISKS_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [showSidebar, view, config.confine, disksAsked]);

  // The folders read: the one shown, and those unfolded under it
  const wanted = useMemo(
    () => (folder ? [folder, ...[...state.expanded].filter((path) => path !== folder && isWithin(path, folder)).slice(0, MAX_UNFOLDED)] : []),
    [folder, state.expanded],
  );
  const { listings, errors, offline, refresh } = useListings(wanted);
  const listing = listings.get(folder) ?? null;
  const folderError = folder ? (errors.get(folder) ?? null) : startError;

  const filter = useMemo(() => ({ hidden: showHidden, text: filterText }), [showHidden, filterText]);
  const rows = useMemo(
    () => (listing ? buildRows(folder, listings, errors, state.expanded, sort, filter) : []),
    [listing, folder, listings, errors, state.expanded, sort, filter],
  );
  const entries = useMemo(() => {
    const byPath = new Map<string, FsEntry>();
    for (const row of rows) {
      if (row.type === 'entry') {
        byPath.set(row.path, row.entry);
      }
    }
    return byPath;
  }, [rows]);
  const cut = useMemo(() => new Set(shownClipboard?.cut ? shownClipboard.paths : []), [shownClipboard]);

  // Another folder: nothing selected, but what was asked for
  useEffect(() => {
    setRenaming(null);
    setFilterText('');
    const pending = pendingSelect.current;
    if (pending && parentOf(pending) === folder) {
      pendingSelect.current = null;
      setSelected(new Set([pending]));
      setAnchor(pending);
      setFocus(pending);
      setReveal((current) => ({ path: pending, seq: (current?.seq ?? 0) + 1 }));
    } else {
      setSelected(new Set());
      setAnchor(null);
      setFocus(null);
    }
  }, [folder]);

  // What is selected and gone: no longer
  useEffect(() => {
    if (!listing) {
      return;
    }
    setSelected((current) => {
      const kept = [...current].filter((path) => entries.has(path));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [entries, listing]);

  // The keys the list's again, or the editor's
  const focusView = () =>
    requestAnimationFrame(() =>
      (rootRef.current?.querySelector<HTMLElement>('.fm-list, .fm-area') ?? rootRef.current)?.focus({ preventScroll: true }),
    );

  const revealPath = (path: string) => {
    setSelected(new Set([path]));
    setAnchor(path);
    setFocus(path);
    setReveal((current) => ({ path, seq: (current?.seq ?? 0) + 1 }));
  };

  const go = (target: string) => {
    if (confined && !isWithin(target, root!)) {
      notify(`This widget stays in ${displayPath(root!, home)}`, 'error');
      return;
    }
    dispatch({ type: 'go', folder: target });
  };

  // An entry shown: its folder, it selected
  const showEntry = (path: string) => {
    const parent = parentOf(path);
    if (!parent) {
      return;
    }
    setView('list');
    if (parent === folder) {
      dispatch({ type: 'activate', id: null });
      revealPath(path);
    } else {
      pendingSelect.current = path;
      go(parent);
    }
  };

  const openEntry = (path: string, entry: Pick<FsEntry, 'name' | 'kind' | 'bag' | 'mode'> | undefined = entries.get(path)) => {
    if (!entry) {
      return;
    }
    if (entry.kind === 'dir') {
      go(path);
      return;
    }
    const type = fileType(entry);
    if (type === 'image') {
      dispatch({ type: 'open', path, kind: 'image' });
    } else if (type === 'text') {
      dispatch({ type: 'open', path, kind: 'text' });
    } else {
      revealPath(path);
      setDetailsOpen(true);
    }
  };

  // A path typed: its folder shown, or the file opened in its folder
  const goTyped = async (typed: string) => {
    const target = typedPath(typed, folder || '/', home);
    try {
      const details = await fsApi.details(target);
      if (details.kind === 'dir') {
        go(details.path);
      } else {
        showEntry(details.path);
        openEntry(details.path, details);
      }
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const askConflict = (names: string[], into: string, verb: string) =>
    new Promise<Exclude<FsConflict, 'ask'> | null>((resolve) => setConflict({ names, folder: into, verb, resolve }));

  const operate = async (operation: FsOperation): Promise<FsResult | null> => {
    try {
      return await fsApi.operate(operation);
    } catch (e) {
      notify(errorMessage(e), 'error');
      return null;
    } finally {
      refresh();
    }
  };

  const transfer = async (op: 'move' | 'copy', paths: string[], to: string): Promise<void> => {
    // Moved where they are: nothing to do
    const sources = paths.filter((path) => op === 'copy' || parentOf(path) !== to);
    if (readOnly || sources.length === 0) {
      return;
    }
    let choice: FsConflict = 'ask';
    let result = await operate({ op, paths: sources, to, conflict: choice });
    if (result && result.conflicts.length > 0) {
      const answer = await askConflict(result.conflicts, to, op === 'move' ? 'moved' : 'copied');
      if (!answer) {
        return;
      }
      choice = answer;
      result = await operate({ op, paths: sources, to, conflict: choice });
    }
    if (!result || result.paths.length === 0) {
      return;
    }
    const made = result.paths;
    if (op === 'move') {
      for (const source of sources) {
        const target = joinPath(to, baseName(source));
        if (made.includes(target)) {
          announce({ type: 'moved', from: source, to: target });
        }
      }
    }
    const from = parentOf(sources[0]);
    const together = from !== null && sources.every((source) => parentOf(source) === from);
    const undo =
      together && choice !== 'replace'
        ? {
            label: 'Undo',
            run: () => void (op === 'move' ? transfer('move', made, from) : remove(made, false)),
          }
        : undefined;
    notify(`${op === 'move' ? 'Moved' : 'Copied'} ${listNames(made.map(baseName), 2)} into ${baseName(to)}`, 'info', undo);
    if (to === folderRef.current) {
      setSelected(new Set(made));
      setReveal((current) => ({ path: made[0], seq: (current?.seq ?? 0) + 1 }));
    }
  };

  const remove = async (paths: string[], ask = true): Promise<void> => {
    if (readOnly || paths.length === 0) {
      return;
    }
    const folders = paths.filter((path) => entries.get(path)?.kind === 'dir').length;
    const unsaved = state.tabs.filter((tab) => isDirty(tab) && paths.some((path) => isWithin(tab.path, path))).length;
    if (
      ask &&
      !(await dialogs.confirm({
        title: paths.length === 1 ? `Delete ${baseName(paths[0])}?` : `Delete ${items(paths.length)}?`,
        message: (
          <>
            {paths.length > 1 && (
              <p>
                <strong>{listNames(paths.map(baseName), 5)}</strong>
              </p>
            )}
            <p>
              {paths.length === 1 ? 'It is' : 'They are'} deleted for good: there is no trash
              {folders > 0 ? `, and ${folders === 1 && paths.length === 1 ? 'the folder goes' : 'folders go'} with all ${folders === 1 && paths.length === 1 ? 'it holds' : 'they hold'}` : ''}.
              {unsaved > 0 ? ` ${counted(unsaved, 'file')} open here ${unsaved === 1 ? 'has' : 'have'} changes not saved.` : ''}
            </p>
          </>
        ),
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    const result = await operate({ op: 'delete', paths });
    if (result) {
      announce({ type: 'deleted', paths });
      setSelected(new Set());
      notify(`Deleted ${listNames(paths.map(baseName), 2)}`);
    }
  };

  const rename = async (path: string, name: string | null) => {
    setRenaming(null);
    focusView();
    if (name === null || !name || name === baseName(path) || readOnly) {
      return;
    }
    if (name.includes('/')) {
      notify('A name has no /: move it with Cut and Paste instead', 'error');
      return;
    }
    const result = await operate({ op: 'rename', path, name });
    if (result) {
      const target = result.paths[0];
      announce({ type: 'moved', from: path, to: target });
      revealPath(target);
    }
  };

  const make = async (kind: 'mkdir' | 'create') => {
    if (readOnly || !folder) {
      return;
    }
    const name = await dialogs.prompt({
      title: kind === 'mkdir' ? 'New folder' : 'New file',
      label: 'Its name',
      initial: freeName(listing?.entries ?? [], kind === 'mkdir' ? 'New folder' : 'untitled.txt'),
      confirmLabel: 'Make it',
    });
    if (!name) {
      return;
    }
    if (name.includes('/')) {
      notify('A name has no /', 'error');
      return;
    }
    const path = joinPath(folder, name);
    const result = await operate({ op: kind, path });
    if (result) {
      setView('list');
      revealPath(path);
      if (kind === 'create') {
        dispatch({ type: 'open', path, kind: 'text' });
      }
    }
  };

  const changeMode = async (path: string, mode: number) => {
    await operate({ op: 'chmod', path, mode });
  };

  const download = (paths: string[]) => {
    if (paths.length === 0) {
      return;
    }
    if (!paths.every((path) => parentOf(path) === parentOf(paths[0]))) {
      notify('Download entries of one folder at a time', 'error');
      return;
    }
    startDownload(fsApi.downloadUrl(paths));
  };

  const upload = async (files: { file: File; name: string }[], into: string) => {
    if (readOnly || files.length === 0) {
      return;
    }
    if (uploads) {
      notify('Uploading already: wait for it, or cancel it', 'error');
      return;
    }
    // Of a folder not shown, read for its names
    const known = listings.get(into)?.entries ?? (await fsApi.list(into).catch(() => undefined))?.entries;
    const tops = [...new Set(files.map(({ name }) => name.split('/')[0]))];
    const taken = takenNames(known, tops);
    let conflict: FsConflict = 'ask';
    // The folders dropped kept apart under a new name, keeping both
    const renamed = new Map<string, string>();
    if (taken.length > 0) {
      const answer = await askConflict(taken, into, 'uploaded');
      if (!answer) {
        return;
      }
      conflict = answer;
      if (answer === 'keep-both') {
        for (const top of taken) {
          if (files.some(({ name }) => name.startsWith(`${top}/`))) {
            renamed.set(top, freeName(known ?? [], top));
          }
        }
      }
    }
    const total = files.reduce((sum, { file }) => sum + file.size, 0);
    let sentBefore = 0;
    let cancelled = false;
    let current: Upload | null = null;
    const abort = () => {
      cancelled = true;
      current?.abort();
    };
    const made: string[] = [];
    let skipped = 0;
    let failed: string | null = null;
    for (let index = 0; index < files.length && !cancelled; index++) {
      const { file, name: dropped } = files[index];
      const [top, ...rest] = dropped.split('/');
      const name = rest.length > 0 && renamed.has(top) ? [renamed.get(top)!, ...rest].join('/') : dropped;
      setUploads({ name: baseName(name), index, count: files.length, sent: sentBefore, total, abort });
      const sent = sentBefore;
      current = fsApi.upload(into, name, file, conflict, (bytes) =>
        setUploads((shown) => shown && { ...shown, sent: sent + bytes }),
      );
      try {
        const result = await current.result;
        made.push(...result.paths);
        skipped += result.conflicts.length;
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          failed = `${baseName(name)}: ${errorMessage(e)}`;
          break;
        }
      }
      sentBefore += file.size;
    }
    setUploads(null);
    refresh();
    if (failed) {
      notify(`Upload stopped at ${failed}`, 'error');
    } else if (cancelled) {
      notify(`Upload cancelled: ${made.length} of ${counted(files.length, 'file')} uploaded`);
    } else {
      notify(`Uploaded ${counted(made.length, 'file')} into ${baseName(into)}${skipped > 0 ? `, ${skipped} skipped` : ''}`);
    }
    const shown = [...new Set(made.map((path) => (into === '/' ? '' : into) + '/' + path.slice(into.length).split('/').filter(Boolean)[0]))];
    if (into === folderRef.current && shown.length > 0) {
      setSelected(new Set(shown));
      setReveal((at) => ({ path: shown[0], seq: (at?.seq ?? 0) + 1 }));
    }
  };

  const paste = (into: string) => {
    if (!clipboard || readOnly) {
      return;
    }
    const { paths, cut: moving } = clipboard;
    if (moving) {
      setClipboard(null);
    }
    void transfer(moving ? 'move' : 'copy', paths, into);
  };

  const copyEntries = (paths: string[], moving: boolean) => {
    if (paths.length === 0 || (moving && readOnly)) {
      return;
    }
    setClipboard({ paths, cut: moving });
    // For a terminal, too
    copyText(paths.join('\n')).catch(() => {});
    notify(`${moving ? 'Cut' : 'Copied'} ${listNames(paths.map(baseName), 2)}: paste ${paths.length === 1 ? 'it' : 'them'} into a folder`);
  };

  const copyPath = (path: string) =>
    copyText(path).then(
      () => notify(`Copied ${path}`),
      (e: unknown) => notify(`Could not copy the path: ${errorMessage(e)}`, 'error'),
    );

  const bookmarks = useMemo(() => {
    const list = [...lines(config.bookmarks).map((path) => ({ path, removable: false })), ...pageBookmarks.map((path) => ({ path, removable: true }))];
    return list.map(({ path, removable }) => ({ path: typedPath(path, '/', home), removable }));
  }, [config.bookmarks, pageBookmarks, home]);

  const placeList = useMemo((): Place[] => {
    const list: Place[] = [];
    const add = (place: Omit<Place, 'removable'> & { removable?: boolean }) => {
      if ((!confined || isWithin(place.path, root!)) && !list.some((known) => known.path === place.path && known.kind === place.kind)) {
        list.push({ removable: false, ...place });
      }
    };
    if (home) {
      add({ name: places?.user ? `Home (${places.user})` : 'Home', path: home, kind: 'home' });
    }
    if (!confined) {
      add({ name: 'The root', path: '/', kind: 'root' });
    }
    const startPath = root ?? (start.startsWith('/') ? start : null);
    if (startPath && startPath !== home && startPath !== '/') {
      add({ name: baseName(startPath), path: startPath, kind: 'folder' });
    }
    for (const workspace of places?.ros ?? []) {
      add({ name: workspace.name, path: workspace.path, kind: 'ros' });
    }
    for (const { path, removable } of bookmarks) {
      add({ name: baseName(path), path, kind: 'bookmark', removable });
    }
    return list;
  }, [home, places, confined, root, start, bookmarks]);

  const bookmark = () => {
    if (!folder || bookmarks.some((known) => known.path === folder)) {
      return;
    }
    const next = [...pageBookmarks, displayPath(folder, home)];
    setPageBookmarks(next);
    storeBookmarks(sessionKey, next);
  };

  const removeBookmark = (path: string) => {
    const next = pageBookmarks.filter((known) => typedPath(known, '/', home) !== path);
    setPageBookmarks(next);
    storeBookmarks(sessionKey, next);
  };

  const selectedPaths = [...selected];
  const parent = folder ? parentOf(folder) : null;
  const canGoUp = parent !== null && (!confined || isWithin(parent, root!));

  // ── The menus ──

  const entryMenu = (path: string): MenuItem[] => {
    const entry = entries.get(path);
    const targets = selected.has(path) ? [...selected] : [path];
    if (!selected.has(path)) {
      setSelected(new Set([path]));
      setAnchor(path);
      setFocus(path);
    }
    const one = targets.length === 1;
    const type = entry ? fileType(entry) : 'other';
    const list: MenuItem[] = [];
    if (one && entry) {
      list.push({
        label: entry.kind === 'dir' ? 'Open' : type === 'text' ? 'Edit' : type === 'image' ? 'View' : 'Details',
        run: () => openEntry(path),
      });
      if (entry.kind === 'file' && type !== 'text') {
        list.push({ label: 'Open as text', run: () => dispatch({ type: 'open', path, kind: 'text' }) });
      }
    }
    list.push({ label: one && entry?.kind === 'dir' ? 'Download as .tar.gz' : 'Download', run: () => download(targets) });
    if (!readOnly) {
      list.push(
        { label: 'Cut', keys: 'Ctrl+X', run: () => copyEntries(targets, true), separated: true },
        { label: 'Copy', keys: 'Ctrl+C', run: () => copyEntries(targets, false) },
      );
      if (one && entry?.kind === 'dir' && clipboard) {
        list.push({ label: 'Paste into it', run: () => paste(path) });
      }
      list.push(
        { label: 'Duplicate', run: () => void transfer('copy', targets, parentOf(targets[0]) ?? '/') },
        { label: 'Move to…', run: () => setPicker({ paths: targets, copy: false }) },
        { label: 'Copy to…', run: () => setPicker({ paths: targets, copy: true }) },
      );
      if (one) {
        list.push({ label: 'Rename', keys: 'F2', run: () => setRenaming(path), separated: true });
      }
    }
    if (one) {
      list.push({ label: 'Copy the path', run: () => void copyPath(path), separated: readOnly });
    }
    list.push({ label: 'Details', keys: 'Alt+Enter', run: () => setDetailsOpen(true) });
    if (!readOnly) {
      list.push({ label: 'Delete', keys: 'Delete', danger: true, separated: true, run: () => void remove(targets) });
    }
    return list;
  };

  const folderMenu = (narrowOnly: boolean): MenuItem[] => [
    ...(readOnly
      ? []
      : [
          { label: 'New folder…', run: () => void make('mkdir'), narrow: narrowOnly },
          { label: 'New file…', run: () => void make('create') },
          { label: 'Upload files…', run: () => uploadRef.current?.click(), narrow: narrowOnly },
          { label: 'Upload a folder…', run: () => uploadFolderRef.current?.click() },
          { label: 'Paste', keys: 'Ctrl+V', disabled: !clipboard, run: () => paste(folder) },
        ]),
    { label: 'Select all', keys: 'Ctrl+A', run: () => setSelected(new Set(rows.flatMap((row) => (row.type === 'entry' && row.depth === 0 ? [row.path] : [])))), separated: !readOnly },
    { label: showHidden ? 'Hide the hidden files' : 'Show the hidden files', keys: 'Ctrl+H', run: () => setShowHidden((on) => !on) },
    { label: 'Read again', run: refresh },
    { label: view === 'overview' ? 'Back to the files' : 'What takes the space', run: () => setView(view === 'overview' ? 'list' : 'overview'), narrow: narrowOnly, separated: true },
    { label: detailsOpen ? 'Hide the details' : 'Details', run: () => setDetailsOpen((on) => !on), narrow: narrowOnly },
    { label: 'Download this folder', run: () => download([folder]), separated: true },
    { label: 'Copy its path', run: () => void copyPath(folder) },
    { label: 'Bookmark this folder', disabled: bookmarks.some((known) => known.path === folder), run: bookmark },
  ];

  const openMenu = (x: number, y: number, list: MenuItem[]) => setMenu({ x, y, items: list });

  // ── The list's events ──

  const latestHandlers = useRef<ListHandlers>(null!);
  // The same for every render, for the rows to be drawn again only when
  // they change
  const handlers = useMemo((): ListHandlers => {
    const latest = <K extends keyof ListHandlers>(name: K) =>
      ((...args: unknown[]) => (latestHandlers.current[name] as (...a: unknown[]) => void)(...args)) as ListHandlers[K];
    return {
      onPointer: latest('onPointer'),
      onClick: latest('onClick'),
      onOpen: latest('onOpen'),
      onFold: latest('onFold'),
      onMenu: latest('onMenu'),
      onRename: latest('onRename'),
      onDragStart: latest('onDragStart'),
      onDragEnd: latest('onDragEnd'),
      onDragOver: latest('onDragOver'),
      onDrop: latest('onDrop'),
      onKeyDown: latest('onKeyDown'),
    };
  }, []);
  latestHandlers.current = {
    onPointer: (type) => {
      pointer.current = type;
    },
    onClick: (path, event: MouseEvent) => {
      if (!path) {
        setSelected(new Set());
        setFocus(null);
        return;
      }
      // A tap opens, as phones do; with a selection, it adds to it
      if (pointer.current === 'touch' && selected.size === 0) {
        openEntry(path);
        return;
      }
      setFocus(path);
      if (event.shiftKey) {
        setSelected(new Set(rowRange(rows, anchor ?? path, path)));
        return;
      }
      setAnchor(path);
      if (event.ctrlKey || event.metaKey || (pointer.current === 'touch' && selected.size > 0)) {
        setSelected((current) => {
          const next = new Set(current);
          if (!next.delete(path)) {
            next.add(path);
          }
          return next;
        });
      } else {
        setSelected(new Set([path]));
      }
    },
    onOpen: (path) => openEntry(path),
    onFold: (path, open) => dispatch({ type: 'fold', folder: path, open }),
    onMenu: (path, x, y) => openMenu(x, y, path ? entryMenu(path) : folderMenu(false)),
    onRename: (path, name) => void rename(path, name),
    onDragStart: (path, event: DragEvent) => {
      const paths = selected.has(path) ? [...selected] : [path];
      if (!selected.has(path)) {
        setSelected(new Set([path]));
        setAnchor(path);
      }
      dragged.current = paths;
      event.dataTransfer.effectAllowed = readOnly ? 'copy' : 'copyMove';
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      const entry = entries.get(path);
      // Chrome downloads a file dragged out of the page
      if (paths.length === 1 && entry?.kind === 'file') {
        event.dataTransfer.setData('DownloadURL', `application/octet-stream:${entry.name}:${new URL(fsApi.downloadUrl([path]), location.href).href}`);
      }
    },
    onDragEnd: () => {
      dragged.current = null;
      setDropTarget(null);
      setDroppingHere(false);
    },
    onDragOver: (into, event: DragEvent) => dragOver(into, event),
    onDrop: (into, event: DragEvent) => drop(into, event),
    onKeyDown: (event, page) => listKey(event, page),
  };

  const dragOver = (into: string | null, event: DragEvent) => {
    const types = event.dataTransfer.types;
    const ours = types.includes(DRAG_TYPE);
    if (readOnly || (!ours && !types.includes('Files')) || !folder) {
      return;
    }
    const target = into ?? folder;
    event.stopPropagation();
    // Not into themselves
    if (ours && dragged.current?.some((path) => isWithin(target, path))) {
      setDropTarget(null);
      setDroppingHere(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = ours && !event.ctrlKey ? 'move' : 'copy';
    setDropTarget(into);
    setDroppingHere(into === null);
  };

  const drop = (into: string | null, event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    setDroppingHere(false);
    const target = into ?? folder;
    if (!target || readOnly) {
      return;
    }
    const ours = event.dataTransfer.getData(DRAG_TYPE);
    if (ours) {
      void transfer(event.ctrlKey ? 'copy' : 'move', JSON.parse(ours) as string[], target);
    } else if (event.dataTransfer.types.includes('Files')) {
      droppedFiles(event.dataTransfer).then(
        (files) => void upload(files, target),
        (e: unknown) => notify(`Cannot read what was dropped: ${errorMessage(e)}`, 'error'),
      );
    }
  };

  const listKey = (event: KeyboardEvent<HTMLDivElement>, page: number) => {
    if (renaming) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const entryRows = rows.filter((row) => row.type === 'entry');
    const index = focus ? entryRows.findIndex((row) => row.path === focus) : -1;
    const row = entryRows[index];
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };
    const moveTo = (next: number) => {
      if (entryRows.length === 0) {
        return;
      }
      const path = entryRows[Math.min(entryRows.length - 1, Math.max(0, next))].path;
      setFocus(path);
      if (event.shiftKey) {
        setSelected(new Set(rowRange(rows, anchor ?? path, path)));
      } else if (!mod) {
        setSelected(new Set([path]));
        setAnchor(path);
      }
      setReveal((current) => ({ path, seq: (current?.seq ?? 0) + 1 }));
    };
    if (event.altKey && key.startsWith('Arrow')) {
      // The widget's: back, forward, up
      return;
    } else if (event.altKey && key === 'Enter') {
      run(() => setDetailsOpen(true));
    } else if (key === 'ArrowDown') {
      run(() => moveTo(index + 1));
    } else if (key === 'ArrowUp') {
      run(() => moveTo(index < 0 ? 0 : index - 1));
    } else if (key === 'PageDown') {
      run(() => moveTo(index + page));
    } else if (key === 'PageUp') {
      run(() => moveTo(index - page));
    } else if (key === 'Home') {
      run(() => moveTo(0));
    } else if (key === 'End') {
      run(() => moveTo(entryRows.length - 1));
    } else if (key === 'ArrowRight' && row?.type === 'entry' && row.open !== null) {
      run(() => (row.open ? moveTo(index + 1) : dispatch({ type: 'fold', folder: row.path, open: true })));
    } else if (key === 'ArrowLeft' && row?.type === 'entry') {
      run(() => {
        if (row.open) {
          dispatch({ type: 'fold', folder: row.path, open: false });
        } else if (row.depth > 0) {
          moveTo(entryRows.findIndex((other) => other.path === parentOf(row.path)));
        }
      });
    } else if (key === 'Enter') {
      run(() => {
        const chosen = selected.size > 0 ? [...selected] : focus ? [focus] : [];
        // Several: the files open, the first folder gone into
        const folders = chosen.filter((path) => entries.get(path)?.kind === 'dir');
        chosen.filter((path) => entries.get(path)?.kind !== 'dir').forEach((path) => openEntry(path));
        if (folders.length > 0 && chosen.length === folders.length) {
          openEntry(folders[0]);
        }
      });
    } else if (key === 'Backspace') {
      run(() => canGoUp && go(parent!));
    } else if (key === 'Delete') {
      run(() => void remove(selectedPaths));
    } else if (key === 'F2') {
      run(() => !readOnly && (focus ?? selectedPaths[0]) && setRenaming(focus ?? selectedPaths[0]));
    } else if (key === 'Escape') {
      run(() => (selected.size > 0 ? setSelected(new Set()) : setDetailsOpen(false)));
    } else if (key === ' ' && focus) {
      run(() =>
        setSelected((current) => {
          const next = new Set(current);
          if (!next.delete(focus)) {
            next.add(focus);
          }
          return next;
        }),
      );
    } else if (mod && key.toLowerCase() === 'a') {
      run(() => setSelected(new Set(rows.flatMap((other) => (other.type === 'entry' && other.depth === 0 ? [other.path] : [])))));
    } else if (mod && key.toLowerCase() === 'c') {
      run(() => copyEntries(selectedPaths, false));
    } else if (mod && key.toLowerCase() === 'x') {
      run(() => copyEntries(selectedPaths, true));
    } else if (mod && key.toLowerCase() === 'v') {
      run(() => paste(folder));
    } else if (mod && key.toLowerCase() === 'h') {
      run(() => setShowHidden((on) => !on));
    } else if (key.length === 1 && !mod && !event.altKey) {
      // The first name starting with what is typed
      const at = Date.now();
      const typed = (at - typeAhead.current.at < TYPE_AHEAD_MS ? typeAhead.current.text : '') + key.toLowerCase();
      typeAhead.current = { text: typed, at };
      const found = entryRows.findIndex((other, position) => position >= (typed.length > 1 ? Math.max(0, index) : index + 1) && other.type === 'entry' && other.entry.name.toLowerCase().startsWith(typed));
      const wrapped = found >= 0 ? found : entryRows.findIndex((other) => other.type === 'entry' && other.entry.name.toLowerCase().startsWith(typed));
      if (wrapped >= 0) {
        run(() => moveTo(wrapped));
      }
    }
  };

  // ── The text files ──

  // Read when opened, and again when asked
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const tab of state.tabs) {
      const key = `${tab.id}:${tab.reads}`;
      if (tab.kind !== 'text' || requested.current.has(key) || (tab.text !== null && tab.reads === 0)) {
        continue;
      }
      requested.current.add(key);
      fsApi.readText(tab.path).then(
        (file) => file && dispatch({ type: 'read', id: tab.id, file }),
        (e: unknown) => dispatch({ type: 'failed', id: tab.id, error: errorMessage(e) }),
      );
    }
  }, [state.tabs]);

  // Changed on the robot: polled
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      for (const tab of tabsRef.current) {
        if (tab.kind !== 'text' || tab.stamp === null || tab.missing) {
          continue;
        }
        fsApi.readText(tab.path, tab.stamp).then(
          (file) => file && dispatch({ type: 'changed', id: tab.id, file }),
          (e: unknown) => e instanceof ApiError && e.status === 404 && dispatch({ type: 'missing', id: tab.id }),
        );
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const textOf = (tab: TextTab) => (tab.eol === '\r\n' ? tab.text!.replace(/\n/g, '\r\n') : tab.text!);

  const save = async (tab: TextTab) => {
    if (tab.text === null || saving !== null || !isDirty(tab)) {
      return;
    }
    if (readOnly) {
      notify('This widget is read-only', 'error');
      return;
    }
    if (tab.readOnly && !tab.missing) {
      notify(`${tab.readOnly}: Save as…`, 'error');
      return;
    }
    const text = tab.text;
    setSaving(tab.id);
    try {
      const result = await fsApi.saveText(tab.path, textOf(tab), tab.missing ? null : tab.base, tab.missing);
      if (result.conflict) {
        dispatch({ type: 'conflict', id: tab.id, version: result.version, stamp: result.stamp });
        notify('Not saved: the file changed on the robot since it was read', 'error');
      } else {
        dispatch({ type: 'saved', id: tab.id, text, version: result.version, stamp: result.stamp });
        notify(`Saved ${baseName(tab.path)}`);
        refresh();
      }
    } catch (e) {
      notify(`Could not save ${tab.path}: ${errorMessage(e)}`, 'error');
    } finally {
      setSaving(null);
    }
  };

  const closeTab = async (tab: Tab) => {
    if (
      isDirty(tab) &&
      !(await dialogs.confirm({
        title: `Close ${baseName(tab.path)}?`,
        message: 'Its changes are not saved.',
        confirmLabel: 'Close it',
        danger: true,
      }))
    ) {
      return;
    }
    dispatch({ type: 'close', id: tab.id });
  };

  const goToLine = async (tab: TextTab) => {
    const starts = lineStarts(tab.text ?? '');
    const answer = await dialogs.prompt({
      title: 'Go to line',
      label: `Line, 1 to ${starts.length.toLocaleString()}`,
      initial: String(lineAt(starts, tab.selection.end) + 1),
      confirmLabel: 'Go',
    });
    const line = Number(answer);
    if (answer && Number.isFinite(line)) {
      editorRef.current?.goToLine(Math.round(line));
    }
  };

  const textTab = activeTab?.kind === 'text' ? activeTab : null;
  useEffect(() => setImageSize(''), [activeTab?.id]);

  // ── The view ──

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (textTab && mod && key === 's') {
      event.preventDefault();
      void save(textTab);
    } else if (filesShown && mod && key === 'f' && !(event.target as HTMLElement).closest('input, textarea')) {
      event.preventDefault();
      filterRef.current?.focus();
    } else if (filesShown && mod && key === 'l') {
      event.preventDefault();
      setAddress(displayPath(folder, home));
    } else if (filesShown && event.altKey && !(event.target as HTMLElement).closest('input, textarea')) {
      const step = { arrowup: () => canGoUp && go(parent!), arrowleft: () => dispatch({ type: 'back' }), arrowright: () => dispatch({ type: 'forward' }) }[key];
      if (step) {
        event.preventDefault();
        step();
      }
    }
  };

  let content;
  if (activeTab?.kind === 'image') {
    content = <ImageView path={activeTab.path} reads={activeTab.reads} onSize={setImageSize} />;
  } else if (textTab) {
    if (textTab.text === null) {
      content = (
        <div className={`widget-message${textTab.error ? ' error' : ''} fm-empty`}>
          <p>{textTab.error ?? 'Reading…'}</p>
          {textTab.error && (
            <div className="fm-empty-actions">
              <button type="button" className="button" onClick={() => download([textTab.path])}>
                Download it
              </button>{' '}
              <button type="button" className="button" onClick={() => dispatch({ type: 'close', id: textTab.id })}>
                Close
              </button>
            </div>
          )}
        </div>
      );
    } else {
      content = (
        <TextEditor
          key={textTab.id}
          ref={editorRef}
          tab={textTab as TextTab & { text: string }}
          wrap={wrap}
          readOnly={readOnly}
          dispatch={dispatch}
          onSave={() => void save(textTab)}
          onGoToLine={() => void goToLine(textTab)}
        />
      );
    }
  } else if (view === 'overview' && folder) {
    content = (
      <Overview
        folder={folder}
        home={home}
        disks={config.confine ? null : disks}
        now={now}
        onGo={(target) => {
          setView('list');
          go(target);
        }}
        onReveal={showEntry}
        onRefreshDisks={() => setDisksAsked((n) => n + 1)}
      />
    );
  } else {
    let empty;
    if (folderError) {
      empty = (
        <>
          <p>{folderError}</p>
          {canGoUp && (
            <button type="button" className="button" onClick={() => go(parent!)}>
              Go up
            </button>
          )}{' '}
          {!folder && home && (
            <button type="button" className="button" onClick={() => go(home)}>
              Go home
            </button>
          )}
        </>
      );
    } else if (!listing) {
      empty = offline ? 'Cannot reach the robot' : 'Reading…';
    } else if (filterText) {
      empty = `No name contains “${filterText}”`;
    } else if (listing.entries.length > 0) {
      empty = `Only hidden files: ${listing.entries.length.toLocaleString()} (Ctrl+H)`;
    } else {
      empty = readOnly ? 'Empty folder' : 'Empty folder: drop files here to upload them';
    }
    content = (
      <div ref={listRef} className="fm-files">
        <FileList
          rows={rows}
          version={folder}
          selected={selected}
          focus={focus}
          cut={cut}
          dropTarget={dropTarget}
          droppingHere={droppingHere}
          renaming={renaming}
          sort={sort}
          now={now}
          empty={empty}
          reveal={reveal}
          handlers={handlers}
          onSort={(key: SortKey) =>
            setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== 'name' }))
          }
        />
      </div>
    );
  }

  const mainWidth = width - (showSidebar && !narrow ? 240 : 0);
  const detailsShown = filesShown && detailsOpen && folder !== '';
  const beside = detailsShown && mainWidth - DETAILS_PX >= BESIDE_DETAILS_PX;

  const banners: { text: string; tone: 'error' | 'warning'; actions?: { label: string; run: () => void }[] }[] = [];
  if (textTab?.external) {
    banners.push({
      text: textTab.external.text === null ? 'Not saved: the file changed on the robot since it was read' : 'The file changed on the robot, and this one has changes',
      tone: 'warning',
      actions: [
        { label: 'Load it', run: () => dispatch({ type: 'reload', id: textTab.id }) },
        { label: 'Keep mine', run: () => dispatch({ type: 'keep', id: textTab.id }) },
      ],
    });
  }
  if (textTab?.missing) {
    banners.push({ text: 'Deleted on the robot: saving makes it again', tone: 'warning' });
  }
  if (offline && (listing || textTab)) {
    banners.push({ text: 'Cannot reach the robot: what is shown may be out of date', tone: 'error' });
  }
  if (listing && listing.truncated > 0 && filesShown && view === 'list') {
    banners.push({ text: `${listing.truncated.toLocaleString()} more entries are not listed: the folder is too large`, tone: 'warning' });
  }

  // The path of the folder, or of the file shown, its folders clickable
  const pathOf = activeTab ? activeTab.path : folder;
  const allCrumbs = pathOf ? crumbs(pathOf, home, confined ? root! : '/') : [];
  // Deep: the first, and the last ones; those between typed
  const most = width > 0 && width < NARROW_CRUMBS_PX ? 2 : MAX_CRUMBS;
  const pathCrumbs: { name: string; path: string | null }[] =
    allCrumbs.length <= most
      ? allCrumbs
      : most === 2
        ? [{ name: '…', path: null }, allCrumbs[allCrumbs.length - 1]]
        : [allCrumbs[0], { name: '…', path: null }, ...allCrumbs.slice(-(most - 2))];
  const addressBar =
    address !== null ? (
      <form
        className="fm-address"
        onSubmit={(e) => {
          e.preventDefault();
          setAddress(null);
          focusView();
          void goTyped(address);
        }}
      >
        <input
          value={address}
          autoFocus
          spellCheck={false}
          aria-label="Go to the folder"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAddress(null);
              focusView();
            }
          }}
          onBlur={() => setAddress(null)}
        />
      </form>
    ) : (
      <div
        className="fm-crumbs bt-path"
        title="Click to type a path (Ctrl+L)"
        onClick={(e) => e.target === e.currentTarget && filesShown && setAddress(displayPath(folder, home))}
      >
        {pathCrumbs.map((crumb, index) => {
          const isLast = index === pathCrumbs.length - 1;
          const { path } = crumb;
          if (path === null) {
            return (
              <button key="…" type="button" title={displayPath(pathOf, home)} onClick={() => setAddress(displayPath(activeTab ? (parentOf(pathOf) ?? '/') : folder, home))}>
                …
              </button>
            );
          }
          return (
            <button
              key={path}
              type="button"
              className={`${isLast ? 'current' : ''}${dropTarget === path ? ' drop-into' : ''}`}
              title={displayPath(path, home)}
              onClick={() => (isLast && activeTab ? undefined : isLast ? setAddress(displayPath(folder, home)) : go(path))}
              onDragOver={(e) => dragOver(path, e)}
              onDrop={(e) => drop(path, e)}
            >
              {crumb.name}
            </button>
          );
        })}
      </div>
    );

  const toolbarMenu = (event: MouseEvent<HTMLButtonElement>, list: MenuItem[]) => {
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(box.left, box.bottom + 4, list);
  };

  let toolbar;
  if (textTab) {
    const dirty = isDirty(textTab);
    toolbar = (
      <>
        <button
          type="button"
          className={`button bte-save${dirty ? ' primary' : ''}`}
          disabled={!dirty || saving !== null || readOnly || (textTab.readOnly !== null && !textTab.missing)}
          title={textTab.readOnly ? `${textTab.readOnly}: Save as…` : 'Save (Ctrl+S)'}
          onClick={() => void save(textTab)}
        >
          <SaveIcon width={16} height={16} />
          <span className="bte-save-label">Save</span>
        </button>
        <button type="button" className="overlay-button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={textTab.history.past.length === 0} onClick={() => dispatch({ type: 'undo', id: textTab.id })}>
          <UndoIcon width={17} height={17} />
        </button>
        <button type="button" className="overlay-button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={textTab.history.future.length === 0} onClick={() => dispatch({ type: 'redo', id: textTab.id })}>
          <RedoIcon width={17} height={17} />
        </button>
        <span className="overlay-separator" />
        <button type="button" className="overlay-button" title="Find and replace (Ctrl+F, Ctrl+H)" aria-label="Find" disabled={textTab.text === null} onClick={() => editorRef.current?.find(false)}>
          <SearchIcon width={17} height={17} />
        </button>
        <button type="button" className="overlay-button bte-wide" aria-pressed={wrap} title="Wrap long lines" aria-label="Wrap long lines" onClick={() => setWrap((on) => !on)}>
          <WrapIcon width={17} height={17} />
        </button>
        {addressBar}
        <button
          type="button"
          className="overlay-button"
          aria-label="File"
          title="File"
          onClick={(e) =>
            toolbarMenu(e, [
              { label: wrap ? 'Do not wrap the lines' : 'Wrap long lines', run: () => setWrap((on) => !on), narrow: true },
              { label: 'Save as…', disabled: textTab.text === null || readOnly, run: () => setSaveAs(textTab.id) },
              { label: 'Download', run: () => download([textTab.path]) },
              { label: 'Go to line…', keys: 'Ctrl+I', disabled: textTab.text === null, run: () => void goToLine(textTab) },
              {
                label: dirty ? 'Discard the changes' : 'Read it again',
                danger: dirty,
                run: async () => {
                  if (!dirty || (await dialogs.confirm({ title: 'Discard the changes?', message: 'The file is read again from the robot.', confirmLabel: 'Discard them', danger: true }))) {
                    dispatch({ type: 'reload', id: textTab.id });
                  }
                },
              },
              { label: 'Show it in its folder', run: () => showEntry(textTab.path), separated: true },
              { label: 'Copy its path', run: () => void copyPath(textTab.path) },
              { label: 'Close', run: () => void closeTab(textTab), separated: true },
            ])
          }
        >
          <MoreIcon width={17} height={17} />
        </button>
      </>
    );
  } else if (activeTab) {
    toolbar = (
      <>
        {addressBar}
        <button type="button" className="overlay-button" title="Download" aria-label="Download" onClick={() => download([activeTab.path])}>
          <DownloadIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button"
          aria-label="Image"
          title="Image"
          onClick={(e) =>
            toolbarMenu(e, [
              { label: 'Open as text', run: () => dispatch({ type: 'open', path: activeTab.path, kind: 'text' }) },
              { label: 'Show it in its folder', run: () => showEntry(activeTab.path) },
              { label: 'Copy its path', run: () => void copyPath(activeTab.path) },
              { label: 'Close', run: () => void closeTab(activeTab), separated: true },
            ])
          }
        >
          <MoreIcon width={17} height={17} />
        </button>
      </>
    );
  } else {
    toolbar = (
      <>
        <button type="button" className="overlay-button" title="Back (Alt+←)" aria-label="Back" disabled={state.back.length === 0} onClick={() => dispatch({ type: 'back' })}>
          <ArrowLeftIcon width={17} height={17} />
        </button>
        <button type="button" className="overlay-button bte-wide" title="Forward (Alt+→)" aria-label="Forward" disabled={state.forward.length === 0} onClick={() => dispatch({ type: 'forward' })}>
          <ArrowRightIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className={`overlay-button${dropTarget === parent ? ' drop-into' : ''}`}
          title="Up (Alt+↑)"
          aria-label="Up"
          disabled={!canGoUp}
          onClick={() => canGoUp && go(parent!)}
          onDragOver={(e) => canGoUp && dragOver(parent!, e)}
          onDrop={(e) => canGoUp && drop(parent!, e)}
        >
          <ArrowUpIcon width={17} height={17} />
        </button>
        {addressBar}
        <label className="fm-search fm-filter" title="Only the names containing these words (Ctrl+F)">
          <SearchIcon width={14} height={14} />
          <input
            ref={filterRef}
            type="search"
            value={filterText}
            placeholder="Filter…"
            aria-label="Only the names containing"
            spellCheck={false}
            onChange={(e) => {
              setFilterText(e.target.value);
              setView('list');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('');
                listRef.current?.querySelector<HTMLElement>('.fm-list')?.focus();
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault();
                listRef.current?.querySelector<HTMLElement>('.fm-list')?.focus();
                const first = rows.find((row) => row.type === 'entry');
                if (first) {
                  revealPath(first.path);
                  if (e.key === 'Enter' && rows.filter((row) => row.type === 'entry').length === 1) {
                    openEntry(first.path);
                  }
                }
              }
            }}
          />
        </label>
        {!readOnly && (
          <>
            <button type="button" className="overlay-button bte-wide" title="New folder" aria-label="New folder" disabled={!folder} onClick={() => void make('mkdir')}>
              <FolderPlusIcon width={17} height={17} />
            </button>
            <button type="button" className="overlay-button bte-wide" title="Upload files (or drop them here)" aria-label="Upload files" disabled={!folder || uploads !== null} onClick={() => uploadRef.current?.click()}>
              <UploadIcon width={17} height={17} />
            </button>
          </>
        )}
        <span className="overlay-separator bte-wide" />
        <button type="button" className="overlay-button bte-wide" aria-pressed={view === 'overview'} title="What takes the space: the disks, this folder" aria-label="What takes the space" disabled={!folder} onClick={() => setView(view === 'overview' ? 'list' : 'overview')}>
          <PieChartIcon width={17} height={17} />
        </button>
        <button type="button" className="overlay-button bte-wide" aria-pressed={detailsOpen} title="Details (Alt+Enter)" aria-label="Details" disabled={!folder} onClick={() => setDetailsOpen((on) => !on)}>
          <InfoIcon width={17} height={17} />
        </button>
        <button type="button" className="overlay-button" aria-label="Folder" title="Folder" disabled={!folder} onClick={(e) => toolbarMenu(e, folderMenu(true))}>
          <MoreIcon width={17} height={17} />
        </button>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      className="bt bte fm"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropTarget(null);
          setDroppingHere(false);
        }
      }}
    >
      {banners.map((banner) => (
        <div key={banner.text} className={`bt-banner ${banner.tone} bte-banner`} title={banner.text}>
          <span>{banner.text}</span>
          {banner.actions?.map((action) => (
            <button key={action.label} type="button" className="link-button" onClick={action.run}>
              {action.label}
            </button>
          ))}
        </div>
      ))}
      <div className="bte-toolbar fm-toolbar" role="toolbar" aria-label="Files">
        <button type="button" className="overlay-button" aria-pressed={showSidebar} title="The places" aria-label="The places" onClick={() => setSidebarOpen(!showSidebar)}>
          <SidebarIcon width={17} height={17} />
        </button>
        {toolbar}
      </div>
      {state.tabs.length > 0 && (
        <TabStrip
          tabs={state.tabs}
          active={state.active}
          folder={folder}
          home={home}
          onActivate={(id) => dispatch({ type: 'activate', id })}
          onClose={(tab) => void closeTab(tab)}
        />
      )}
      <div className={`bte-body fm-body${narrow ? ' narrow' : ''}`}>
        {showSidebar && (
          <Sidebar
            places={placeList}
            disks={config.confine ? null : disks}
            folder={pathOf}
            dropTarget={dropTarget}
            canBookmark={folder !== '' && !bookmarks.some((known) => known.path === folder)}
            onGo={(target) => {
              dispatch({ type: 'activate', id: null });
              go(target);
              if (narrow) {
                setSidebarOpen(false);
              }
            }}
            onBookmark={bookmark}
            onRemoveBookmark={removeBookmark}
            onDragOver={(target, e) => dragOver(target, e)}
            onDrop={(target, e) => drop(target, e)}
            onClose={() => setSidebarOpen(false)}
          />
        )}
        <div className={`bt-main fm-main${beside ? ' beside' : ''}`}>
          {content}
          {detailsShown && (
            <Details
              paths={selectedPaths}
              folder={folder}
              entries={entries}
              version={listing?.version ?? ''}
              home={home}
              readOnly={readOnly}
              now={now}
              actions={{
                onOpen: (path) => openEntry(path, entries.get(path) ?? undefined),
                onGo: go,
                onDownload: download,
                onRename: (path) => {
                  setView('list');
                  setRenaming(path);
                },
                onMove: (paths, copy) => setPicker({ paths, copy }),
                onDelete: (paths) => void remove(paths),
                onChmod: changeMode,
              }}
              onClose={() => setDetailsOpen(false)}
            />
          )}
        </div>
      </div>
      <StatusLine
        uploads={uploads}
        textTab={textTab}
        saving={textTab !== null && saving === textTab.id}
        image={activeTab?.kind === 'image' ? { path: activeTab.path, size: imageSize } : null}
        folder={{
          path: folder,
          listing,
          error: folderError,
          offline,
          shown: rows.filter((row) => row.type === 'entry' && row.depth === 0).length,
          showHidden,
          selected: selected.size,
          entries: selectedPaths.flatMap((path) => entries.get(path) ?? []),
        }}
        readOnly={readOnly}
        onSettings={(settings) => textTab && dispatch({ type: 'settings', id: textTab.id, ...settings })}
      />
      <input
        ref={uploadRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])].map((file) => ({ file, name: file.name }));
          e.target.value = '';
          void upload(chosen, folder);
        }}
      />
      <input
        ref={(input) => {
          uploadFolderRef.current = input;
          // A folder chosen, with all it holds: not in React's types
          input?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        hidden
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])].map((file) => ({ file, name: file.webkitRelativePath || file.name }));
          e.target.value = '';
          void upload(chosen, folder);
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {conflict && <ConflictDialog question={conflict} onDone={() => setConflict(null)} />}
      {picker && (
        <FileBrowser
          kind="folder"
          start={folder || '~'}
          onChoose={(target) => {
            setPicker(null);
            void transfer(picker.copy ? 'copy' : 'move', picker.paths, typedPath(target, '/', home));
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {saveAs !== null &&
        (() => {
          const tab = state.tabs.find((known) => known.id === saveAs);
          if (!tab || tab.kind !== 'text' || tab.text === null) {
            return null;
          }
          return (
            <SaveAsDialog
              initial={displayPath(tab.path, home)}
              text={textOf(tab)}
              onSaved={(path, version, stamp) => {
                setSaveAs(null);
                const absolute = typedPath(path, '/', home);
                dispatch({ type: 'saved', id: tab.id, text: tab.text!, version, stamp, path: absolute });
                notify(`Saved as ${path}`);
                refresh();
              }}
              onClose={() => setSaveAs(null)}
            />
          );
        })()}
    </div>
  );
}

export const fileManagerWidget = defineWidget<FileManagerConfig>({
  type: 'file-manager',
  name: 'File Manager',
  description: 'The robot’s files: browse, upload, download, rename, move and delete them, see what fills the disks, and edit text files.',
  icon: FolderIcon,
  defaultSize: { w: 10, h: 7 },
  minSize: { w: 4, h: 4 },
  component: FileManagerWidget,
  properties: [
    {
      key: 'folder',
      label: 'Folder',
      kind: 'string',
      default: '~',
      placeholder: '~/maps',
      help: 'Where it opens: /…, ~/… or package://<package>/…',
    },
    {
      key: 'bookmarks',
      label: 'Bookmarks',
      kind: 'text',
      default: '',
      placeholder: '~/ros2_ws/src\n~/maps\n/var/log',
      help: 'Folders among its places, one a line. Its places also bookmark folders, in this browser',
    },
    {
      key: 'confine',
      label: 'Stay in the folder',
      kind: 'boolean',
      default: false,
      help: 'Its folder and those under it only, e.g. a widget for the maps. Not a protection: see Security in the README',
    },
    {
      key: 'readOnly',
      label: 'Read only',
      kind: 'boolean',
      default: false,
      help: 'Browses and downloads, changes nothing. Not a protection either',
    },
    {
      key: 'showHidden',
      label: 'Show the hidden files',
      kind: 'boolean',
      default: false,
      help: 'Those whose name starts with a dot. Ctrl+H shows and hides them',
    },
    {
      key: 'wrap',
      label: 'Wrap long lines in the editor',
      kind: 'boolean',
      default: false,
      help: 'Its toolbar switches it. Wrapped, the text is not highlighted',
    },
  ],
});
