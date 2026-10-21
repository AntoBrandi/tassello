// The terminal widget's view: xterm.js, on a terminal of the robot (see
// src/server/terminals.ts) that outlives the page: reloaded, reconnected, or
// shown again after another panel, it shows what it was showing.
//
// On touch screens, the extra keys (ExtraKeys.tsx) are under it, and while
// typing it fills the screen above the on-screen keyboard, the keys right
// above it, as Termux does. Pinching changes the size of the text, as the
// toolbar does, for this device.

import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { TERMINAL_SCROLLBACK, type StreamStatus } from '../../../shared/protocol.ts';
import { connection, useConnectionStatus } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import {
  ClipboardIcon,
  KeyboardIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
  TextLargerIcon,
  TextSmallerIcon,
} from '../../icons.tsx';
import { ExtraKeys, type ModifierState } from './ExtraKeys.tsx';
import { keySequence, parseKeys, withModifiers, type ExtraKey, type Modifier, type Modifiers } from './keys.ts';
import type { TerminalConfig } from './TerminalWidget.tsx';

const FONT_SIZES = { min: 7, max: 32 };
// The on-screen keyboard is open when it takes this much of the window
const KEYBOARD_MIN_PX = 120;
// Tapped twice within this: a modifier stays
const DOUBLE_TAP_MS = 350;
// The terminal's size goes to the robot at most this often while it changes
const RESIZE_MS = 100;
// Written between the output of a program and another's: the normal screen
// (not ?1049l, which would put the cursor back where it was saved last), the
// modes the old program set reset, its screen scrolled into the scrollback,
// and a line to say so
function newSession(rows: number): string {
  const modes = '\x1b[?47l\x1b[!p\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l';
  return `${modes}\x1b[999;1H${'\n'.repeat(rows)}\x1b[H\x1b[2m── new session ──\x1b[0m\r\n`;
}
// ESC c: a full reset, in turn with the output before it
const RESET = '\x1bc';

const DARK: ITheme = {
  background: '#0b0e14',
  foreground: '#d5dae3',
  cursor: '#4f8cff',
  cursorAccent: '#0b0e14',
  selectionBackground: 'rgba(79, 140, 255, 0.35)',
  black: '#1c212b',
  red: '#f0676b',
  green: '#4fc98a',
  yellow: '#e8b94f',
  blue: '#5b9bff',
  magenta: '#c57ff0',
  cyan: '#4cc3d6',
  white: '#c9d0db',
  brightBlack: '#5d6879',
  brightRed: '#ff8a8d',
  brightGreen: '#79e0a8',
  brightYellow: '#f5d27a',
  brightBlue: '#8bb8ff',
  brightMagenta: '#dba6f7',
  brightCyan: '#7fdced',
  brightWhite: '#f2f4f8',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f2733',
  cursor: '#2f6fed',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(47, 111, 237, 0.25)',
  black: '#1f2733',
  red: '#c92a2a',
  green: '#2b8a3e',
  yellow: '#9c6500',
  blue: '#1f5ad6',
  magenta: '#9327c4',
  cyan: '#0c7c8c',
  white: '#8b95a7',
  brightBlack: '#5d6879',
  brightRed: '#e03131',
  brightGreen: '#37b24d',
  brightYellow: '#b57900',
  brightBlue: '#2f6fed',
  brightMagenta: '#ae3ec9',
  brightCyan: '#1098ad',
  brightWhite: '#c3cad5',
};

// The name of the widget's terminal on the robot: kept for as long as the
// browser's tab, so that the tab finds its terminal again after a reload
function terminalName(panelId: string, widgetId: string): string {
  const key = `tassello.terminal:${panelId}/${widgetId}`;
  try {
    const known = sessionStorage.getItem(key);
    if (known && /^[\w-]{1,64}$/.test(known)) {
      return known;
    }
  } catch {
    // Storage disabled: a terminal per page
  }
  // Not crypto.randomUUID: for secure pages only, and the dashboard is mostly
  // served over http
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const name = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(key, name);
  } catch {
    // As above
  }
  return name;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
  );
}

// The part of the page in sight, which the on-screen keyboard shrinks, while
// active; null otherwise, or if the browser cannot tell
function useVisualViewport(active: boolean) {
  const [rect, setRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    keyboard: boolean;
  } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setRect(null);
      return;
    }
    const update = () =>
      setRect({
        top: viewport.offsetTop,
        left: viewport.offsetLeft,
        width: viewport.width,
        height: viewport.height,
        keyboard: window.innerHeight - viewport.height * viewport.scale > KEYBOARD_MIN_PX,
      });
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [active]);
  return rect;
}

// The size of the text on this device, from the widget's until changed here
function useFontSize(panelId: string, widgetId: string, base: number) {
  const key = `tassello.terminal.fontSize:${panelId}/${widgetId}`;
  const read = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { base: number; size: number } | null;
      return saved?.base === base ? saved.size : base;
    } catch {
      return base;
    }
  };
  const [size, setSize] = useState(read);
  useEffect(() => setSize(read()), [key, base]);
  const change = useCallback(
    (next: number) => {
      const clamped = Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, Math.round(next)));
      setSize(clamped);
      try {
        localStorage.setItem(key, JSON.stringify({ base, size: clamped }));
      } catch {
        // Not kept
      }
    },
    [key, base],
  );
  return [size, change] as const;
}

// navigator.clipboard is for secure pages only (https, localhost)
function canReadClipboard(): boolean {
  return window.isSecureContext && typeof navigator.clipboard?.readText === 'function';
}

function PasteDialog({ onPaste, onClose }: { onPaste: (text: string, enter: boolean) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [enter, setEnter] = useState(false);
  return (
    <Modal title="Paste into the terminal" onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          onPaste(text, enter);
        }}
      >
        <textarea
          autoFocus
          value={text}
          rows={5}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Paste or type here"
          onChange={(event) => setText(event.target.value)}
        />
        <label className="toggle">
          <input type="checkbox" checked={enter} onChange={(event) => setEnter(event.target.checked)} />
          <span className="toggle-switch" aria-hidden="true" />
          <span className="field-label">Then press Enter</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!text}>
            Paste
          </button>
        </div>
      </form>
    </Modal>
  );
}

type ModifierStates = Record<Modifier, ModifierState>;

const NO_STATES: ModifierStates = { ctrl: 'off', alt: 'off', shift: 'off' };

function held(states: ModifierStates): Modifiers {
  return { ctrl: states.ctrl !== 'off', alt: states.alt !== 'off', shift: states.shift !== 'off' };
}

export default function TerminalView({
  config,
  panelId,
  widgetId,
  editing,
}: {
  config: TerminalConfig;
  panelId: string;
  widgetId: string;
  editing: boolean;
}) {
  const name = useMemo(() => terminalName(panelId, widgetId), [panelId, widgetId]);
  const screenRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The subscription's id, while subscribed
  const idRef = useRef<number | null>(null);
  // The output shown: its program, and how far it goes
  const shownRef = useRef<{ started: number | null; offset: number | null }>({ started: null, offset: null });
  // Restarted from here: the new program's output on a clean screen
  const restartingRef = useRef(false);
  const exitedRef = useRef(false);
  // Sent by the extra keys: as they are
  const bypassRef = useRef(false);
  const [status, setStatus] = useState<{ state: StreamStatus['state']; message: string }>({
    state: 'waiting',
    message: '',
  });
  // undefined while the program runs
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [modifiers, setModifiers] = useState(NO_STATES);
  const modifiersRef = useRef(modifiers);
  const lastTap = useRef<Record<Modifier, number>>({ ctrl: 0, alt: 0, shift: 0 });
  const [fontSize, setFontSize] = useFontSize(panelId, widgetId, config.fontSize);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pasting, setPasting] = useState(false);
  const connected = useConnectionStatus() === 'open';
  const touch = useMediaQuery('(pointer: coarse)');
  const light = useMediaQuery('(prefers-color-scheme: light)');
  const theme = config.theme === 'light' || (config.theme === 'auto' && light) ? LIGHT : DARK;
  const rows = useMemo(() => parseKeys(config.keys), [config.keys]);
  const showKeys = config.extraKeys === 'always' || (config.extraKeys === 'touch' && touch);
  const typing = touch && focused && config.fullScreenTyping && !editing;
  const viewport = useVisualViewport(maximized || typing);
  const filled = maximized || (typing && viewport?.keyboard === true);

  const updateModifiers = useCallback((change: (states: ModifierStates) => ModifierStates) => {
    const next = change(modifiersRef.current);
    if (next !== modifiersRef.current) {
      modifiersRef.current = next;
      setModifiers(next);
    }
  }, []);

  // A key typed: those held once are let go
  const releaseModifiers = useCallback(
    () =>
      updateModifiers((states) => {
        if (!Object.values(states).includes('once')) {
          return states;
        }
        const release = (state: ModifierState): ModifierState => (state === 'once' ? 'off' : state);
        return { ctrl: release(states.ctrl), alt: release(states.alt), shift: release(states.shift) };
      }),
    [updateModifiers],
  );

  const restart = useCallback(() => {
    if (idRef.current !== null && connection.restartTerminal(idRef.current)) {
      restartingRef.current = true;
    }
  }, []);

  const send = useCallback(
    (data: string) => {
      if (idRef.current === null) {
        return;
      }
      if (exitedRef.current) {
        // Enter starts it again
        if (data === '\r') {
          restart();
        }
        return;
      }
      connection.terminalInput(idRef.current, data);
    },
    [restart],
  );

  // The terminal, for the widget's life
  useEffect(() => {
    const fit = new FitAddon();
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
      fontSize,
      scrollback: TERMINAL_SCROLLBACK,
      cursorBlink: true,
      theme,
      macOptionIsMeta: true,
      allowProposedApi: true,
    });
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(screenRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (bypassRef.current) {
        send(data);
        return;
      }
      const modified = withModifiers(data, held(modifiersRef.current));
      if (modified !== null) {
        releaseModifiers();
      }
      send(modified ?? data);
    });
    term.onTitleChange(setTitle);
    // Copy: Ctrl+C with text selected (else it interrupts), Ctrl+Shift+C;
    // paste: Ctrl+Shift+V, the browser's. Ctrl+V stays the shell's.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) {
        return true;
      }
      const key = event.key.toLowerCase();
      if (key === 'c' && (event.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) {
          // The terminal puts its selection in the copy
          document.execCommand('copy');
          term.clearSelection();
        }
        event.preventDefault();
        return false;
      }
      return !(key === 'v' && event.shiftKey);
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    term.onResize(() => {
      resizeTimer ??= setTimeout(() => {
        resizeTimer = null;
        if (idRef.current !== null) {
          connection.resizeTerminal(idRef.current, term.cols, term.rows);
        }
      }, RESIZE_MS);
    });
    const textarea = term.textarea;
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    textarea?.addEventListener('focus', onFocus);
    textarea?.addEventListener('blur', onBlur);

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (screenRef.current?.clientWidth && screenRef.current.clientHeight) {
          fit.fit();
        }
      });
    });
    observer.observe(screenRef.current!);
    fit.fit();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      textarea?.removeEventListener('focus', onFocus);
      textarea?.removeEventListener('blur', onBlur);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Its options change below
  }, []);

  // The robot's terminal: opened again when the widget's command or folder
  // change, which restarts it
  useEffect(() => {
    const term = termRef.current!;
    setStatus({ state: 'waiting', message: '' });
    const { id, unsubscribe } = connection.subscribeTerminal(
      { terminal: name, command: config.command.trim(), folder: config.folder.trim() || '~' },
      {
        status: (state, message) => setStatus({ state, message }),
        output: (output) => {
          const shown = shownRef.current;
          let data = output.data;
          if (output.reset) {
            data = RESET + data;
          } else if (output.started !== shown.started && shown.started !== null) {
            data = (restartingRef.current ? RESET : newSession(term.rows)) + data;
          }
          if (output.started !== shown.started) {
            restartingRef.current = false;
            exitedRef.current = false;
            setExitCode(undefined);
            setTitle('');
          }
          if (output.title !== null) {
            setTitle(output.title);
          }
          shownRef.current = { started: output.started, offset: output.offset };
          term.write(data, () => connection.ackTerminal(id, output.started, output.offset));
        },
        exit: (exit) => {
          if (exit.started === shownRef.current.started) {
            exitedRef.current = true;
            setExitCode(exit.exitCode);
          }
        },
        shown: () => ({ cols: term.cols, rows: term.rows, ...shownRef.current }),
      },
    );
    idRef.current = id;
    return () => {
      idRef.current = null;
      unsubscribe();
    };
  }, [name, config.command, config.folder]);

  useEffect(() => {
    const term = termRef.current!;
    term.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    const term = termRef.current!;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  // Edit mode: shown, not typed in
  useEffect(() => {
    const term = termRef.current!;
    term.options.disableStdin = editing;
    if (editing) {
      term.blur();
    }
  }, [editing]);

  // Touching the screen: one finger scrolls, as a mouse's wheel does (the
  // scrollback, or the program's own scrolling: less, htop), flung or not;
  // two pinch the size of the text
  useEffect(() => {
    const screen = screenRef.current!;
    let touching:
      | { kind: 'scroll'; x: number; y: number; moves: { dy: number; time: number }[] }
      | { kind: 'pinch'; distance: number; size: number }
      | null = null;
    let fling = 0;
    // Scrolled by less than a line, so far
    let partial = 0;
    const distance = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const scroll = (dy: number, x: number, y: number) => {
      const term = termRef.current;
      const rows = term?.element?.querySelector('.xterm-screen');
      if (!term || !rows) {
        return;
      }
      if (term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none') {
        // The scrollback
        const cell = rows.clientHeight / term.rows;
        partial += dy;
        const lines = Math.trunc(partial / cell);
        if (lines) {
          term.scrollLines(lines);
          partial -= lines * cell;
        }
      } else {
        // The program's: a mouse's wheel, which the terminal turns into its
        // arrow keys or mouse reports
        const init = { deltaY: dy, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: x, clientY: y };
        rows.dispatchEvent(new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true }));
      }
    };
    const start = (event: TouchEvent) => {
      cancelAnimationFrame(fling);
      partial = 0;
      if (event.touches.length === 1) {
        touching = { kind: 'scroll', x: event.touches[0].clientX, y: event.touches[0].clientY, moves: [] };
      } else if (event.touches.length === 2) {
        const size = termRef.current!.options.fontSize ?? config.fontSize;
        touching = { kind: 'pinch', distance: distance(event.touches), size };
      }
    };
    const move = (event: TouchEvent) => {
      if (touching?.kind === 'pinch' && event.touches.length === 2) {
        event.preventDefault();
        const size = Math.round(touching.size * (distance(event.touches) / touching.distance));
        if (size !== termRef.current!.options.fontSize) {
          setFontSize(size);
        }
      } else if (touching?.kind === 'scroll' && event.touches.length === 1) {
        event.preventDefault();
        const { clientX: x, clientY: y } = event.touches[0];
        const dy = touching.y - y;
        touching.x = x;
        touching.y = y;
        const time = performance.now();
        touching.moves = [...touching.moves.filter((m) => time - m.time < 100), { dy, time }];
        if (dy) {
          scroll(dy, x, y);
        }
      }
    };
    const end = (event: TouchEvent) => {
      if (event.touches.length > 0) {
        return;
      }
      const term = termRef.current;
      if (touching?.kind === 'scroll' && touching.moves.length > 1 && term?.buffer.active.type === 'normal') {
        const { moves, x, y } = touching;
        const span = Math.max(16, performance.now() - moves[0].time);
        // px/ms, slowing down
        let speed = moves.reduce((sum, m) => sum + m.dy, 0) / span;
        let last = performance.now();
        const step = (now: number) => {
          const elapsed = now - last;
          last = now;
          scroll(speed * elapsed, x, y);
          speed *= 0.95 ** (elapsed / 16);
          if (Math.abs(speed) > 0.05) {
            fling = requestAnimationFrame(step);
          }
        };
        if (Math.abs(speed) > 0.3) {
          fling = requestAnimationFrame(step);
        }
      }
      touching = null;
    };
    screen.addEventListener('touchstart', start, { passive: true });
    screen.addEventListener('touchmove', move, { passive: false });
    screen.addEventListener('touchend', end);
    screen.addEventListener('touchcancel', end);
    return () => {
      cancelAnimationFrame(fling);
      screen.removeEventListener('touchstart', start);
      screen.removeEventListener('touchmove', move);
      screen.removeEventListener('touchend', end);
      screen.removeEventListener('touchcancel', end);
    };
  }, [setFontSize, config.fontSize]);

  const pressKey = (key: ExtraKey) => {
    const term = termRef.current!;
    if (key.action === 'keyboard') {
      toggleKeyboard();
      return;
    }
    if (key.action === 'paste') {
      void paste();
      return;
    }
    const data = keySequence(key, held(modifiersRef.current), term.modes.applicationCursorKeysMode);
    releaseModifiers();
    if (data) {
      // As typed: the terminal scrolls down to the prompt
      asIs(() => term.input(data, true));
    }
  };

  const pressModifier = (modifier: Modifier, lock: boolean) => {
    const now = performance.now();
    const twice = now - lastTap.current[modifier] < DOUBLE_TAP_MS;
    lastTap.current[modifier] = now;
    updateModifiers((states) => {
      const state = states[modifier];
      let next: ModifierState = state === 'off' ? 'once' : state === 'once' && twice ? 'locked' : 'off';
      if (lock) {
        next = 'locked';
      }
      return { ...states, [modifier]: next };
    });
  };

  const toggleKeyboard = () => {
    const term = termRef.current!;
    if (focused) {
      term.blur();
    } else {
      term.focus();
    }
  };

  // What the terminal's input then gives goes as is, without the extra keys'
  // modifiers
  const asIs = (input: () => void) => {
    bypassRef.current = true;
    try {
      input();
    } finally {
      bypassRef.current = false;
    }
  };

  const paste = async () => {
    const term = termRef.current!;
    if (canReadClipboard()) {
      try {
        const text = await navigator.clipboard.readText();
        asIs(() => term.paste(text));
        return;
      } catch {
        // Not allowed: as below
      }
    }
    setPasting(true);
  };

  // Not taking the terminal's focus, so that the on-screen keyboard stays
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

  const style = { '--terminal-bg': theme.background } as CSSProperties;
  if (filled) {
    Object.assign(
      style,
      viewport
        ? { top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height }
        : { top: 0, left: 0, width: '100%', height: '100%' },
    );
  }

  let tone = 'streaming';
  let line = title || config.command.trim() || connection.hostname || 'Terminal';
  if (!connected) {
    tone = 'idle';
    line = 'Reconnecting to the robot…';
  } else if (status.state === 'error') {
    tone = 'error';
  } else if (exitCode !== undefined) {
    tone = 'idle';
  }

  return (
    <div className={`terminal-widget${filled ? ' filled' : ''}`} style={style}>
      <div className="terminal-toolbar" role="toolbar" aria-label="Terminal" onMouseDown={keepFocus}>
        <span className={`terminal-dot ${tone}`} aria-hidden="true" />
        <span className="terminal-title" title={line}>
          {line}
        </span>
        <button
          type="button"
          className="overlay-button terminal-font"
          title="Smaller text"
          aria-label="Smaller text"
          disabled={fontSize <= FONT_SIZES.min}
          onClick={() => setFontSize(fontSize - 1)}
        >
          <TextSmallerIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button terminal-font"
          title="Larger text"
          aria-label="Larger text"
          disabled={fontSize >= FONT_SIZES.max}
          onClick={() => setFontSize(fontSize + 1)}
        >
          <TextLargerIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button"
          title="Paste (Ctrl+Shift+V)"
          aria-label="Paste"
          disabled={editing}
          onClick={() => void paste()}
        >
          <ClipboardIcon width={17} height={17} />
        </button>
        {touch && (
          <button
            type="button"
            className="overlay-button"
            aria-pressed={focused}
            title={focused ? 'Hide the keyboard' : 'Show the keyboard'}
            aria-label={focused ? 'Hide the keyboard' : 'Show the keyboard'}
            disabled={editing}
            onClick={toggleKeyboard}
          >
            <KeyboardIcon width={17} height={17} />
          </button>
        )}
        <button
          type="button"
          className="overlay-button"
          aria-pressed={maximized}
          title={maximized ? 'Back into the panel' : 'Fill the window'}
          aria-label={maximized ? 'Back into the panel' : 'Fill the window'}
          disabled={editing}
          onClick={() => setMaximized(!maximized)}
        >
          {maximized ? <MinimizeIcon width={17} height={17} /> : <MaximizeIcon width={17} height={17} />}
        </button>
        <button
          type="button"
          className="overlay-button"
          title="Restart: hangs up what runs, and starts it again"
          aria-label="Restart"
          disabled={editing || !connected}
          onClick={restart}
        >
          <RefreshIcon width={16} height={16} />
        </button>
      </div>
      <div ref={screenRef} className="terminal-screen" />
      {(status.state === 'error' || exitCode !== undefined) && (
        <div className={`terminal-banner${status.state === 'error' ? ' error' : ''}`} onMouseDown={keepFocus}>
          <span>
            {status.state === 'error' ? status.message : exitCode === null ? 'Ended' : `Exited with code ${exitCode}`}
            {status.state !== 'error' && !touch && ': press Enter to start it again'}
          </span>
          <button type="button" className="button" disabled={editing || !connected} onClick={restart}>
            <RefreshIcon width={14} height={14} />
            Restart
          </button>
        </div>
      )}
      {showKeys && (
        <ExtraKeys rows={rows} modifiers={modifiers} onKey={pressKey} onModifier={pressModifier} />
      )}
      {pasting && (
        <PasteDialog
          onClose={() => {
            setPasting(false);
            termRef.current?.focus();
          }}
          onPaste={(text, enter) => {
            setPasting(false);
            const term = termRef.current!;
            asIs(() => term.paste(text));
            if (enter) {
              send('\r');
            }
            term.focus();
          }}
        />
      )}
    </div>
  );
}
