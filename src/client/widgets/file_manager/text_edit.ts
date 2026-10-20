// The editor's text: its changes, undone and redone (typing undone a word at
// a time, as gedit does), its lines, its indentation and line ends, indenting
// and commenting lines out, searching and replacing.

export interface Selection {
  start: number;
  end: number;
}

// At from, removed replaced by inserted
export interface Change {
  from: number;
  removed: string;
  inserted: string;
}

export interface Step {
  change: Change;
  // The selection before and after
  before: Selection;
  after: Selection;
}

// Typing goes on the step before, as do deletions with Backspace or Delete
export type EditKind = 'type' | 'delete' | 'other';

export interface History {
  past: Step[];
  future: Step[];
  // The last step's: what continues it
  last: { kind: EditKind; time: number } | null;
}

export const EMPTY_HISTORY: History = { past: [], future: [], last: null };

// Undone at most; and of the text the steps hold, in characters
const MAX_STEPS = 1000;
const MAX_HISTORY_CHARS = 20_000_000;
// Typing pauses this long: another step
const GROUP_MS = 1500;

// What changed, from the text before to the text after: the common start
// and end aside. hint: where the change is known to start, at the earliest.
export function diffText(previous: string, next: string, hint = 0): Change | null {
  if (previous === next) {
    return null;
  }
  let start = 0;
  if (hint > 0 && hint <= Math.min(previous.length, next.length) && previous.slice(0, hint) === next.slice(0, hint)) {
    start = hint;
  }
  const shortest = Math.min(previous.length, next.length);
  while (start < shortest && previous.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }
  let end = 0;
  while (
    end < shortest - start &&
    previous.charCodeAt(previous.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  return { from: start, removed: previous.slice(start, previous.length - end), inserted: next.slice(start, next.length - end) };
}

export function applyChange(text: string, { from, removed, inserted }: Change): string {
  return text.slice(0, from) + inserted + text.slice(from + removed.length);
}

function inverse({ from, removed, inserted }: Change): Change {
  return { from, removed: inserted, inserted: removed };
}

function isSpace(text: string): boolean {
  return /^\s+$/.test(text);
}

// The step the edit makes with the one before, if it goes on it
function merged(last: Step, step: Step, kind: EditKind): Step | null {
  const a = last.change;
  const b = step.change;
  if (kind === 'type' && b.removed === '' && !b.inserted.includes('\n') && b.from === a.from + a.inserted.length) {
    // A word at a time: a space after a word starts another
    if (isSpace(b.inserted) && a.inserted && !isSpace(a.inserted.slice(-1))) {
      return null;
    }
    return { change: { from: a.from, removed: a.removed, inserted: a.inserted + b.inserted }, before: last.before, after: step.after };
  }
  if (kind === 'delete' && a.inserted === '' && b.inserted === '' && !b.removed.includes('\n')) {
    // Backspace, then Delete
    if (b.from + b.removed.length === a.from) {
      return { change: { from: b.from, removed: b.removed + a.removed, inserted: '' }, before: last.before, after: step.after };
    }
    if (b.from === a.from) {
      return { change: { from: a.from, removed: a.removed + b.removed, inserted: '' }, before: last.before, after: step.after };
    }
  }
  return null;
}

export function recordStep(history: History, step: Step, kind: EditKind, time: number): History {
  const last = history.past[history.past.length - 1];
  const joined =
    last && history.last && history.last.kind === kind && kind !== 'other' && time - history.last.time < GROUP_MS
      ? merged(last, step, kind)
      : null;
  const past = joined ? [...history.past.slice(0, -1), joined] : [...history.past, step];
  // The oldest go first
  let chars = 0;
  let keep = past.length;
  while (keep > 0 && past.length - keep < MAX_STEPS) {
    const { change } = past[keep - 1];
    chars += change.removed.length + change.inserted.length;
    if (chars > MAX_HISTORY_CHARS) {
      break;
    }
    keep--;
  }
  return { past: past.slice(keep), future: [], last: { kind, time } };
}

export function undo(text: string, history: History): { text: string; history: History; selection: Selection } | null {
  const step = history.past[history.past.length - 1];
  if (!step) {
    return null;
  }
  return {
    text: applyChange(text, inverse(step.change)),
    history: { past: history.past.slice(0, -1), future: [...history.future, step], last: null },
    selection: step.before,
  };
}

export function redo(text: string, history: History): { text: string; history: History; selection: Selection } | null {
  const step = history.future[history.future.length - 1];
  if (!step) {
    return null;
  }
  return {
    text: applyChange(text, step.change),
    history: { past: [...history.past, step], future: history.future.slice(0, -1), last: null },
    selection: step.after,
  };
}

// The offsets where the lines start
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

// The line of an offset, from 0
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export type Eol = '\n' | '\r\n';

// The line ends the text has most: Windows' or the others'
export function detectEol(text: string): Eol {
  const lines = (text.match(/\n/g) ?? []).length;
  const windows = (text.match(/\r\n/g) ?? []).length;
  return windows > 0 && windows * 2 >= lines ? '\r\n' : '\n';
}

// A tab, or that many spaces
export type Indent = 'tab' | 2 | 3 | 4 | 8;

export function indentText(indent: Indent): string {
  return indent === 'tab' ? '\t' : ' '.repeat(indent);
}

// As the file is indented: with tabs, or by the step its spaces take most
export function detectIndent(text: string, fallback: Indent = 2): Indent {
  let tabs = 0;
  let spaced = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of text.split('\n', 10_000)) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith('\t')) {
      tabs++;
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width > 0) {
      spaced++;
    }
    const step = Math.abs(width - previous);
    if (step > 0 && step <= 8) {
      steps.set(step, (steps.get(step) ?? 0) + 1);
    }
    previous = width;
  }
  if (tabs > spaced) {
    return 'tab';
  }
  let best: Indent = fallback;
  let count = 0;
  for (const size of [2, 4, 8, 3] as const) {
    if ((steps.get(size) ?? 0) > count) {
      best = size;
      count = steps.get(size)!;
    }
  }
  return spaced > 0 ? best : fallback;
}

export interface Edit {
  text: string;
  selection: Selection;
}

// The lines the selection touches: the offsets of their start and end
function selectedLines(text: string, { start, end }: Selection): { from: number; to: number } {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  // A selection ending at a line's start leaves that line out
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const next = text.indexOf('\n', last);
  return { from, to: next < 0 ? text.length : next };
}

// Indents the lines of the selection (outdent: the other way), keeping them
// selected
export function indentLines(text: string, selection: Selection, indent: Indent, outdent: boolean): Edit {
  const { from, to } = selectedLines(text, selection);
  const unit = indentText(indent);
  const width = unit === '\t' ? 1 : unit.length;
  const lines = text.slice(from, to).split('\n');
  let shiftStart = 0;
  let shift = 0;
  const changed = lines.map((line, index) => {
    let delta: number;
    let result: string;
    if (outdent) {
      const leading = /^(\t| {1,8})/.exec(line)?.[0] ?? '';
      const removed = leading === '\t' ? 1 : Math.min(leading.length, width);
      result = line.slice(removed);
      delta = -removed;
    } else if (line.length === 0 && lines.length > 1) {
      result = line;
      delta = 0;
    } else {
      result = unit + line;
      delta = unit.length;
    }
    if (index === 0) {
      shiftStart = delta;
    }
    shift += delta;
    return result;
  });
  const next = text.slice(0, from) + changed.join('\n') + text.slice(to);
  const start = Math.max(from, selection.start + shiftStart);
  return { text: next, selection: { start, end: Math.max(start, selection.end + shift) } };
}

// Comments the selection's lines out with the token (#, //), at their least
// indentation, or uncomments them if they all are
export function toggleComment(text: string, selection: Selection, token: string): Edit {
  const { from, to } = selectedLines(text, selection);
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((line) => line.trim());
  const commented = filled.length > 0 && filled.every((line) => line.trimStart().startsWith(token));
  const column = Math.min(...filled.map((line) => line.length - line.trimStart().length));
  let shiftStart = 0;
  let shift = 0;
  const changed = lines.map((line, index) => {
    let result = line;
    if (commented) {
      const at = line.indexOf(token);
      if (at >= 0) {
        const length = token.length + (line[at + token.length] === ' ' ? 1 : 0);
        result = line.slice(0, at) + line.slice(at + length);
      }
    } else if (line.trim()) {
      result = `${line.slice(0, column)}${token} ${line.slice(column)}`;
    }
    if (index === 0) {
      shiftStart = result.length - line.length;
    }
    shift += result.length - line.length;
    return result;
  });
  const next = text.slice(0, from) + changed.join('\n') + text.slice(to);
  const start = Math.max(from, selection.start + shiftStart);
  return { text: next, selection: { start, end: Math.max(start, selection.end + shift) } };
}

// A new line at the offset: indented as the line it breaks
export function newLine(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const indentation = /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? '';
  return `\n${indentation}`;
}

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

// Found at most: the editor shows them all
export const MAX_MATCHES = 10_000;

function searchExpression(query: string, options: SearchOptions): RegExp {
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  return new RegExp(source, `g${options.caseSensitive ? '' : 'i'}m`);
}

// Where the query is: [start, end) each, empty matches of regular
// expressions left out
export function findMatches(
  text: string,
  query: string,
  options: SearchOptions,
): { matches: [number, number][]; error: string | null; capped: boolean } {
  if (!query) {
    return { matches: [], error: null, capped: false };
  }
  let expression: RegExp;
  try {
    expression = searchExpression(query, options);
  } catch (e) {
    return { matches: [], error: e instanceof Error ? e.message : String(e), capped: false };
  }
  const matches: [number, number][] = [];
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    if (match[0].length === 0) {
      expression.lastIndex++;
      continue;
    }
    matches.push([match.index, match.index + match[0].length]);
    if (matches.length >= MAX_MATCHES) {
      return { matches, error: null, capped: true };
    }
  }
  return { matches, error: null, capped: false };
}

// $$, $&, $1…$99 and $<name>, as String.prototype.replace expands them
function expand(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (whole: string, what: string, name?: string) => {
    if (what === '$') {
      return '$';
    }
    if (what === '&') {
      return match[0];
    }
    if (name !== undefined) {
      return match.groups?.[name] ?? '';
    }
    const index = Number(what);
    if (index >= 1 && index < match.length) {
      return match[index] ?? '';
    }
    // $12 of fewer groups: $1, then 2
    const first = Number(what[0]);
    if (what.length === 2 && first >= 1 && first < match.length) {
      return (match[first] ?? '') + what[1];
    }
    return whole;
  });
}

// What replaces the match at start: the replacement, with the $1 and $& of a
// regular expression expanded; null if the query is not found there
export function replacementAt(
  text: string,
  start: number,
  query: string,
  replacement: string,
  options: SearchOptions,
): string | null {
  const expression = searchExpression(query, options);
  expression.lastIndex = start;
  const match = expression.exec(text);
  if (!match || match.index !== start || match[0].length === 0) {
    return null;
  }
  return options.regex ? expand(replacement, match) : replacement;
}

export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  options: SearchOptions,
): { text: string; count: number } {
  if (!query) {
    return { text, count: 0 };
  }
  const expression = searchExpression(query, options);
  let result = '';
  let last = 0;
  let count = 0;
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    if (match[0].length === 0) {
      expression.lastIndex++;
      continue;
    }
    result += text.slice(last, match.index) + (options.regex ? expand(replacement, match) : replacement);
    last = match.index + match[0].length;
    count++;
  }
  return { text: result + text.slice(last), count };
}
