import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_KEYS, keySequence, NO_MODIFIERS, parseKeys, withModifiers, type Modifiers } from './keys.ts';

const mods = (...held: (keyof Modifiers)[]): Modifiers => ({
  ctrl: held.includes('ctrl'),
  alt: held.includes('alt'),
  shift: held.includes('shift'),
});

const key = (token: string) => parseKeys(token)[0][0];

test('the default layout is Termux’s, with what swiping up types', () => {
  const rows = parseKeys(DEFAULT_KEYS);
  assert.deepEqual(
    rows.map((row) => row.map((k) => k.label)),
    [
      ['Esc', '/', '-', 'Home', '↑', 'End', 'PgUp'],
      ['Tab', 'Ctrl', 'Alt', '←', '↓', '→', 'PgDn'],
    ],
  );
  assert.equal(rows[0][1].popup?.text, '\\');
  assert.equal(rows[0][2].popup?.text, '|');
  assert.equal(rows[0][3].popup?.text, '~');
  assert.equal(rows[1][1].modifier, 'ctrl');
  assert.equal(rows[0][4].repeat, true);
  assert.equal(rows[0][0].repeat, false);
});

test('layouts: names in any case, text typed as is, colons', () => {
  const [row] = parseKeys('esc ~ : ros2 F5 keyboard ::x a: |:~');
  assert.deepEqual(
    row.map((k) => [k.label, k.named ?? k.text ?? k.action, k.popup?.text]),
    [
      ['Esc', 'ESC', undefined],
      ['~', '~', undefined],
      [':', ':', undefined],
      ['ros2', 'ros2', undefined],
      ['F5', 'F5', undefined],
      ['⌨', 'keyboard', undefined],
      [':', ':', 'x'],
      ['a:', 'a:', undefined],
      ['|', '|', '~'],
    ],
  );
  // Modifiers are not swiped, nor swiped to
  assert.equal(key('CTRL:x').popup, null);
  assert.equal(key('x:ALT').popup, null);
  assert.deepEqual(parseKeys('  \n '), parseKeys(DEFAULT_KEYS));
});

test('cursor keys follow the application cursor mode, unless modified', () => {
  assert.equal(keySequence(key('UP'), NO_MODIFIERS, false), '\x1b[A');
  assert.equal(keySequence(key('UP'), NO_MODIFIERS, true), '\x1bOA');
  assert.equal(keySequence(key('HOME'), NO_MODIFIERS, true), '\x1bOH');
  assert.equal(keySequence(key('END'), NO_MODIFIERS, false), '\x1b[F');
  assert.equal(keySequence(key('LEFT'), mods('ctrl'), true), '\x1b[1;5D');
  assert.equal(keySequence(key('RIGHT'), mods('alt'), false), '\x1b[1;3C');
  assert.equal(keySequence(key('UP'), mods('shift'), false), '\x1b[1;2A');
  assert.equal(keySequence(key('DOWN'), mods('ctrl', 'shift'), false), '\x1b[1;6B');
});

test('editing and function keys, as xterm sends them', () => {
  assert.equal(keySequence(key('PGUP'), NO_MODIFIERS, false), '\x1b[5~');
  assert.equal(keySequence(key('PGDN'), mods('ctrl'), false), '\x1b[6;5~');
  assert.equal(keySequence(key('DEL'), NO_MODIFIERS, false), '\x1b[3~');
  assert.equal(keySequence(key('INS'), NO_MODIFIERS, false), '\x1b[2~');
  assert.equal(keySequence(key('F1'), NO_MODIFIERS, false), '\x1bOP');
  assert.equal(keySequence(key('F1'), mods('shift'), false), '\x1b[1;2P');
  assert.equal(keySequence(key('F5'), NO_MODIFIERS, false), '\x1b[15~');
  assert.equal(keySequence(key('F12'), mods('alt'), false), '\x1b[24;3~');
});

test('plain keys: Tab, Esc, Enter, Backspace, Space, with modifiers', () => {
  assert.equal(keySequence(key('TAB'), NO_MODIFIERS, false), '\t');
  assert.equal(keySequence(key('TAB'), mods('shift'), false), '\x1b[Z');
  assert.equal(keySequence(key('ESC'), NO_MODIFIERS, false), '\x1b');
  assert.equal(keySequence(key('ESC'), mods('alt'), false), '\x1b\x1b');
  assert.equal(keySequence(key('ENTER'), mods('alt'), false), '\x1b\r');
  assert.equal(keySequence(key('BKSP'), NO_MODIFIERS, false), '\x7f');
  assert.equal(keySequence(key('BKSP'), mods('ctrl'), false), '\x08');
  assert.equal(keySequence(key('SPACE'), mods('ctrl'), false), '\x00');
});

test('text keys, with Ctrl as control codes and Alt as ESC', () => {
  assert.equal(keySequence(key('~'), NO_MODIFIERS, false), '~');
  assert.equal(keySequence(key('c'), mods('ctrl'), false), '\x03');
  assert.equal(keySequence(key('/'), mods('ctrl'), false), '\x1f');
  assert.equal(keySequence(key('['), mods('ctrl'), false), '\x1b');
  assert.equal(keySequence(key('b'), mods('alt'), false), '\x1bb');
  assert.equal(keySequence(key('x'), mods('ctrl', 'alt'), false), '\x1b\x18');
  assert.equal(keySequence(key('ros2'), NO_MODIFIERS, false), 'ros2');
});

test('the keyboard’s input with the extra keys’ modifiers', () => {
  assert.equal(withModifiers('c', NO_MODIFIERS), null);
  assert.equal(withModifiers('c', mods('ctrl')), '\x03');
  assert.equal(withModifiers('D', mods('ctrl')), '\x04');
  assert.equal(withModifiers('a', mods('shift')), 'A');
  assert.equal(withModifiers('f', mods('alt')), '\x1bf');
  assert.equal(withModifiers('\x7f', mods('ctrl')), '\x08');
  // A word the keyboard gave at once: its first letter
  assert.equal(withModifiers('ls', mods('ctrl')), '\x0cs');
  assert.equal(withModifiers('😀x', mods('alt')), '\x1b😀x');
  // Its cursor keys
  assert.equal(withModifiers('\x1b[A', mods('ctrl')), '\x1b[1;5A');
  assert.equal(withModifiers('\x1bOD', mods('alt')), '\x1b[1;3D');
  assert.equal(withModifiers('\x1b[3~', mods('shift')), '\x1b[3;2~');
  // Not a paste, nor the terminal's answers
  assert.equal(withModifiers('\x1b[200~text\x1b[201~', mods('ctrl')), null);
  assert.equal(withModifiers('\x1b[12;5R', mods('ctrl')), null);
});
