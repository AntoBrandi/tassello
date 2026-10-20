import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyChange,
  detectEol,
  detectIndent,
  diffText,
  EMPTY_HISTORY,
  findMatches,
  indentLines,
  lineAt,
  lineStarts,
  newLine,
  recordStep,
  redo,
  replaceAll,
  replacementAt,
  toggleComment,
  undo,
  type EditKind,
  type History,
} from './text_edit.ts';

const PLAIN = { caseSensitive: false, regex: false, wholeWord: false };

test('changes are what differs, the common start and end aside', () => {
  assert.equal(diffText('abc', 'abc'), null);
  assert.deepEqual(diffText('speed: 1', 'speed: 12'), { from: 8, removed: '', inserted: '2' });
  assert.deepEqual(diffText('aaa', 'aa'), { from: 2, removed: 'a', inserted: '' });
  assert.deepEqual(diffText('one two', 'one 2', 4), { from: 4, removed: 'two', inserted: '2' });
  // A wrong hint is not trusted
  assert.deepEqual(diffText('xbc', 'ybc', 2), { from: 0, removed: 'x', inserted: 'y' });
  const change = diffText('hello world', 'hello brave world')!;
  assert.equal(applyChange('hello world', change), 'hello brave world');
});

// Edits a text as typed, recording each: returns the text and the history
function typeInto(text: string, edits: [string, EditKind, number][]): { text: string; history: History } {
  let history = EMPTY_HISTORY;
  for (const [next, kind, time] of edits) {
    const change = diffText(text, next)!;
    const after = change.from + change.inserted.length;
    history = recordStep(history, { change, before: { start: change.from, end: change.from + change.removed.length }, after: { start: after, end: after } }, kind, time);
    text = next;
  }
  return { text, history };
}

test('typing is undone a word at a time, deleting at once, other edits alone', () => {
  const { text, history } = typeInto('', [
    ['h', 'type', 0],
    ['hi', 'type', 100],
    ['hi ', 'type', 200],
    ['hi y', 'type', 300],
    ['hi yo', 'type', 400],
    // A pause
    ['hi you', 'type', 5000],
    ['hi yo', 'delete', 5100],
    ['hi y', 'delete', 5200],
    ['HI y', 'other', 5300],
  ]);
  assert.equal(text, 'HI y');
  assert.equal(history.past.length, 5);
  const steps: string[] = [];
  let current = { text, history };
  for (;;) {
    const done = undo(current.text, current.history);
    if (!done) {
      break;
    }
    steps.push(done.text);
    current = done;
  }
  assert.deepEqual(steps, ['hi y', 'hi you', 'hi yo', 'hi', '']);
  const again = redo(current.text, current.history)!;
  assert.equal(again.text, 'hi');
  assert.deepEqual(again.selection, { start: 2, end: 2 });
  // An edit after an undo: no redo left
  const edited = typeInto('hi', [['hi!', 'other', 0]]);
  assert.equal(recordStep(again.history, edited.history.past[0], 'other', 0).future.length, 0);
});

test('lines, line ends and indentation', () => {
  const starts = lineStarts('a\nbc\n\nd');
  assert.deepEqual(starts, [0, 2, 5, 6]);
  assert.equal(lineAt(starts, 0), 0);
  assert.equal(lineAt(starts, 4), 1);
  assert.equal(lineAt(starts, 5), 2);
  assert.equal(lineAt(starts, 99), 3);
  assert.equal(detectEol('a\r\nb\r\nc'), '\r\n');
  assert.equal(detectEol('a\nb\r\nc\nd'), '\n');
  assert.equal(detectIndent('a:\n  b:\n    c: 1\n  d: 2\n'), 2);
  assert.equal(detectIndent('def f():\n    if x:\n        return 1\n'), 4);
  assert.equal(detectIndent('a {\n\tb;\n\t\tc;\n}\n'), 'tab');
  assert.equal(detectIndent('flat\ntext\n', 4), 4);
  assert.equal(newLine('  key:\n    value', 12), '\n    ');
  assert.equal(newLine('\tx', 2), '\n\t');
});

test('lines are indented and outdented, the selection kept on them', () => {
  const text = 'a:\n  b: 1\n\nc: 2';
  const indented = indentLines(text, { start: 0, end: text.length }, 2, false);
  assert.equal(indented.text, '  a:\n    b: 1\n\n  c: 2');
  assert.deepEqual(indented.selection, { start: 2, end: indented.text.length });
  const outdented = indentLines(indented.text, indented.selection, 2, true);
  assert.equal(outdented.text, text);
  // A selection ending at a line's start leaves that line out
  assert.equal(indentLines('x\ny\n', { start: 0, end: 2 }, 'tab', false).text, '\tx\ny\n');
});

test('lines are commented out at their least indentation, and back', () => {
  const text = '  a: 1\n    b: 2\n';
  const commented = toggleComment(text, { start: 0, end: 14 }, '#');
  assert.equal(commented.text, '  # a: 1\n  #   b: 2\n');
  assert.equal(toggleComment(commented.text, commented.selection, '#').text, text);
  assert.equal(toggleComment('x();', { start: 2, end: 2 }, '//').text, '// x();');
});

test('search: plain, whole words, regular expressions; replace one or all', () => {
  const text = 'max_vel: 0.5\nmin_vel: -0.5\nvel: 1';
  assert.deepEqual(findMatches(text, 'VEL', PLAIN).matches, [
    [4, 7],
    [17, 20],
    [27, 30],
  ]);
  assert.deepEqual(findMatches(text, 'vel', { ...PLAIN, wholeWord: true }).matches, [[27, 30]]);
  assert.deepEqual(findMatches(text, 'VEL', { ...PLAIN, caseSensitive: true }).matches, []);
  assert.deepEqual(findMatches(text, '^\\w+', { ...PLAIN, regex: true }).matches.length, 3);
  assert.match(findMatches(text, '(', { ...PLAIN, regex: true }).error ?? '', /Invalid|Unterminated/);
  // Empty matches left out
  assert.deepEqual(findMatches('ab', 'x*', { ...PLAIN, regex: true }).matches, []);

  const regex = { ...PLAIN, regex: true };
  assert.equal(replacementAt(text, 0, '(\\w+)_vel', 'vel_$1', regex), 'vel_max');
  assert.equal(replacementAt(text, 1, '(\\w+)_vel', 'vel_$1', regex), 'vel_ax');
  assert.equal(replacementAt(text, 5, 'vel', 'x', PLAIN), null);
  assert.deepEqual(replaceAll(text, '(\\w+)_vel', '$1_speed', regex), {
    text: 'max_speed: 0.5\nmin_speed: -0.5\nvel: 1',
    count: 2,
  });
  // Plain: a $ is a $
  assert.equal(replaceAll('a.b', '.', '$&', PLAIN).text, 'a$&b');
  // Lookaheads see past the match
  assert.equal(replaceAll('a1 b2 c', '[a-z](?=\\d)', '#', regex).text, '#1 #2 c');
});
