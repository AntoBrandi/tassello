// What the logs widget knows of the ROS log: its messages, as the server sends
// them (src/server/rosout.ts), and the nodes running; what the page does with
// them: pause, clear, filter by node, level and text.

import { ROSOUT_HISTORY, type LogEntry, type RosoutUpdate } from '../../../shared/protocol.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// In order: as ROS prints them (tag), named, in a letter
export const LEVELS: { level: Level; tag: string; label: string; letter: string }[] = [
  { level: 'debug', tag: 'DEBUG', label: 'Debug', letter: 'D' },
  { level: 'info', tag: 'INFO', label: 'Info', letter: 'I' },
  { level: 'warn', tag: 'WARN', label: 'Warn', letter: 'W' },
  { level: 'error', tag: 'ERROR', label: 'Error', letter: 'E' },
  { level: 'fatal', tag: 'FATAL', label: 'Fatal', letter: 'F' },
];

// Of LEVELS, from rcl_interfaces/msg/Log's (DEBUG 10 ... FATAL 50): those
// in between as the one below, unset (0) as debug
export function levelIndex(value: number): number {
  return Math.min(LEVELS.length - 1, Math.max(0, Math.floor(value / 10) - 1));
}

// That level and those above
export function levelsFrom(lowest: Level): Set<Level> {
  const from = LEVELS.findIndex((entry) => entry.level === lowest);
  return new Set(LEVELS.slice(Math.max(0, from)).map((entry) => entry.level));
}

export interface Model {
  // The server answered
  received: boolean;
  // Of the server's log: another when it starts over
  started: number;
  // Oldest first, at most ROSOUT_HISTORY
  entries: LogEntry[];
  // Come while paused: shown once resumed
  pending: LogEntry[];
  paused: boolean;
  // Left out by the server, too many at once, since the last reset or clear
  skipped: number;
  // The nodes running, by their loggers' names: their full names
  running: ReadonlyMap<string, string>;
  // The messages up to seq are not shown again, of the log started then
  cleared: { started: number; seq: number } | null;
  // Another for every new log: what the list's position and selection follow
  version: number;
}

export const EMPTY: Model = {
  received: false,
  started: 0,
  entries: [],
  pending: [],
  paused: false,
  skipped: 0,
  running: new Map(),
  cleared: null,
  version: 0,
};

export type Action =
  | { type: 'reset' }
  | { type: 'update'; update: RosoutUpdate }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' };

// The logger of a node: robot1.amcl for /robot1/amcl
export function loggerName(node: string): string {
  return node.replace(/^\/+/, '').replaceAll('/', '.');
}

// The node of a logger, if running: its own (robot1.amcl), or that of its
// parent (robot1.amcl for robot1.amcl.costmap)
export function runningNode(name: string, running: ReadonlyMap<string, string>): string | null {
  for (let logger = name; logger; logger = logger.slice(0, Math.max(0, logger.lastIndexOf('.')))) {
    const node = running.get(logger);
    if (node) {
      return node;
    }
  }
  return null;
}

function keep(entries: LogEntry[]): LogEntry[] {
  return entries.length > ROSOUT_HISTORY ? entries.slice(-ROSOUT_HISTORY) : entries;
}

// The seq of the last message shown, or cleared
function lastShown(model: Model): number {
  return model.entries.at(-1)?.seq ?? model.cleared?.seq ?? 0;
}

export function reduce(model: Model, action: Action): Model {
  switch (action.type) {
    case 'reset':
      return { ...EMPTY, version: model.version + 1 };
    case 'update': {
      const { reset, started, entries, skipped, nodes } = action.update;
      const running = nodes ? new Map(nodes.map((node) => [loggerName(node), node])) : model.running;
      if (!reset) {
        return model.paused
          ? { ...model, running, pending: keep([...model.pending, ...entries]), skipped: model.skipped + skipped }
          : { ...model, running, entries: keep([...model.entries, ...entries]), skipped: model.skipped + skipped };
      }
      // The same log as the connection came back, or another one, whose
      // messages are numbered anew
      const same = model.received && started === model.started;
      const cleared = same ? model.cleared : null;
      const all = cleared ? entries.filter((entry) => entry.seq > cleared.seq) : entries;
      // Paused, what was shown stays so
      const shown = model.paused && same ? lastShown(model) : Infinity;
      return {
        ...model,
        received: true,
        started,
        running,
        cleared,
        entries: keep(all.filter((entry) => entry.seq <= shown)),
        pending: keep(all.filter((entry) => entry.seq > shown)),
        skipped: 0,
        version: same ? model.version : model.version + 1,
      };
    }
    case 'pause':
      return model.paused ? model : { ...model, paused: true };
    case 'resume':
      return { ...model, paused: false, entries: keep([...model.entries, ...model.pending]), pending: [] };
    case 'clear': {
      const seq = (model.pending.at(-1) ?? model.entries.at(-1))?.seq ?? model.cleared?.seq ?? 0;
      return { ...model, entries: [], pending: [], skipped: 0, cleared: { started: model.started, seq } };
    }
  }
}

// The index of the message seq in entries (in order), or of the first after
// it; entries.length if none
export function indexOfSeq(entries: LogEntry[], seq: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (entries[middle].seq < seq) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export interface TextMatch {
  // null: nothing to filter by
  test: ((text: string) => boolean) | null;
  // Why it is not a regular expression
  error: string | null;
}

// Of a text filter: any of its terms, separated by ;, or its regular
// expression, case aside
export function textMatch(text: string, regex: boolean): TextMatch {
  if (regex) {
    if (!text.trim()) {
      return { test: null, error: null };
    }
    try {
      const pattern = new RegExp(text, 'i');
      return { test: (message) => pattern.test(message), error: null };
    } catch (e) {
      return { test: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const terms = text
    .split(';')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) {
    return { test: null, error: null };
  }
  return {
    test: (message) => {
      const lower = message.toLowerCase();
      return terms.some((term) => lower.includes(term));
    },
    error: null,
  };
}

// The nodes a widget is for: names or globs (*), separated by ; , or spaces,
// as ROS names them (/robot1/amcl) or their loggers (robot1.amcl), each with
// its child loggers. null: all of them.
export function nodeScope(text: string): ((name: string) => boolean) | null {
  const patterns = text
    .split(/[;,\s]+/)
    .filter(Boolean)
    .map((term) => {
      const source = loggerName(term)
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${source}(\\..+)?$`);
    });
  return patterns.length > 0 ? (name) => patterns.some((pattern) => pattern.test(name)) : null;
}

export interface Filter {
  // The widget's nodes, null: all
  scope: ((name: string) => boolean) | null;
  // The loggers chosen in the list of nodes, none: all
  nodes: ReadonlySet<string>;
  levels: ReadonlySet<Level>;
  include: ((text: string) => boolean) | null;
  exclude: ((text: string) => boolean) | null;
}

export interface NodeInfo {
  // Its logger's
  name: string;
  // Its full name if running, else null
  node: string | null;
  // Its messages kept, by level (of LEVELS)
  counts: number[];
  total: number;
}

export interface LogView {
  // Oldest first
  shown: LogEntry[];
  // By level: the messages of the nodes chosen that the text filters let
  // through, which the level would show
  levels: number[];
  // The messages of the widget's nodes
  total: number;
  // Those that logged, and those running that did not, by name
  nodes: NodeInfo[];
}

export function filterLog(entries: LogEntry[], running: ReadonlyMap<string, string>, filter: Filter): LogView {
  const inScope = new Map<string, boolean>();
  const fits = (name: string) => {
    let fit = inScope.get(name);
    if (fit === undefined) {
      fit = !filter.scope || filter.scope(name);
      inScope.set(name, fit);
    }
    return fit;
  };
  const nodes = new Map<string, NodeInfo>();
  const nodeInfo = (name: string) => {
    let info = nodes.get(name);
    if (!info) {
      info = { name, node: runningNode(name, running), counts: LEVELS.map(() => 0), total: 0 };
      nodes.set(name, info);
    }
    return info;
  };
  const levels = LEVELS.map(() => 0);
  const shown: LogEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!fits(entry.name)) {
      continue;
    }
    total++;
    const level = levelIndex(entry.level);
    const info = nodeInfo(entry.name);
    info.counts[level]++;
    info.total++;
    if (
      (filter.nodes.size > 0 && !filter.nodes.has(entry.name)) ||
      (filter.include && !filter.include(entry.msg)) ||
      filter.exclude?.(entry.msg)
    ) {
      continue;
    }
    levels[level]++;
    if (filter.levels.has(LEVELS[level].level)) {
      shown.push(entry);
    }
  }
  // Those chosen stay listed, to be unchosen
  for (const name of [...running.keys(), ...filter.nodes]) {
    if (fits(name)) {
      nodeInfo(name);
    }
  }
  return { shown, levels, total, nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export type TimeFormat = 'clock' | 'stamp' | 'none';

// Stamps before 2001 are of sim time: seconds since the simulation started
const SIM_TIME_BEFORE = Date.UTC(2001, 0, 1);

// 1729435407.512346: seconds, as ROS prints its stamps
export function stampTime(stamp: number): string {
  return (stamp / 1000).toFixed(6);
}

// 14:03:27.512 in the page's time zone, 123.456 on sim time
export function clockTime(stamp: number): string {
  if (stamp < SIM_TIME_BEFORE) {
    return (stamp / 1000).toFixed(3);
  }
  const date = new Date(stamp);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// As ROS prints it: [WARN] [1729435407.512346] [robot1.amcl]: Setting pose
export function logLine(entry: LogEntry): string {
  return `[${LEVELS[levelIndex(entry.level)].tag}] [${stampTime(entry.stamp)}] [${entry.name}]: ${entry.msg}`;
}

// 987, 1.2k, 12k
export function shortCount(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  return count < 10_000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(count / 1000)}k`;
}
