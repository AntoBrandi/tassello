// Runs the bash commands of the button widgets, and of the plugins' widgets
// that run one (PluginContext.commandWidget). A command is looked up in the
// saved panel, never taken from the client, and runs at most once at a time
// per widget. Its state (running, exit status, output) is broadcast to every
// client, so that all of them show the same buttons running.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import type { CommandState } from '../shared/protocol.ts';
import type { CommandWidget } from './api.ts';
import type { PanelStore } from './panels.ts';
import { errorMessage, stripAnsi, type Logger } from './util.ts';
// Characters of output kept, the latest
const OUTPUT_LIMIT = 8000;
// While a command runs, its output is broadcast at most this often
const OUTPUT_PERIOD_MS = 250;
// Stopping sends SIGINT, which ros2 launch & co. handle like Ctrl+C, then
// SIGTERM and SIGKILL to what still runs after this long each
const STOP_ESCALATION_MS = 5000;

interface Run {
  child: ChildProcess;
  state: CommandState;
  outputTimer: NodeJS.Timeout | null;
  stopTimers: NodeJS.Timeout[];
}

interface CommandEvents {
  state: [CommandState];
}

export class CommandRunner extends EventEmitter<CommandEvents> {
  private readonly store: PanelStore;
  private readonly logger: Logger;
  // The last run of every button, by "<panel id>/<widget id>"
  private readonly states = new Map<string, CommandState>();
  private readonly runs = new Map<string, Run>();
  // The widget types that run a command, by type
  private readonly widgets = new Map<string, CommandWidget>([['button', { property: 'command' }]]);

  constructor(store: PanelStore, logger: Logger) {
    super();
    this.store = store;
    this.logger = logger;
  }

  registerWidget(type: string, command: CommandWidget): void {
    if (this.widgets.has(type)) {
      throw new Error(`Widgets of type "${type}" already run a command`);
    }
    this.widgets.set(type, command);
  }

  snapshot(): CommandState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  // Throws if the button or its command cannot be found
  async run(panelId: string, widgetId: string): Promise<void> {
    const key = `${panelId}/${widgetId}`;
    if (this.runs.has(key)) {
      return;
    }
    const panel = await this.store.get(panelId);
    const widget = panel?.widgets.find((w) => w.id === widgetId);
    const spec = widget && this.widgets.get(widget.type);
    if (!panel || !widget || !spec) {
      throw new Error(`Panel "${panelId}" has no widget "${widgetId}" running a command: is it saved?`);
    }
    const value = widget.config[spec.property];
    const command = (typeof value === 'string' ? value : (spec.fallback ?? '')).trim();
    if (!command) {
      throw new Error('This widget has no command to run');
    }
    // Clicked twice while the panel was read
    if (this.runs.has(key)) {
      return;
    }

    const state: CommandState = {
      panelId,
      widgetId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      output: '',
    };
    // detached: a process group of its own, so that stopping it reaches
    // everything it started
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: os.homedir(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', RCUTILS_COLORIZED_OUTPUT: '0' },
    });
    const run: Run = { child, state, outputTimer: null, stopTimers: [] };
    this.runs.set(key, run);
    const label = typeof widget.config.label === 'string' && widget.config.label ? widget.config.label : widgetId;
    this.logger.info(`${panel.name} / ${label}: running \`${command}\` (pid ${child.pid ?? '-'})`);

    const onOutput = (chunk: string) => {
      state.output = (state.output + stripAnsi(chunk)).slice(-OUTPUT_LIMIT);
      run.outputTimer ??= setTimeout(() => {
        run.outputTimer = null;
        this.publish(state);
      }, OUTPUT_PERIOD_MS);
    };
    child.stdout?.setEncoding('utf8').on('data', onOutput);
    child.stderr?.setEncoding('utf8').on('data', onOutput);
    // 'exit', not 'close': what the command left running in the background may
    // keep its output open long after it finished
    child.on('exit', (exitCode, signal) => this.finish(key, run, { exitCode, signal, error: null }));
    child.on('error', (e) => this.finish(key, run, { exitCode: null, signal: null, error: errorMessage(e) }));
    this.publish(state);
  }

  stop(panelId: string, widgetId: string): void {
    const run = this.runs.get(`${panelId}/${widgetId}`);
    if (!run || run.stopTimers.length > 0) {
      return;
    }
    this.logger.info(`Stopping the command of ${panelId}/${widgetId}`);
    const signal = (name: NodeJS.Signals) => this.signal(run, name);
    signal('SIGINT');
    run.stopTimers.push(
      setTimeout(() => signal('SIGTERM'), STOP_ESCALATION_MS),
      setTimeout(() => signal('SIGKILL'), 2 * STOP_ESCALATION_MS),
    );
  }

  // The server is shutting down
  stopAll(): void {
    for (const run of this.runs.values()) {
      this.signal(run, 'SIGTERM');
    }
  }

  private signal(run: Run, name: NodeJS.Signals): void {
    if (run.child.pid === undefined) {
      return;
    }
    try {
      // The whole process group
      process.kill(-run.child.pid, name);
    } catch {
      // Already gone
    }
  }

  private finish(
    key: string,
    run: Run,
    result: Pick<CommandState, 'exitCode' | 'signal' | 'error'>,
  ): void {
    if (this.runs.get(key) !== run) {
      return;
    }
    this.runs.delete(key);
    run.stopTimers.forEach(clearTimeout);
    Object.assign(run.state, result, { running: false, finishedAt: Date.now() });
    const { exitCode, signal, error } = run.state;
    this.logger.info(
      `Command of ${key} ${error ? `failed: ${error}` : signal ? `killed by ${signal}` : `exited with ${exitCode}`}`,
    );
    this.publish(run.state);
  }

  private publish(state: CommandState): void {
    const copy = { ...state };
    this.states.set(`${state.panelId}/${state.widgetId}`, copy);
    this.emit('state', copy);
  }
}
