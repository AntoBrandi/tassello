// The terminal widgets' terminals: the user's login shell, or a command it
// runs, on a pseudo-terminal (pty.ts), as the server's user.
//
// A terminal outlives its pages: a page that reloads or reconnects opens it
// again by its name and gets the output it missed. That output is also
// written to a terminal of the server's own (xterm.js, headless), whose
// screen and scrollback a page gets instead when it shows none of it yet, or
// lacks more than a window of it (TERMINAL_WINDOW). The server's terminal
// paces the program, which waits while it is behind; the pages do not: a slow
// page, or a hidden one, gets the screen later, never holding the program up.
//
// A terminal that no page shows is hung up after LINGER_MS, as is the one
// unseen the longest when MAX_TERMINALS are open and another is opened.

import { statSync } from 'node:fs';
import os from 'node:os';

import serializeModule from '@xterm/addon-serialize';
import headlessModule from '@xterm/headless';

import {
  TERMINAL_SCROLLBACK,
  TERMINAL_WINDOW,
  type TerminalExit,
  type TerminalOutput,
} from '../shared/protocol.ts';
import { resolvePath } from './file_manager.ts';
import type { StreamState } from './frame_stream.ts';
import { Pty } from './pty.ts';
import { Delivery, OutputLog } from './terminal_output.ts';
import { errorMessage, type Logger } from './util.ts';

// CommonJS modules, without named exports for Node
const { SerializeAddon } = serializeModule;
const { Terminal: Screen } = headlessModule;
type Screen = InstanceType<typeof Screen>;

const LINGER_MS = 60 * 60_000;
const MAX_TERMINALS = 16;
// Output kept for the pages that missed some
const LOG_LIMIT = 1024 * 1024;
// The program waits while the server's terminal has more than this to write,
// until it has less than RESUME_BELOW
const PAUSE_ABOVE = 128 * 1024;
const RESUME_BELOW = 32 * 1024;
// Output goes out at most this often, gathered
const FLUSH_MS = 5;
const MAX_COLS = 1000;
const MAX_ROWS = 500;

export interface TerminalRequest {
  // Its name, the page's
  terminal: string;
  command: string;
  folder: string;
  cols: number;
  rows: number;
  // The output the page shows
  started: number | null;
  offset: number | null;
}

export interface TerminalWatcher {
  onOutput: (output: Omit<TerminalOutput, 'type' | 'id'>) => void;
  onExit: (exit: Omit<TerminalExit, 'type' | 'id'>) => void;
  onStatus: (state: StreamState, message: string) => void;
}

// What a page does with the terminal it shows
export interface TerminalView {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  ack(started: number, offset: number): void;
  restart(): void;
  close(): void;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// The user's, unless it lets no one in (a service's user)
function loginShell(): string {
  for (const shell of [process.env.SHELL, os.userInfo().shell]) {
    if (shell && !/\/(nologin|false)$/.test(shell) && isFile(shell)) {
      return shell;
    }
  }
  return '/bin/bash';
}

// The folder to start in: the home folder if it cannot be, and why
function workingFolder(folder: string): { cwd: string; problem: string | null } {
  const home = os.homedir();
  try {
    const cwd = resolvePath(folder || '~');
    return statSync(cwd).isDirectory() ? { cwd, problem: null } : { cwd: home, problem: 'not a folder' };
  } catch (e) {
    return { cwd: home, problem: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : errorMessage(e) };
  }
}

function programEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'tassello',
  };
  // The server's own, as a systemd service: not the terminal's
  for (const name of ['NOTIFY_SOCKET', 'JOURNAL_STREAM', 'INVOCATION_ID', 'COLUMNS', 'LINES']) {
    delete env[name];
  }
  return env;
}

// One run of a terminal's program: the program, its output and its screen
class Run {
  readonly started: number;
  readonly pty: Pty;
  readonly screen: Screen;
  readonly serializer = new SerializeAddon();
  readonly log = new OutputLog(LOG_LIMIT);
  // Of the output: received, and written to the screen
  written = 0;
  parsed = 0;
  paused = false;
  title = '';
  // undefined while it runs
  exitCode: number | null | undefined = undefined;
  // Why it could not start
  error: string | null = null;

  constructor(started: number, pty: Pty, cols: number, rows: number) {
    this.started = started;
    this.pty = pty;
    this.screen = new Screen({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    // The addon is typed for the page's terminal, which the headless one is
    // made of
    this.screen.loadAddon(this.serializer as unknown as Parameters<Screen['loadAddon']>[0]);
    this.screen.onTitleChange((title) => {
      this.title = title;
    });
  }

  // The screen and its scrollback, as of the output parsed
  snapshot(): string {
    return this.serializer.serialize({ scrollback: TERMINAL_SCROLLBACK });
  }

  dispose(): void {
    this.pty.hangUp();
    this.screen.dispose();
  }
}

class Terminal {
  readonly name: string;
  command: string;
  folder: string;
  // While no page shows it: since when
  hiddenSince: number | null = null;
  // The pages showing it, and what each was sent
  private readonly watchers = new Map<TerminalWatcher, Delivery>();
  private readonly logger: Logger;
  private readonly onEnd: () => void;
  private run!: Run;
  private cols: number;
  private rows: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;

  constructor(request: TerminalRequest, logger: Logger, onEnd: () => void) {
    this.name = request.terminal;
    this.command = request.command;
    this.folder = request.folder;
    this.cols = request.cols;
    this.rows = request.rows;
    this.logger = logger;
    this.onEnd = onEnd;
    this.start();
  }

  attach(watcher: TerminalWatcher, started: number | null, offset: number | null, cols: number, rows: number): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.hiddenSince = null;
    this.resize(cols, rows);
    const { run } = this;
    const delivery = new Delivery(0);
    this.watchers.set(watcher, delivery);
    watcher.onStatus(run.error ? 'error' : 'streaming', run.error ?? '');
    if (started === run.started && offset !== null && run.log.since(offset) !== null) {
      // The page missed some: what follows
      delivery.offset = offset;
    } else if (run.written === 0) {
      // A new program: the page keeps what it shows of another
      watcher.onOutput({ started: run.started, offset: 0, reset: false, data: '', title: null });
    } else {
      this.sendSnapshot(watcher, delivery);
    }
    this.deliver(watcher, delivery);
    if (run.exitCode !== undefined) {
      watcher.onExit({ started: run.started, exitCode: run.exitCode });
    }
  }

  detach(watcher: TerminalWatcher): void {
    if (!this.watchers.delete(watcher) || this.watchers.size > 0) {
      return;
    }
    this.hiddenSince = Date.now();
    this.lingerTimer = setTimeout(() => {
      this.logger.info(`Terminal ${this.name}: not shown for ${LINGER_MS / 60_000} minutes, hung up`);
      this.end();
    }, LINGER_MS);
  }

  input(data: string): void {
    if (this.run.exitCode === undefined) {
      this.run.pty.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    cols = Math.min(MAX_COLS, Math.max(2, Math.round(cols)));
    rows = Math.min(MAX_ROWS, Math.max(1, Math.round(rows)));
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.run.pty.resize(cols, rows);
    this.run.screen.resize(cols, rows);
  }

  ack(watcher: TerminalWatcher, started: number, offset: number): void {
    const delivery = this.watchers.get(watcher);
    if (delivery && started === this.run.started) {
      delivery.ack(offset);
      this.deliver(watcher, delivery);
    }
  }

  // Its program anew, from a clean screen; with another command or folder
  restart(command = this.command, folder = this.folder): void {
    this.command = command;
    this.folder = folder;
    this.run.dispose();
    this.start();
    for (const watcher of this.watchers.keys()) {
      this.watchers.set(watcher, new Delivery(0));
      watcher.onStatus(this.run.error ? 'error' : 'streaming', this.run.error ?? '');
      watcher.onOutput({ started: this.run.started, offset: 0, reset: false, data: '', title: null });
    }
  }

  end(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
    }
    this.run.dispose();
    this.onEnd();
  }

  private start(): void {
    const { cwd, problem } = workingFolder(this.folder);
    const shell = loginShell();
    const args = this.command ? ['-l', '-c', this.command] : ['-l'];
    const pty = new Pty({ file: shell, args, cwd, env: programEnvironment(), cols: this.cols, rows: this.rows });
    // Unique to this terminal: what tells the pages it is another program
    const started = Math.max(Date.now(), (this.run?.started ?? 0) + 1);
    const run = new Run(started, pty, this.cols, this.rows);
    this.run = run;
    const what = this.command ? `\`${this.command}\`` : shell;
    this.logger.info(`Terminal ${this.name}: ${what} in ${cwd} (pid ${pty.pid ?? '-'})`);
    if (problem) {
      this.output(run, `\x1b[33mtassello: cannot start in ${this.folder} (${problem}): starting in ${cwd}\x1b[0m\r\n`);
    }
    pty.on('data', (data) => this.output(run, data));
    pty.on('exit', (exitCode) => {
      if (run !== this.run) {
        return;
      }
      run.exitCode = exitCode;
      this.logger.info(`Terminal ${this.name}: ${what} ${exitCode === null ? 'hung up' : `exited with ${exitCode}`}`);
      this.flush();
      for (const watcher of this.watchers.keys()) {
        watcher.onExit({ started: run.started, exitCode });
      }
    });
    pty.on('error', (e) => {
      if (run !== this.run) {
        return;
      }
      run.exitCode = null;
      run.error =
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Cannot open a terminal: python3 is not installed (ROS 2 comes with it)'
          : `Cannot open a terminal: ${errorMessage(e)}`;
      this.logger.error(`Terminal ${this.name}: ${run.error}`);
      for (const watcher of this.watchers.keys()) {
        watcher.onStatus('error', run.error);
        watcher.onExit({ started: run.started, exitCode: null });
      }
    });
  }

  private output(run: Run, data: string): void {
    if (run !== this.run) {
      return;
    }
    run.log.append(data);
    run.written += data.length;
    run.screen.write(data, () => {
      run.parsed += data.length;
      if (run.paused && run.written - run.parsed < RESUME_BELOW) {
        run.paused = false;
        run.pty.resume();
      }
    });
    if (!run.paused && run.written - run.parsed > PAUSE_ABOVE) {
      run.paused = true;
      run.pty.pause();
    }
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    for (const [watcher, delivery] of this.watchers) {
      this.deliver(watcher, delivery);
    }
  }

  private deliver(watcher: TerminalWatcher, delivery: Delivery): void {
    const { run } = this;
    const next = delivery.next(run.log, TERMINAL_WINDOW);
    if (next === 'snapshot') {
      this.sendSnapshot(watcher, delivery);
    } else if (next) {
      delivery.record(next.offset, next.data.length);
      watcher.onOutput({ started: run.started, offset: next.offset, reset: false, data: next.data, title: null });
    }
  }

  // The screen as of the output it has written: the page gets the rest after
  private sendSnapshot(watcher: TerminalWatcher, delivery: Delivery): void {
    const { run } = this;
    const data = run.snapshot();
    delivery.record(run.parsed, data.length);
    watcher.onOutput({ started: run.started, offset: run.parsed, reset: true, data, title: run.title });
  }
}

const IDLE_VIEW: TerminalView = { input() {}, resize() {}, ack() {}, restart() {}, close() {} };

export class Terminals {
  private readonly logger: Logger;
  private readonly terminals = new Map<string, Terminal>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  open(request: TerminalRequest, watcher: TerminalWatcher): TerminalView {
    let terminal = this.terminals.get(request.terminal);
    if (terminal && (terminal.command !== request.command || terminal.folder !== request.folder)) {
      // Its widget's properties changed
      terminal.restart(request.command, request.folder);
    }
    if (!terminal) {
      if (this.terminals.size >= MAX_TERMINALS && !this.hangUpUnseen()) {
        watcher.onStatus('error', `${MAX_TERMINALS} terminals are open on the robot already: close one`);
        return IDLE_VIEW;
      }
      const opened = new Terminal(request, this.logger, () => {
        if (this.terminals.get(request.terminal) === opened) {
          this.terminals.delete(request.terminal);
        }
      });
      this.terminals.set(request.terminal, opened);
      terminal = opened;
    }
    const shown = terminal;
    shown.attach(watcher, request.started, request.offset, request.cols, request.rows);
    return {
      input: (data) => shown.input(data),
      resize: (cols, rows) => shown.resize(cols, rows),
      ack: (started, offset) => shown.ack(watcher, started, offset),
      restart: () => shown.restart(),
      close: () => shown.detach(watcher),
    };
  }

  // The server is shutting down
  stopAll(): void {
    for (const terminal of [...this.terminals.values()]) {
      terminal.end();
    }
  }

  // The terminal unseen the longest, if any is: hung up to open another
  private hangUpUnseen(): boolean {
    let oldest: Terminal | null = null;
    for (const terminal of this.terminals.values()) {
      if (terminal.hiddenSince !== null && (oldest === null || terminal.hiddenSince < oldest.hiddenSince!)) {
        oldest = terminal;
      }
    }
    if (oldest) {
      this.logger.info(`Terminal ${oldest.name}: hung up, to open another`);
      oldest.end();
    }
    return oldest !== null;
  }
}
