// The terminal's extra keys, those phones lack, as Termux has them above the
// on-screen keyboard: what a layout of them names, and what each sends to the
// terminal, as xterm does for the keys of a keyboard. Ctrl, Alt and Shift
// apply to the next key, of the extra keys or of the keyboard.

export type Modifier = 'ctrl' | 'alt' | 'shift';
export type Modifiers = Record<Modifier, boolean>;
export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false, shift: false };

// Termux's, with what swiping up types: \ | and ~
export const DEFAULT_KEYS = 'ESC /:\\ -:| HOME:~ UP END PGUP\nTAB CTRL ALT LEFT DOWN RIGHT PGDN';

export interface ExtraKey {
  label: string;
  // What it is, for screen readers and tooltips
  title: string;
  // A modifier, a named key, an action of the widget or what it types
  modifier?: Modifier;
  named?: string;
  action?: 'keyboard' | 'paste';
  text?: string;
  // Sent again and again while held
  repeat: boolean;
  // Swiped up (or held): another key
  popup: ExtraKey | null;
}

// A key's escape sequence: CSI, then the modifiers' parameter if any, then
// its final; the cursor keys are SS3 (ESC O) in application mode, as Home and
// End
interface Named {
  label: string;
  title: string;
  repeat?: boolean;
  // Typed as is, Alt prefixing it with ESC
  plain?: string;
  // CSI <code> ~, CSI <code> ; <modifiers> ~
  tilde?: number;
  // CSI <final>, SS3 <final> in application cursor mode (cursor) or always (ss3)
  final?: string;
  cursor?: boolean;
  ss3?: boolean;
}

const NAMED: Record<string, Named> = {
  ESC: { label: 'Esc', title: 'Escape', plain: '\x1b' },
  TAB: { label: 'Tab', title: 'Tab', plain: '\t' },
  ENTER: { label: '⏎', title: 'Enter', plain: '\r' },
  BKSP: { label: '⌫', title: 'Backspace', plain: '\x7f', repeat: true },
  SPACE: { label: '␣', title: 'Space', plain: ' ' },
  INS: { label: 'Ins', title: 'Insert', tilde: 2 },
  DEL: { label: 'Del', title: 'Delete', tilde: 3, repeat: true },
  PGUP: { label: 'PgUp', title: 'Page up', tilde: 5, repeat: true },
  PGDN: { label: 'PgDn', title: 'Page down', tilde: 6, repeat: true },
  HOME: { label: 'Home', title: 'Home', final: 'H', cursor: true },
  END: { label: 'End', title: 'End', final: 'F', cursor: true },
  UP: { label: '↑', title: 'Up', final: 'A', cursor: true, repeat: true },
  DOWN: { label: '↓', title: 'Down', final: 'B', cursor: true, repeat: true },
  RIGHT: { label: '→', title: 'Right', final: 'C', cursor: true, repeat: true },
  LEFT: { label: '←', title: 'Left', final: 'D', cursor: true, repeat: true },
  F1: { label: 'F1', title: 'F1', final: 'P', ss3: true },
  F2: { label: 'F2', title: 'F2', final: 'Q', ss3: true },
  F3: { label: 'F3', title: 'F3', final: 'R', ss3: true },
  F4: { label: 'F4', title: 'F4', final: 'S', ss3: true },
  F5: { label: 'F5', title: 'F5', tilde: 15 },
  F6: { label: 'F6', title: 'F6', tilde: 17 },
  F7: { label: 'F7', title: 'F7', tilde: 18 },
  F8: { label: 'F8', title: 'F8', tilde: 19 },
  F9: { label: 'F9', title: 'F9', tilde: 20 },
  F10: { label: 'F10', title: 'F10', tilde: 21 },
  F11: { label: 'F11', title: 'F11', tilde: 23 },
  F12: { label: 'F12', title: 'F12', tilde: 24 },
};

const MODIFIERS: Record<string, { modifier: Modifier; label: string; title: string }> = {
  CTRL: { modifier: 'ctrl', label: 'Ctrl', title: 'Control: applies to the next key' },
  ALT: { modifier: 'alt', label: 'Alt', title: 'Alt: applies to the next key' },
  SHIFT: { modifier: 'shift', label: 'Shift', title: 'Shift: applies to the next key' },
};

const ACTIONS: Record<string, { action: 'keyboard' | 'paste'; label: string; title: string }> = {
  KEYBOARD: { action: 'keyboard', label: '⌨', title: 'Show or hide the keyboard' },
  PASTE: { action: 'paste', label: 'Paste', title: 'Paste' },
};

// One key of a layout, without its popup: a name, or what it types
function keyOf(token: string): ExtraKey {
  const name = token.toUpperCase();
  if (MODIFIERS[name]) {
    const { modifier, label, title } = MODIFIERS[name];
    return { label, title, modifier, repeat: false, popup: null };
  }
  if (ACTIONS[name]) {
    const { action, label, title } = ACTIONS[name];
    return { label, title, action, repeat: false, popup: null };
  }
  if (NAMED[name]) {
    const { label, title, repeat = false } = NAMED[name];
    return { label, title, named: name, repeat, popup: null };
  }
  return { label: token, title: token, text: token, repeat: false, popup: null };
}

// A layout: a line per row, keys separated by spaces. A key is one of the
// names above, or what it types; what swiping up on it gives follows a colon
// (-:|), unless the colon is the key (: alone). Empty: the default.
export function parseKeys(layout: string): ExtraKey[][] {
  const rows = layout
    .split('\n')
    .map((line) =>
      line
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => {
          const colon = token.indexOf(':', 1);
          if (colon < 0 || colon === token.length - 1) {
            return keyOf(token);
          }
          const key = keyOf(token.slice(0, colon));
          const popup = keyOf(token.slice(colon + 1));
          // Modifiers toggle: not swiped
          return key.modifier || popup.modifier ? key : { ...key, popup };
        }),
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? rows : parseKeys(DEFAULT_KEYS);
}

// xterm's modifier parameter: 1 + Shift 1, Alt 2, Ctrl 4
function modifierCode({ ctrl, alt, shift }: Modifiers): number {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

function anyModifier(modifiers: Modifiers): boolean {
  return modifiers.ctrl || modifiers.alt || modifiers.shift;
}

// A character with Ctrl: the C0 control codes, as xterm sends them
function controlOf(char: string): string | null {
  if (char.length !== 1) {
    return null;
  }
  const code = char.charCodeAt(0);
  if (char === '\x7f') {
    // Backspace
    return '\x08';
  }
  if ((code >= 0x40 && code <= 0x5f) || (code >= 0x61 && code <= 0x7a)) {
    // @ A-Z [ \ ] ^ _ and a-z
    return String.fromCharCode(code & 0x1f);
  }
  const special: Record<string, number> = {
    ' ': 0x00,
    '2': 0x00,
    '3': 0x1b,
    '4': 0x1c,
    '5': 0x1d,
    '6': 0x1e,
    '7': 0x1f,
    '/': 0x1f,
    '-': 0x1f,
    '8': 0x7f,
    '?': 0x7f,
  };
  return char in special ? String.fromCharCode(special[char]) : null;
}

// What typing text sends with the modifiers: they apply to its first
// character, Shift to letters only (the keyboard has the others), Alt
// prefixing ESC
function typed(text: string, modifiers: Modifiers): string {
  const [first = ''] = text;
  const rest = text.slice(first.length);
  let key = first;
  if (modifiers.shift) {
    key = key.toUpperCase();
  }
  if (modifiers.ctrl) {
    key = controlOf(key) ?? key;
  }
  if (modifiers.alt) {
    key = `\x1b${key}`;
  }
  return key + rest;
}

// What an extra key sends: application cursor mode is the terminal's
// (DECCKM), set by full screen programs (vim, htop, less)
export function keySequence(key: ExtraKey, modifiers: Modifiers, applicationCursor: boolean): string {
  if (key.text !== undefined) {
    return typed(key.text, modifiers);
  }
  const named = key.named ? NAMED[key.named] : undefined;
  if (!named) {
    return '';
  }
  const code = modifierCode(modifiers);
  if (named.plain !== undefined) {
    // Shift+Tab: back tab
    if (named.plain === '\t' && modifiers.shift) {
      return modifiers.alt ? '\x1b\x1b[Z' : '\x1b[Z';
    }
    return typed(named.plain, modifiers);
  }
  if (named.tilde !== undefined) {
    return code > 1 ? `\x1b[${named.tilde};${code}~` : `\x1b[${named.tilde}~`;
  }
  if (code > 1) {
    return `\x1b[1;${code}${named.final}`;
  }
  return named.ss3 || (named.cursor && applicationCursor) ? `\x1bO${named.final}` : `\x1b[${named.final}`;
}

// What the terminal's input becomes with modifiers held on the extra keys:
// typed text, or the keyboard's own cursor and editing keys; null for what
// they do not apply to (a paste, the terminal's answers to the program), which
// does not use them up
export function withModifiers(data: string, modifiers: Modifiers): string | null {
  if (!anyModifier(modifiers) || !data) {
    return null;
  }
  if (!data.startsWith('\x1b')) {
    return typed(data, modifiers);
  }
  const code = modifierCode(modifiers);
  const cursor = /^\x1b[[O]([A-DHFPQRS])$/.exec(data);
  if (cursor) {
    return `\x1b[1;${code}${cursor[1]}`;
  }
  const tilde = /^\x1b\[(\d+)~$/.exec(data);
  if (tilde) {
    return `\x1b[${tilde[1]};${code}~`;
  }
  return null;
}
