// The behavior tree editor: a BT.CPP behavior tree's XML file of the robot,
// edited as a graph, a BehaviorTree at a time. Nodes come from a palette
// (BT.CPP's, Nav2's, the libraries' loaded, the file's), dragged where they
// go or added with the selection; they move by dragging, with their
// children, and are edited in a side panel: name, ports, attributes. Undo,
// redo, copy, paste; an XML view; subtrees opened by double click.
//
// The server reads the file, and again whenever it changes, for every page
// (src/server/behavior_tree_files.ts); a save writes only what changed, and
// only over the version read: changes on the robot are never lost unseen.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';

import type { BtNodeModel } from '../../../shared/bt_nodes.ts';
import { guessKind } from '../../../shared/bt_nodes.ts';
import type { BehaviorTreeModels } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import { useDialogs } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import {
  AppsIcon,
  ArrowRightIcon,
  CodeIcon,
  FitIcon,
  MoreIcon,
  PlusIcon,
  RedoIcon,
  SaveIcon,
  SlidersIcon,
  TreeEditIcon,
  UndoIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { EditorGraph, type EditorGraphHandle } from './EditorGraph.tsx';
import { FileDialog, newTreeText, XmlView } from './EditorDialogs.tsx';
import {
  addTree,
  behaviorTrees,
  buildCatalog,
  canUnwrap,
  freeTreeId,
  insertionPoint,
  mainTree,
  newNode,
  nodeType,
  removeTree,
  renameTree,
  setMainTree,
  treeFormat,
  treeGraph,
  withType,
  type DropTarget,
} from './editor_model.ts';
import { documentText, editorReducer, editorSessions, initialState, isDirty, unsavedEditors } from './editor_state.ts';
import type { Direction } from './layout.ts';
import { NodePalette, type PaletteItem } from './NodePalette.tsx';
import { NodePicker, NodeProperties, TreeProperties, type NodeActions } from './NodeProperties.tsx';
import type { Point } from './pan_zoom.ts';
import { KindIcon } from './parts.tsx';
import { baseName } from './RecordPlayback.tsx';
import {
  cloneNode,
  insertNode,
  isNode,
  locate,
  moveNode,
  removeNode,
  renameAttribute,
  replaceNode,
  setAttribute,
  unwrapNode,
  wrapNode,
  writeDocument,
  type XmlDocument,
  type XmlNode,
} from './xml_document.ts';

interface BehaviorTreeEditorConfig {
  tree: string;
  libraries: string;
  direction: Direction;
  showPorts: boolean;
}

// Narrower than this, the palette covers the graph, and starts closed
const NARROW_PX = 620;
// The properties' (.bt-details), with their margins; on narrower graphs they
// cover it, which has no room to be beside them
const PANEL_PX = 300 + 16;
const BESIDE_PANEL_PX = 240;
// Libraries loaded in a page, by widget: kept by the browser
const LIBRARIES_KEY = 'tassello.behaviorTreeEditor.libraries';

// Copied or cut: pasted into any editor of the page
let clipboard: XmlNode | null = null;

// A page leaving with changes not saved asks first
let guarding = false;
function guardUnload(): void {
  if (!guarding) {
    guarding = true;
    window.addEventListener('beforeunload', (event) => {
      if (unsavedEditors()) {
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

function storedLibraries(key: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(LIBRARIES_KEY) ?? '{}') as Record<string, string[]>;
    return Array.isArray(stored[key]) ? stored[key] : [];
  } catch {
    return [];
  }
}

function storeLibraries(key: string, libraries: string[]): void {
  try {
    const stored = JSON.parse(localStorage.getItem(LIBRARIES_KEY) ?? '{}') as Record<string, string[]>;
    if (libraries.length > 0) {
      stored[key] = libraries;
    } else {
      delete stored[key];
    }
    localStorage.setItem(LIBRARIES_KEY, JSON.stringify(stored));
  } catch {
    // No storage: for this page only
  }
}

// The XML of a node alone, for the system's clipboard
function nodeXml(document: XmlDocument, node: XmlNode): string {
  return writeDocument({ ...document, prolog: '', epilog: '', root: { ...node, source: null } });
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BehaviorTreeEditorWidget({ config, instance, panelId }: WidgetProps<BehaviorTreeEditorConfig>) {
  const sessionKey = `${panelId}/${instance.id}`;
  const configPath = config.tree.trim();
  const [session] = useState(() => {
    const kept = editorSessions.get(sessionKey);
    return kept?.config === configPath ? kept : { config: configPath, state: initialState(configPath), libraries: storedLibraries(sessionKey) };
  });
  const [state, dispatch] = useReducer(editorReducer, session.state);
  const [extraLibraries, setExtraLibraries] = useState(session.libraries);
  const [models, setModels] = useState<BehaviorTreeModels | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const [focus, setFocus] = useState<{ key: number; seq: number } | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [showPorts, setShowPorts] = useState(config.showPorts);
  const [xmlView, setXmlView] = useState(false);
  const [width, setWidth] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'open' | 'new' | 'save-as' | 'library' | null>(null);
  const [picker, setPicker] = useState<'wrap' | 'replace' | null>(null);
  // Trees opened from their subtrees, to go back to
  const [trail, setTrail] = useState<number[]>([]);
  // A node of the palette dragged: what, and where on the page
  const [dragged, setDragged] = useState<{ item: PaletteItem; at: Point } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<EditorGraphHandle>(null);
  const startedFrom = useRef(session.config);
  const dialogs = useDialogs();

  useEffect(guardUnload, []);

  // The widget's file changed (edit mode): it, from the start
  useEffect(() => {
    if (configPath !== startedFrom.current) {
      startedFrom.current = configPath;
      dispatch({ type: 'open', path: configPath });
    }
  }, [configPath]);

  useEffect(() => {
    editorSessions.set(sessionKey, { config: startedFrom.current, state, libraries: extraLibraries });
  }, [sessionKey, state, extraLibraries]);

  const libraries = useMemo(() => [...new Set([...lines(config.libraries), ...extraLibraries])], [config.libraries, extraLibraries]);
  const librariesKey = libraries.join('\n');
  useEffect(() => {
    if (!state.path) {
      return;
    }
    return connection.subscribeBehaviorTreeFile(
      { path: state.path, libraries: librariesKey ? librariesKey.split('\n') : [] },
      { file: (file) => dispatch({ type: 'file', file }), models: setModels },
    );
  }, [state.path, state.opened, librariesKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const { document: doc } = state;
  const format = doc ? treeFormat(doc) : 4;
  const trees = useMemo(() => (doc ? behaviorTrees(doc) : []), [doc]);
  const main = useMemo(() => (doc ? mainTree(doc) : undefined), [doc]);
  const tree = trees.find((entry) => entry.key === state.tree) ?? main;
  const catalog = useMemo(
    () => (doc ? buildCatalog(doc, models?.libraries ?? [], models?.trees ?? []) : null),
    [doc, models],
  );
  const graph = useMemo(() => (tree && catalog ? treeGraph(tree.node, catalog) : null), [tree, catalog]);
  const indices = useMemo(() => new Map(graph?.nodes.map((node, index) => [node.key, index]) ?? []), [graph]);
  const selectedIndex = selected === null ? null : (indices.get(selected) ?? null);
  const dirty = isDirty(state);
  const narrow = width > 0 && width < NARROW_PX;
  const showPalette = !xmlView && doc !== null && (paletteOpen ?? !narrow);
  const canvasWidth = width - (showPalette && !narrow ? 240 : 0);
  const panelShown = !xmlView && graph !== null && selectedIndex !== null;
  const covered = panelShown && canvasWidth - PANEL_PX >= BESIDE_PANEL_PX ? PANEL_PX : 0;

  // Another tree, another document: what was chosen of it goes
  useEffect(() => {
    setFolded(new Set());
    setTrail((current) => current.filter((key) => trees.some((entry) => entry.key === key)));
  }, [tree?.key]);

  const items = useMemo((): PaletteItem[] => {
    if (!catalog || !doc) {
      return [];
    }
    const known: PaletteItem[] = [...catalog.byId.values()].map(({ model, library }) => ({ model, library }));
    const subtrees = catalog.trees
      .filter((id) => id !== tree?.id)
      .map((id) => ({
        model: { id, kind: 'subtree' as const, ports: [], description: catalog.treeFiles.has(id) ? `In ${catalog.treeFiles.get(id)}` : 'A tree of this file' },
        library: catalog.treeFiles.has(id) ? baseName(catalog.treeFiles.get(id)!) : 'This file',
      }));
    // Used in the file, known by no library
    const unknown = new Map<string, PaletteItem>();
    const visit = (node: XmlNode, depth: number) => {
      const type = nodeType(node);
      if (depth > 1 && type !== 'SubTree' && !catalog.byId.has(type) && !unknown.has(type)) {
        const children = node.children.filter(isNode).length;
        unknown.set(type, { model: { id: type, kind: guessKind(type, children), ports: [], description: 'Used in this file, in no library' }, library: 'Used here' });
      }
      node.children.forEach((child) => isNode(child) && visit(child, depth + 1));
    };
    trees.forEach((entry) => visit(entry.node, 1));
    return [...known, ...subtrees, ...unknown.values()];
  }, [catalog, doc, tree?.id, trees]);

  const select = (key: number) => {
    setSelected(key);
    setFocus((current) => ({ key, seq: (current?.seq ?? 0) + 1 }));
  };

  const edit = useCallback((next: XmlDocument, options: { tag?: string; select?: number | null; tree?: number } = {}) => {
    dispatch({ type: 'edit', document: next, tag: options.tag, tree: options.tree });
    if (options.select !== undefined) {
      setSelected(options.select);
      if (options.select !== null) {
        setFocus((current) => ({ key: options.select!, seq: (current?.seq ?? 0) + 1 }));
      }
    }
  }, []);

  const save = async () => {
    if (!doc || saving || !dirty) {
      return;
    }
    if (state.readOnly) {
      notify(`${state.readOnly}: Save as…`, 'error');
      return;
    }
    const text = documentText(doc);
    setSaving(true);
    try {
      const result = await connection.saveBehaviorTreeFile(state.path, text, state.base);
      if (result.conflict) {
        dispatch({ type: 'conflict', version: result.version });
        notify('Not saved: the file changed on the robot since it was read', 'error');
      } else {
        dispatch({ type: 'saved', text, version: result.version });
        notify(`Saved ${baseName(state.path)}`);
      }
    } catch (e) {
      notify(`Could not save ${state.path}: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Another file: the changes to this one are lost, if the user agrees
  const open = async (path: string) => {
    if (
      dirty &&
      !(await dialogs.confirm({
        title: 'Discard the changes?',
        message: `${baseName(state.path)} has changes not saved.`,
        confirmLabel: 'Discard them',
        danger: true,
      }))
    ) {
      return;
    }
    setSelected(null);
    setTrail([]);
    dispatch({ type: 'open', path });
  };

  const add = (item: PaletteItem, at?: DropTarget | { parent: number; index: number }) => {
    if (!doc || !graph) {
      return;
    }
    const point = at ?? insertionPoint(graph, selectedIndex);
    if (!point) {
      notify('Select where it goes: a control node, or a node in one', 'error');
      return;
    }
    const node = newNode(item.model, format);
    edit(insertNode(doc, graph.nodes[point.parent].key, point.index, node), { select: node.key });
    if (narrow) {
      setPaletteOpen(false);
    }
  };

  const move = (key: number, target: DropTarget) => {
    if (!doc || !graph) {
      return;
    }
    const moved = moveNode(doc, key, graph.nodes[target.parent].key, target.index);
    if (moved) {
      edit(moved, { select: key });
    }
  };

  // Of the node selected, what can be done with it
  const node = graph && selectedIndex !== null && selectedIndex > 0 ? graph.nodes[selectedIndex] : null;
  const element = node && doc ? (locate(doc, node.key)?.node ?? null) : null;
  const parent = node && graph ? node.parent : -1;
  const siblings = graph && parent >= 0 ? graph.children[parent] : [];
  const position = node ? siblings.indexOf(selectedIndex!) : -1;
  const parentRoom = graph && parent >= 0 ? graph.nodes[parent].capacity > siblings.length : false;

  const remove = () => {
    if (doc && node && graph) {
      edit(removeNode(doc, node.key), { select: graph.nodes[parent].key });
    }
  };
  const copy = () => {
    if (doc && element) {
      clipboard = element;
      void navigator.clipboard?.writeText(nodeXml(doc, element)).catch(() => {});
    }
  };
  const paste = () => {
    if (!doc || !graph || !clipboard) {
      return;
    }
    const point = insertionPoint(graph, selectedIndex);
    if (!point) {
      notify('Select where it goes: a control node, or a node in one', 'error');
      return;
    }
    const pasted = cloneNode(clipboard);
    edit(insertNode(doc, graph.nodes[point.parent].key, point.index, pasted), { select: pasted.key });
  };
  const actions: NodeActions = {
    moveEarlier: node && position > 0 ? () => move(node.key, { parent, index: position - 1, mode: 'before', node: parent }) : null,
    moveLater:
      node && position >= 0 && position < siblings.length - 1 ? () => move(node.key, { parent, index: position + 2, mode: 'after', node: parent }) : null,
    duplicate:
      doc && element && parentRoom && graph
        ? () => {
            const copied = cloneNode(element);
            edit(insertNode(doc, graph.nodes[parent].key, position + 1, copied), { select: copied.key });
          }
        : null,
    wrap: node ? () => setPicker('wrap') : null,
    replace: node && node.kind !== 'subtree' ? () => setPicker('replace') : null,
    unwrap:
      doc && node && graph && canUnwrap(graph, selectedIndex!)
        ? () => edit(unwrapNode(doc, node.key), { select: graph.nodes[graph.children[selectedIndex!][0]].key })
        : null,
    remove,
  };

  // The tree of the ID: this file's, or its include's, opened
  const openTree = async (id: string) => {
    const found = trees.find((entry) => entry.id === id);
    if (found && tree) {
      setTrail((current) => [...current, tree.key]);
      setSelected(null);
      dispatch({ type: 'tree', key: found.key });
      return;
    }
    const file = catalog?.treeFiles.get(id);
    if (file) {
      await open(file);
    } else {
      notify(`No tree ${id}, in the file nor its includes`, 'error');
    }
  };

  const newTree = async () => {
    if (!doc) {
      return;
    }
    const id = await dialogs.prompt({ title: 'New tree', label: 'Its ID', initial: freeTreeId(doc, 'Subtree'), confirmLabel: 'Add' });
    if (!id) {
      return;
    }
    if (trees.some((entry) => entry.id === id)) {
      notify(`There is a tree ${id} already`, 'error');
      return;
    }
    const added = addTree(doc, id);
    setSelected(null);
    edit(added.document, { tree: added.key });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (target.closest('input, textarea, select, [role="dialog"]') || !doc) {
      return;
    }
    const run = (action: (() => void) | null | undefined) => {
      event.preventDefault();
      action?.();
    };
    if (mod && key === 'z') {
      run(() => dispatch({ type: event.shiftKey ? 'redo' : 'undo' }));
    } else if (mod && key === 'y') {
      run(() => dispatch({ type: 'redo' }));
    } else if (mod && key === 'c') {
      run(copy);
    } else if (mod && key === 'x') {
      run(node && (() => (copy(), remove())));
    } else if (mod && key === 'v') {
      run(paste);
    } else if (mod && key === 'd') {
      run(actions.duplicate);
    } else if ((key === 'delete' || key === 'backspace') && node) {
      run(remove);
    } else if (key === 'escape') {
      setSelected(null);
    } else if ((key === 'f2' || key === 'enter') && node) {
      run(() => rootRef.current?.querySelector<HTMLInputElement>('.bte-properties input')?.focus());
    } else if (key.startsWith('arrow') && graph) {
      const vertical = config.direction === 'vertical';
      const [up, down, back, next] = vertical ? ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'] : ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'];
      const current = selectedIndex ?? 0;
      if (event.altKey) {
        run(key === back ? actions.moveEarlier : key === next ? actions.moveLater : null);
        return;
      }
      let to: number | undefined;
      if (key === up) {
        to = graph.nodes[current].parent >= 0 ? graph.nodes[current].parent : undefined;
      } else if (key === down) {
        to = folded.has(graph.nodes[current].key) ? undefined : graph.children[current][0];
      } else if (current > 0) {
        const kin = graph.children[graph.nodes[current].parent];
        to = kin[kin.indexOf(current) + (key === back ? -1 : key === next ? 1 : 0)];
      }
      if (to !== undefined) {
        run(() => select(graph.nodes[to].key));
      }
    }
  };

  // Problems of the tree shown, in turn
  const problemNodes = graph ? graph.nodes.flatMap((graphNode, index) => (graphNode.problems.length > 0 ? [index] : [])) : [];
  const nextProblem = () => {
    if (graph && problemNodes.length > 0) {
      const after = problemNodes.find((index) => index > (selectedIndex ?? -1)) ?? problemNodes[0];
      select(graph.nodes[after].key);
    }
  };

  let content;
  if (!state.path) {
    content = (
      <div className="widget-message bte-empty">
        <p>No tree file: open one of the robot, or make a new one. Its file can be set in edit mode too.</p>
        <div>
          <button type="button" className="button" onClick={() => setDialog('open')}>
            Open…
          </button>{' '}
          <button type="button" className="button primary" onClick={() => setDialog('new')}>
            New…
          </button>
        </div>
      </div>
    );
  } else if (xmlView || (!doc && state.savedText !== null)) {
    content = (
      <XmlView
        text={doc ? documentText(doc) : (state.savedText ?? '')}
        readOnly={false}
        onDocument={(document) => edit(document, { tag: 'xml' })}
        onDone={() => dispatch({ type: 'seal' })}
      />
    );
  } else if (!doc) {
    content = <div className="widget-message">{state.error ?? 'Reading the tree…'}</div>;
  } else if (!graph) {
    content = (
      <div className="widget-message bte-empty">
        <p>No BehaviorTree in this file.</p>
        <button type="button" className="button primary" onClick={() => void newTree()}>
          Add a tree
        </button>
      </div>
    );
  } else {
    content = (
      <EditorGraph
        ref={graphRef}
        graph={graph}
        version={`${state.path}#${tree?.key}`}
        direction={config.direction}
        showPorts={showPorts}
        folded={folded}
        selected={selected}
        readOnly={false}
        focus={focus}
        fitRequest={fitRequest}
        covered={covered}
        onSelect={setSelected}
        onOpen={(key) => {
          const index = indices.get(key);
          const opened = index === undefined ? undefined : graph.nodes[index];
          if (opened?.kind === 'subtree' && opened.ports.ID) {
            void openTree(opened.ports.ID);
          } else if (opened && index! > 0) {
            rootRef.current?.querySelector<HTMLInputElement>('.bte-properties input')?.focus();
          }
        }}
        onFold={(key) =>
          setFolded((current) => {
            const next = new Set(current);
            if (!next.delete(key)) {
              next.add(key);
            }
            return next;
          })
        }
        onMove={move}
      />
    );
  }

  let panel = null;
  if (panelShown && doc && graph && catalog && selectedIndex !== null) {
    if (selectedIndex === 0 && tree) {
      panel = (
        <TreeProperties
          id={tree.id}
          isMain={main?.key === tree.key}
          trees={trees.filter((entry) => entry.key !== tree.key).map((entry) => entry.id)}
          problems={graph.nodes[0].problems}
          onRename={(id) => edit(renameTree(doc, tree.key, id))}
          onMain={() => edit(setMainTree(doc, tree.id))}
          onRemove={
            trees.length > 1
              ? () => {
                  setSelected(null);
                  edit(removeTree(doc, tree.key), { tree: trees.find((entry) => entry.key !== tree.key)!.key });
                }
              : null
          }
          onClose={() => setSelected(null)}
        />
      );
    } else if (node && element) {
      panel = (
        <NodeProperties
          key={node.key}
          node={node}
          element={element}
          catalog={catalog}
          format={format}
          actions={actions}
          onAttribute={(name, value, typed) => edit(setAttribute(doc, node.key, name, value), typed ? { tag: `${node.key}:${name}` } : {})}
          onRenameAttribute={(from, to) => edit(renameAttribute(doc, node.key, from, to))}
          onSeal={() => dispatch({ type: 'seal' })}
          onOpenTree={(id) => void openTree(id)}
          onClose={() => setSelected(null)}
        />
      );
    }
  }

  const banners: { text: string; tone: 'error' | 'warning'; actions?: { label: string; run: () => void; disabled?: boolean }[] }[] = [];
  if (state.error && (doc || state.savedText !== null)) {
    banners.push({ text: state.error, tone: 'error' });
  }
  if (state.external) {
    banners.push({
      text: state.external.text === null ? 'Not saved: the file changed on the robot since it was read' : 'The file changed on the robot, and this one has changes',
      tone: 'warning',
      actions: [
        { label: 'Load it', run: () => dispatch({ type: 'reload' }), disabled: state.external.text === null },
        { label: 'Keep mine', run: () => dispatch({ type: 'keep' }) },
      ],
    });
  }

  const status = !state.path
    ? { text: 'No file', tone: 'idle' }
    : saving
      ? { text: `Saving ${baseName(state.path)}…`, tone: 'running' }
      : dirty
        ? { text: `${baseName(state.path)} · changed`, tone: 'changed' }
        : state.readOnly && doc
          ? { text: `${baseName(state.path)} · read-only: ${state.readOnly}`, tone: 'idle' }
          : { text: doc ? `${baseName(state.path)} · saved` : baseName(state.path), tone: doc ? 'success' : 'idle' };

  return (
    <div ref={rootRef} className="bt bte" tabIndex={-1} onKeyDown={onKeyDown}>
      {banners.map((banner) => (
        <div key={banner.text} className={`bt-banner ${banner.tone} bte-banner`} title={banner.text}>
          <span>{banner.text}</span>
          {banner.actions?.map((action) => (
            <button
              key={action.label}
              type="button"
              className="link-button"
              disabled={action.disabled}
              onClick={() => {
                action.run();
                // The banner goes: the keys still the editor's
                rootRef.current?.focus({ preventScroll: true });
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ))}
      <div className="bte-toolbar" role="toolbar" aria-label="Editor">
        <button
          type="button"
          className="overlay-button"
          aria-pressed={showPalette}
          title="The nodes to add"
          aria-label="The nodes to add"
          disabled={!doc || xmlView}
          onClick={() => setPaletteOpen(!showPalette)}
        >
          <AppsIcon width={17} height={17} />
        </button>
        {trail.length > 0 && (
          <button
            type="button"
            className="overlay-button"
            title="Back to the tree it was opened from"
            aria-label="Back"
            onClick={() => {
              setSelected(null);
              dispatch({ type: 'tree', key: trail.at(-1)! });
              setTrail((current) => current.slice(0, -1));
            }}
          >
            <ArrowRightIcon width={17} height={17} style={{ transform: 'scaleX(-1)' }} />
          </button>
        )}
        <select
          className="bte-tree-select"
          aria-label="The tree shown"
          value={tree?.key ?? ''}
          disabled={trees.length === 0 || xmlView}
          onChange={(e) => {
            setSelected(null);
            setTrail([]);
            dispatch({ type: 'tree', key: Number(e.target.value) });
          }}
        >
          {trees.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.id || 'Unnamed tree'}
              {entry.key === main?.key ? ' (main)' : ''}
            </option>
          ))}
        </select>
        <button type="button" className="overlay-button" title="New tree" aria-label="New tree" disabled={!doc || xmlView} onClick={() => void newTree()}>
          <PlusIcon width={17} height={17} />
        </button>
        <span className="overlay-separator" />
        <button
          type="button"
          className="overlay-button"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          disabled={state.past.length === 0}
          onClick={() => dispatch({ type: 'undo' })}
        >
          <UndoIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          disabled={state.future.length === 0}
          onClick={() => dispatch({ type: 'redo' })}
        >
          <RedoIcon width={17} height={17} />
        </button>
        <span className="overlay-separator bte-wide" />
        <button
          type="button"
          className="overlay-button bte-wide"
          title="Fit the tree"
          aria-label="Fit the tree"
          disabled={!graph || xmlView}
          onClick={() => setFitRequest((n) => n + 1)}
        >
          <FitIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button bte-wide"
          aria-pressed={showPorts}
          title="The ports on the nodes"
          aria-label="The ports on the nodes"
          disabled={!graph || xmlView}
          onClick={() => setShowPorts((on) => !on)}
        >
          <SlidersIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button bte-wide"
          aria-pressed={xmlView}
          title="The XML"
          aria-label="The XML"
          disabled={!state.path || (!doc && state.savedText === null)}
          onClick={() => setXmlView((on) => !on)}
        >
          <CodeIcon width={17} height={17} />
        </button>
        <span className="bte-toolbar-end" />
        <button
          type="button"
          className={`button bte-save${dirty ? ' primary' : ''}`}
          disabled={!dirty || saving || state.readOnly !== null}
          title={state.readOnly ?? 'Save (Ctrl+S)'}
          onClick={() => void save()}
        >
          <SaveIcon width={16} height={16} />
          <span className="bte-save-label">Save</span>
        </button>
        <div className="menu">
          <button type="button" className="overlay-button" aria-label="File" title="File" aria-expanded={menuOpen} onClick={() => setMenuOpen((on) => !on)}>
            <MoreIcon width={17} height={17} />
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onPointerDown={() => setMenuOpen(false)} />
              <div className="menu-list" role="menu" onClick={() => setMenuOpen(false)}>
                {/* The toolbar's, when it has no room for them */}
                <button type="button" role="menuitem" className="bte-narrow" disabled={!graph || xmlView} onClick={() => setFitRequest((n) => n + 1)}>
                  Fit the tree
                </button>
                <button type="button" role="menuitem" className="bte-narrow" disabled={!graph || xmlView} onClick={() => setShowPorts((on) => !on)}>
                  {showPorts ? 'Hide the ports' : 'Show the ports'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="bte-narrow"
                  disabled={!state.path || (!doc && state.savedText === null)}
                  onClick={() => setXmlView((on) => !on)}
                >
                  {xmlView ? 'Back to the graph' : 'The XML'}
                </button>
                <button type="button" role="menuitem" onClick={() => setDialog('open')}>
                  Open…
                </button>
                <button type="button" role="menuitem" onClick={() => setDialog('new')}>
                  New file…
                </button>
                <button type="button" role="menuitem" disabled={!doc} onClick={() => setDialog('save-as')}>
                  Save as…
                </button>
                <button type="button" role="menuitem" disabled={!doc} onClick={() => doc && download(baseName(state.path) || 'tree.xml', documentText(doc))}>
                  Download
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!dirty}
                  onClick={async () => {
                    if (await dialogs.confirm({ title: 'Discard the changes?', message: 'The file is read again from the robot.', confirmLabel: 'Discard them', danger: true })) {
                      setSelected(null);
                      dispatch({ type: 'open', path: state.path });
                    }
                  }}
                >
                  Discard the changes
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className={`bte-body${narrow ? ' narrow' : ''}`}>
        {showPalette && (
          <NodePalette
            items={items}
            libraries={libraries.map((path) => ({ path, removable: extraLibraries.includes(path) && !lines(config.libraries).includes(path) }))}
            warnings={models?.warnings ?? []}
            onAdd={(item) => add(item)}
            onDrag={(item, at) => {
              setDragged({ item, at });
              graphRef.current?.dragNew(at);
            }}
            onDrop={(item, at) => {
              const target = at ? (graphRef.current?.dragNew(at) ?? null) : null;
              graphRef.current?.dragNew(null);
              setDragged(null);
              if (target) {
                add(item, target);
              }
            }}
            onLoadLibrary={() => setDialog('library')}
            onRemoveLibrary={(library) => {
              const next = extraLibraries.filter((entry) => entry !== library);
              setExtraLibraries(next);
              storeLibraries(sessionKey, next);
            }}
            onClose={() => setPaletteOpen(false)}
          />
        )}
        <div className="bt-main bte-canvas">
          {content}
          {panel}
        </div>
      </div>
      <div className={`bt-status ${status.tone}`} title={state.path || undefined}>
        <span className="bt-dot" aria-hidden="true" />
        <span className="bt-status-text">{status.text}</span>
        {problemNodes.length > 0 && !xmlView && (
          <button type="button" className="bte-problems-chip" onClick={nextProblem} title="Show the next">
            {problemNodes.length} {problemNodes.length === 1 ? 'problem' : 'problems'}
          </button>
        )}
      </div>
      {dragged && (
        <div className="bt-node bte-palette-ghost" style={{ left: dragged.at.x + 12, top: dragged.at.y + 8 }}>
          <div className="bt-node-head">
            <KindIcon node={{ kind: dragged.item.model.kind, type: dragged.item.model.id }} />
            <span className="bt-node-type">{dragged.item.model.id}</span>
          </div>
        </div>
      )}
      {picker && doc && node && element && catalog && (
        <NodePicker
          title={picker === 'wrap' ? `Wrap ${node.type} in` : `Replace ${node.type} with`}
          models={[...catalog.byId.values()]}
          kinds={picker === 'wrap' ? ['decorator', 'control'] : node.kind === 'control' || node.kind === 'decorator' ? [node.kind] : ['action', 'condition']}
          onPick={(model: BtNodeModel) => {
            setPicker(null);
            if (picker === 'wrap') {
              const wrapper = newNode(model, format);
              edit(wrapNode(doc, node.key, wrapper), { select: wrapper.key });
            } else {
              edit(replaceNode(doc, element.key, withType(element, model, format)), { select: element.key });
            }
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {(dialog === 'open' || dialog === 'library') && (
        <FileBrowser
          kind="behavior-tree"
          start={state.path.startsWith('/') || state.path.startsWith('~/') ? state.path : '~'}
          onChoose={(path) => {
            setDialog(null);
            if (dialog === 'open') {
              void open(path);
            } else if (!libraries.includes(path)) {
              const next = [...extraLibraries, path];
              setExtraLibraries(next);
              storeLibraries(sessionKey, next);
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog === 'new' || dialog === 'save-as') && (
        <FileDialog
          mode={dialog}
          initial={
            dialog === 'new'
              ? `${state.path.startsWith('/') || state.path.startsWith('~/') ? state.path.replace(/\/[^/]*$/, '') : '~'}/behavior_tree.xml`
              : state.path.startsWith('/') || state.path.startsWith('~/')
                ? state.path.replace(/(\.xml)?$/i, '_copy.xml')
                : `~/${baseName(state.path)}`
          }
          text={doc ? documentText(doc) : newTreeText(4)}
          onSaved={(path, text, version) => {
            setDialog(null);
            if (dialog === 'save-as') {
              dispatch({ type: 'saved', text, version, path });
              notify(`Saved as ${path}`);
            } else {
              void open(path);
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

export const behaviorTreeEditorWidget = defineWidget<BehaviorTreeEditorConfig>({
  type: 'behavior-tree-editor',
  name: 'Behavior Tree Editor',
  description: 'Edits a behavior tree’s XML file of the robot as a graph: nodes from palettes, ports, subtrees.',
  icon: TreeEditIcon,
  defaultSize: { w: 10, h: 7 },
  minSize: { w: 4, h: 4 },
  component: BehaviorTreeEditorWidget,
  properties: [
    {
      key: 'tree',
      label: 'Tree file',
      kind: 'behavior-tree',
      default: '',
      placeholder: '~/behavior_trees/main.xml',
      help: 'The XML file it opens (/…, ~/…, package://…): its toolbar opens others, and makes new ones. Uploads are saved as robot files',
    },
    {
      key: 'libraries',
      label: 'Node libraries',
      kind: 'text',
      default: '',
      placeholder: '~/my_robot/behavior_trees/my_nodes.xml\npackage://my_robot_bt/nodes.xml',
      help: 'XML files of TreeNodesModel (as Groot exports them), one a line: their nodes join the palette, besides BT.CPP’s, Nav2’s and the file’s',
    },
    {
      key: 'direction',
      label: 'Graph direction',
      kind: 'select',
      default: 'vertical',
      options: [
        { value: 'vertical', label: 'Top to bottom' },
        { value: 'horizontal', label: 'Left to right' },
      ],
    },
    {
      key: 'showPorts',
      label: 'Show the ports in the graph',
      kind: 'boolean',
      default: false,
      help: 'The toolbar switches them; the side panel edits them',
    },
  ],
});
