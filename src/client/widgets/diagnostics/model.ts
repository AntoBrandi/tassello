// What the diagnostics widget knows of the robot's diagnostics: the statuses,
// as the server sends them (src/server/diagnostics.ts), and their changes of
// level; what the page does with them: pause, forget the stale ones, arrange
// them in a tree of their names, and filter them by level and text.

import {
  DIAGNOSTICS_CHANGES,
  type DiagnosticChange,
  type DiagnosticEntry,
  type DiagnosticsUpdate,
} from '../../../shared/protocol.ts';

export type Level = 'ok' | 'warn' | 'error' | 'stale';

// As the toolbar has them: named, as ROS prints them (tag)
export const LEVELS: { level: Level; label: string; tag: string }[] = [
  { level: 'ok', label: 'OK', tag: 'OK' },
  { level: 'warn', label: 'Warn', tag: 'WARN' },
  { level: 'error', label: 'Error', tag: 'ERROR' },
  { level: 'stale', label: 'Stale', tag: 'STALE' },
];

// How bad each is: what a group shows of those under it. Stale is worse than a
// warning (nothing is known of it), not than an error.
const SEVERITY: Record<Level, number> = { ok: 0, warn: 1, stale: 2, error: 3 };

export function levelInfo(level: Level) {
  return LEVELS.find((info) => info.level === level)!;
}

// Of diagnostic_msgs/msg/DiagnosticStatus's (OK 0, WARN 1, ERROR 2, STALE 3),
// any other as an error
export function levelOf(value: number): Level {
  switch (value) {
    case 0:
      return 'ok';
    case 1:
      return 'warn';
    case 3:
      return 'stale';
    default:
      return 'error';
  }
}

// What a status is at: stale once no longer received, else as published
export function statusLevel(entry: DiagnosticEntry): Level {
  return entry.stale ? 'stale' : levelOf(entry.level);
}

// That level and those worse
export function levelsFrom(lowest: Level): Set<Level> {
  return new Set(LEVELS.filter(({ level }) => SEVERITY[level] >= SEVERITY[lowest]).map(({ level }) => level));
}

function worse(a: Level | null, b: Level | null): Level | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

interface Diagnostics {
  // By id
  statuses: ReadonlyMap<number, DiagnosticEntry>;
  // Oldest first, at most DIAGNOSTICS_CHANGES
  changes: DiagnosticChange[];
}

export interface Model extends Diagnostics {
  // The server answered
  received: boolean;
  // Of the server's diagnostics: others when it starts over
  started: number;
  // Paused, what is shown: the diagnostics as they were, while they keep coming
  frozen: Diagnostics | null;
  // Statuses no longer published, not to show, by id, with since when they
  // are stale: shown again once published again
  forgotten: ReadonlyMap<number, number>;
  // Another for other diagnostics: what the selection follows
  version: number;
}

export const EMPTY: Model = {
  received: false,
  started: 0,
  statuses: new Map(),
  changes: [],
  frozen: null,
  forgotten: new Map(),
  version: 0,
};

export type Action =
  | { type: 'reset' }
  | { type: 'update'; update: DiagnosticsUpdate }
  | { type: 'pause' }
  | { type: 'resume' }
  // Those of these statuses no longer published
  | { type: 'forget'; ids: number[] };

function keep(changes: DiagnosticChange[]): DiagnosticChange[] {
  return changes.length > DIAGNOSTICS_CHANGES ? changes.slice(-DIAGNOSTICS_CHANGES) : changes;
}

// What the widget shows: as it was when paused
export function displayed(model: Model): Diagnostics {
  return model.frozen ?? model;
}

export function isForgotten(forgotten: Model['forgotten'], entry: DiagnosticEntry): boolean {
  return forgotten.get(entry.id) === entry.since;
}

export function reduce(model: Model, action: Action): Model {
  switch (action.type) {
    case 'reset':
      return { ...EMPTY, version: model.version + 1 };
    case 'update': {
      const { reset, started, statuses, changes } = action.update;
      if (!reset) {
        const next = new Map(model.statuses);
        for (const entry of statuses) {
          next.set(entry.id, entry);
        }
        return { ...model, statuses: next, changes: keep([...model.changes, ...changes]) };
      }
      // The same diagnostics as the connection came back, or others, whose
      // statuses are numbered anew
      const same = model.received && started === model.started;
      const live = { statuses: new Map(statuses.map((entry) => [entry.id, entry])), changes: keep(changes) };
      return {
        ...model,
        ...live,
        received: true,
        started,
        // Paused, others show as they are now
        frozen: model.frozen && !same ? live : model.frozen,
        forgotten: same ? model.forgotten : new Map(),
        version: same ? model.version : model.version + 1,
      };
    }
    case 'pause':
      return model.frozen ? model : { ...model, frozen: { statuses: model.statuses, changes: model.changes } };
    case 'resume':
      return { ...model, frozen: null };
    case 'forget': {
      const { statuses } = displayed(model);
      const next = new Map(model.forgotten);
      for (const id of action.ids) {
        const entry = statuses.get(id);
        if (entry?.stale) {
          next.set(id, entry.since);
        }
      }
      return { ...model, forgotten: next };
    }
  }
}

// Where a status goes in the tree. A path of the aggregator's
// (/Robot/Sensors/Lidar), its groups ending with ': ' at times; or, as
// diagnostic_updater names them, its node then its task (amcl: Localization),
// the task whole, slashes and all (hokuyo_node: /scan topic status).
export function statusPath(name: string): string[] {
  const path = name.startsWith('/')
    ? name.split('/').map((segment) => segment.replace(/:\s*$/, '').trim())
    : splitTask(name);
  const named = path.filter(Boolean);
  return named.length > 0 ? named : [name.trim() || '(no name)'];
}

function splitTask(name: string): string[] {
  const colon = name.indexOf(': ');
  return colon > 0 ? [name.slice(0, colon).trim(), name.slice(colon + 2).trim()] : [name.trim()];
}

// The statuses a widget is for: names, paths or globs (*), separated by , or
// ;, each with those under it. From the root if they start with /, else at
// any depth: Sensors is /Robot/Sensors too. Case aside. null: all of them.
export function statusScope(text: string): ((path: string[]) => boolean) | null {
  const patterns = text
    .split(/[,;]/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => {
      const segments = term.includes('/') ? term.split('/').filter(Boolean) : splitTask(term);
      return {
        rooted: term.startsWith('/'),
        globs: segments.map((segment) => {
          const source = segment
            .split('*')
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*');
          return new RegExp(`^${source}$`, 'i');
        }),
      };
    })
    .filter(({ globs }) => globs.length > 0);
  if (patterns.length === 0) {
    return null;
  }
  return (path) =>
    patterns.some(({ rooted, globs }) => {
      const last = rooted ? 0 : path.length - globs.length;
      for (let start = 0; start <= last; start++) {
        if (globs.every((glob, i) => start + i < path.length && glob.test(path[start + i]))) {
          return true;
        }
      }
      return false;
    });
}

export interface DiagnosticNode {
  // Of its path, its labels each after a newline: unique
  key: string;
  label: string;
  // Its own status (an aggregator's group has one), or none: a group of
  // those under it (a node's tasks, or a path's)
  entry: DiagnosticEntry | null;
  // Sorted by label
  children: DiagnosticNode[];
  // Its own level, null without a status. A group the aggregator puts in
  // error because some of those under it are stale, none in error, is stale.
  own: Level | null;
  // The worst of its own and of those under it
  worst: Level;
  // A status the counts count: of a leaf, or a group's that those under it do
  // not account for (in error, those under it only warn)
  counted: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// The tree of the statuses' paths, its roots sorted, and its nodes by key
export function buildTree(entries: Iterable<DiagnosticEntry>): {
  roots: DiagnosticNode[];
  nodes: Map<string, DiagnosticNode>;
} {
  const roots: DiagnosticNode[] = [];
  const nodes = new Map<string, DiagnosticNode>();
  const child = (parent: DiagnosticNode | null, key: string, label: string) => {
    let node = nodes.get(key);
    if (!node) {
      node = { key, label, entry: null, children: [], own: null, worst: 'ok', counted: false };
      nodes.set(key, node);
      (parent?.children ?? roots).push(node);
    }
    return node;
  };
  for (const entry of entries) {
    const path = statusPath(entry.name);
    let parent: DiagnosticNode | null = null;
    let key = '';
    for (const label of path.slice(0, -1)) {
      key += `\n${label}`;
      parent = child(parent, key, label);
    }
    const label = path[path.length - 1];
    let node = child(parent, `${key}\n${label}`, label);
    // Of the same path as another (/a/b and a: b): beside it
    if (node.entry) {
      node = child(parent, `${key}\n${label}#${entry.id}`, label);
    }
    node.entry = entry;
  }
  const settle = (node: DiagnosticNode) => {
    node.children.sort((a, b) => collator.compare(a.label, b.label));
    let below: Level | null = null;
    for (const c of node.children) {
      settle(c);
      below = worse(below, c.worst);
    }
    let own = node.entry ? statusLevel(node.entry) : null;
    if (own === 'error' && below === 'stale') {
      own = 'stale';
    }
    node.own = own;
    node.worst = worse(own, below) ?? 'ok';
    node.counted = own !== null && (below === null || SEVERITY[own] > SEVERITY[below]);
  };
  roots.sort((a, b) => collator.compare(a.label, b.label));
  roots.forEach(settle);
  return { roots, nodes };
}

export interface Filter {
  // The widget's statuses, null: all
  scope: ((path: string[]) => boolean) | null;
  levels: ReadonlySet<Level>;
  text: ((text: string) => boolean) | null;
}

// Which groups are unfolded: those chosen, else all, or (auto) those with
// problems under them and those alone at their depth
export interface Folding {
  mode: 'auto' | 'all';
  chosen: ReadonlyMap<string, boolean>;
}

export const AUTO_FOLDING: Folding = { mode: 'auto', chosen: new Map() };

// The groups unfolded for their problems, kept unfolded once these are gone:
// the rows do not move under the pointer as a status comes and goes. The same
// folding if none.
export function keepUnfolded(view: DiagnosticsView, folding: Folding): Folding {
  if (folding.mode !== 'auto' || view.filtering) {
    return folding;
  }
  const opened = view.rows.filter(
    ({ node, open }) => open && node.worst !== 'ok' && !folding.chosen.has(node.key),
  );
  if (opened.length === 0) {
    return folding;
  }
  const chosen = new Map(folding.chosen);
  for (const { node } of opened) {
    chosen.set(node.key, true);
  }
  return { ...folding, chosen };
}

export type Counts = Record<Level, number>;

export function noCounts(): Counts {
  return { ok: 0, warn: 0, error: 0, stale: 0 };
}

export interface TreeRow {
  node: DiagnosticNode;
  depth: number;
  // Its children unfolded or folded; null: none
  open: boolean | null;
  // Shown for those under it, not itself matching the filters
  dim: boolean;
  // Those counted under it (and itself) that the text lets through
  counts: Counts;
}

export interface DiagnosticsView {
  // The tree's, as unfolded
  rows: TreeRow[];
  // The list's: the statuses counted that the filters let through, the worst
  // first
  list: DiagnosticNode[];
  // By level: the statuses counted that the text lets through, which the
  // level would show
  counts: Counts;
  // By level, and in all: the statuses counted, whatever the filters
  totals: Counts;
  total: number;
  // Those the filters let through
  matching: number;
  // The worst of them all, null if none
  worst: Level | null;
  // Every node by key, and the key of each status (by id): for the selection
  nodes: ReadonlyMap<string, DiagnosticNode>;
  keys: ReadonlyMap<number, string>;
  // Filtered by text or level
  filtering: boolean;
}

function textOf(node: DiagnosticNode, test: (text: string) => boolean): boolean {
  const { entry } = node;
  return entry ? test(entry.name) || test(entry.message) || test(entry.hardwareId) : test(node.label);
}

export function viewDiagnostics(entries: Iterable<DiagnosticEntry>, filter: Filter, folding: Folding): DiagnosticsView {
  const scoped: DiagnosticEntry[] = [];
  for (const entry of entries) {
    if (!filter.scope || filter.scope(statusPath(entry.name))) {
      scoped.push(entry);
    }
  }
  const { roots, nodes } = buildTree(scoped);
  const filtering = filter.text !== null || LEVELS.some(({ level }) => !filter.levels.has(level));
  // What the filters let through, by node: itself, and what under it
  const passes = new Set<DiagnosticNode>();
  const visible = new Set<DiagnosticNode>();
  const counts = new Map<DiagnosticNode, Counts>();
  const totals = noCounts();
  const mark = (node: DiagnosticNode, textPassed: boolean): Counts => {
    // A group whose name matches comes with all of those under it
    const text = textPassed || !filter.text || textOf(node, filter.text);
    const under = noCounts();
    let seen = false;
    for (const c of node.children) {
      const below = mark(c, text);
      for (const { level } of LEVELS) {
        under[level] += below[level];
      }
      seen ||= visible.has(c);
    }
    if (node.counted) {
      totals[node.own!]++;
    }
    if (node.counted && text) {
      under[node.own!]++;
      if (filter.levels.has(node.own!)) {
        passes.add(node);
        seen = true;
      }
    }
    if (seen) {
      visible.add(node);
    }
    counts.set(node, under);
    return under;
  };
  const matched = noCounts();
  let worst: Level | null = null;
  for (const root of roots) {
    const below = mark(root, false);
    for (const { level } of LEVELS) {
      matched[level] += below[level];
    }
    worst = worse(worst, root.worst);
  }

  const unfolded = (node: DiagnosticNode, alone: boolean) =>
    folding.chosen.get(node.key) ?? (filtering || folding.mode === 'all' || node.worst !== 'ok' || alone);
  const rows: TreeRow[] = [];
  const walk = (siblings: DiagnosticNode[], depth: number) => {
    for (const node of siblings) {
      if (!visible.has(node)) {
        continue;
      }
      const open = node.children.length > 0 ? unfolded(node, siblings.length === 1) : null;
      rows.push({ node, depth, open, dim: filtering && !passes.has(node), counts: counts.get(node)! });
      if (open) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(roots, 0);

  const list = [...passes].sort(
    (a, b) => SEVERITY[b.own!] - SEVERITY[a.own!] || collator.compare(a.entry!.name, b.entry!.name),
  );
  const keys = new Map<number, string>();
  for (const node of nodes.values()) {
    if (node.entry) {
      keys.set(node.entry.id, node.key);
    }
  }
  return {
    rows,
    list,
    counts: matched,
    totals,
    total: LEVELS.reduce((sum, { level }) => sum + totals[level], 0),
    matching: passes.size,
    worst,
    nodes,
    keys,
    filtering,
  };
}

// The changes of the statuses the filters let through, the latest first
export function filterChanges(
  changes: DiagnosticChange[],
  statuses: ReadonlyMap<number, DiagnosticEntry>,
  filter: Filter,
): DiagnosticChange[] {
  const scoped = new Map<number, boolean>();
  const inScope = (entry: DiagnosticEntry) => {
    let fit = scoped.get(entry.id);
    if (fit === undefined) {
      fit = !filter.scope || filter.scope(statusPath(entry.name));
      scoped.set(entry.id, fit);
    }
    return fit;
  };
  const shown: DiagnosticChange[] = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    const entry = statuses.get(change.status);
    if (
      entry &&
      inScope(entry) &&
      filter.levels.has(levelOf(change.level)) &&
      (!filter.text || filter.text(entry.name) || filter.text(change.message))
    ) {
      shown.push(change);
    }
  }
  return shown;
}

// The messages of the aggregator's groups that only name their level
const LEVEL_MESSAGE = /^(ok|warn(ing)?|error|stale|all stale)$/i;

// What a row says of its status: a group's message only if it says more than
// its level
export function rowMessage(node: DiagnosticNode): string {
  const message = node.entry?.message.trim() ?? '';
  return node.children.length > 0 && LEVEL_MESSAGE.test(message) ? '' : message;
}

// 14:03:27, or 14:03:27.512, in the page's time zone
export function clockTime(ms: number, millis = false): string {
  const date = new Date(ms);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return millis ? `${time}.${pad(date.getMilliseconds(), 3)}` : time;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s} s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ${s % 60} s`;
  }
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// [ERROR] /Sensors/Lidar: No scan, with its hardware id and values below;
// [STALE (WARN)] if stale, with the level it was last published at
export function statusText(entry: DiagnosticEntry): string {
  const level = statusLevel(entry);
  let tag = levelInfo(level).tag;
  if (level === 'stale' && levelOf(entry.level) !== 'stale') {
    tag += ` (${levelInfo(levelOf(entry.level)).tag})`;
  }
  const lines = [`[${tag}] ${entry.name}${entry.message ? `: ${entry.message}` : ''}`];
  if (entry.hardwareId) {
    lines.push(`    hardware_id: ${entry.hardwareId}`);
  }
  for (const { key, value } of entry.values) {
    lines.push(`    ${key}: ${value}`);
  }
  return lines.join('\n');
}

// [14:03:27.512] [ERROR] /Sensors/Lidar: No scan
export function changeLine(change: DiagnosticChange, entry: DiagnosticEntry | undefined): string {
  const tag = levelInfo(levelOf(change.level)).tag;
  const message = change.message ? `: ${change.message}` : '';
  return `[${clockTime(change.time, true)}] [${tag}] ${entry?.name ?? '?'}${message}`;
}
