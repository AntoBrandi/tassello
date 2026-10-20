// The systemd services for the application manager widgets: listed with their
// state, of the system's service manager (the robot's units) and the user's
// (the PC's), started, stopped and restarted, and their journals followed.
//
// The system's services need the right to manage them, e.g. a polkit rule
// letting the server's user start, stop and restart the robot's services
// (see the README); without it the actions fail, with systemctl's reason.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { ServiceInfo, ServiceScope, ServiceVerb } from '../shared/protocol.ts';
import {
  checkUnit,
  journalLine,
  loadedUnits,
  ownUnit,
  serviceGlob,
  shownServices,
  unitFiles,
} from './systemd_format.ts';
import { errorMessage, stripAnsi, type Logger } from './util.ts';

const SCOPES: ServiceScope[] = ['system', 'user'];
// How often the watched services' states are read
const POLL_PERIOD_MS = 2000;
// Starting a ROS launch takes a while, stopping one up to its TimeoutStopSec
const ACTION_TIMEOUT_MS = 120_000;
// The journal lines shown when a page starts following a service
const JOURNAL_LINES = 200;
// Characters of journal kept, the latest
const JOURNAL_LIMIT = 16_000;
// New journal lines go out at most this often
const JOURNAL_PERIOD_MS = 250;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function systemctl(scope: ServiceScope, args: string[], timeout = 10_000): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      [...(scope === 'user' ? ['--user'] : []), '--no-pager', ...args],
      { timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr: stderr || (error && !stdout ? error.message : ''),
        }),
    );
  });
}

let self: string | null | undefined;
function selfUnit(): string | null {
  if (self === undefined) {
    try {
      self = ownUnit(readFileSync('/proc/self/cgroup', 'utf8'));
    } catch {
      self = null;
    }
  }
  return self;
}

// Of one service manager; throws if it cannot be reached
async function listScope(scope: ServiceScope, glob: string): Promise<ServiceInfo[]> {
  const [files, loaded] = await Promise.all([
    systemctl(scope, ['list-unit-files', '--type=service', '--no-legend', '--plain', glob]),
    systemctl(scope, ['list-units', '--all', '--type=service', '--no-legend', '--plain', glob]),
  ]);
  // Nothing listed is exit code 1 too: only stderr tells a real failure
  if (files.code !== 0 && files.stderr.trim() && loaded.code !== 0) {
    throw new Error(files.stderr.trim());
  }
  // The loaded units too: generated or transient ones have no unit file
  const units = [...new Set([...unitFiles(files.stdout), ...loadedUnits(loaded.stdout)])];
  if (units.length === 0) {
    return [];
  }
  const shown = await systemctl(scope, [
    'show',
    '--timestamp=utc',
    '--property=Id,Description,LoadState,ActiveState,SubState,Result,UnitFileState,StateChangeTimestamp',
    ...units,
  ]);
  if (shown.code !== 0) {
    throw new Error(shown.stderr.trim() || `systemctl show failed (${shown.code})`);
  }
  return shownServices(shown.stdout, scope, selfUnit());
}

// Both service managers: an error only if neither can be read. The user's
// one does not exist for the robot's system services.
async function listServices(pattern: string): Promise<{ services: ServiceInfo[]; error: string | null }> {
  let glob: string;
  try {
    glob = serviceGlob(pattern);
  } catch (e) {
    return { services: [], error: errorMessage(e) };
  }
  const results = await Promise.allSettled(SCOPES.map((scope) => listScope(scope, glob)));
  const services = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .sort((a, b) => a.unit.localeCompare(b.unit) || a.scope.localeCompare(b.scope));
  const failed = results.every((result) => result.status === 'rejected');
  return {
    services,
    error: failed ? `Cannot list the services: ${errorMessage((results[0] as PromiseRejectedResult).reason)}` : null,
  };
}

type ServicesListener = (update: { services: ServiceInfo[]; error: string | null }) => void;

class ServicesWatch {
  readonly listeners = new Set<ServicesListener>();
  private readonly pattern: string;
  private latest: { services: ServiceInfo[]; error: string | null } | null = null;
  private latestJson = '';
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private again = false;
  private stopped = false;

  constructor(pattern: string) {
    this.pattern = pattern;
    void this.refresh();
  }

  add(listener: ServicesListener): void {
    this.listeners.add(listener);
    if (this.latest) {
      listener(this.latest);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  // Now, then every POLL_PERIOD_MS; sent only when something changed
  async refresh(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reading = true;
    const latest = await listServices(this.pattern);
    this.reading = false;
    if (this.stopped) {
      return;
    }
    const json = JSON.stringify(latest);
    if (json !== this.latestJson) {
      this.latest = latest;
      this.latestJson = json;
      this.listeners.forEach((listener) => listener(latest));
    }
    if (this.again) {
      this.again = false;
      void this.refresh();
    } else {
      this.timer = setTimeout(() => void this.refresh(), POLL_PERIOD_MS);
    }
  }
}

type JournalListener = (text: string, reset: boolean) => void;

// journalctl --follow of a service, shared by the pages showing it
class JournalFollow {
  readonly listeners = new Set<JournalListener>();
  private readonly child: ChildProcess;
  private text = '';
  // Arrived since the last sending
  private pending = '';
  // A line not ended yet
  private partial = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(unit: string, scope: ServiceScope) {
    this.child = spawn(
      'journalctl',
      [
        ...(scope === 'user' ? ['--user'] : []),
        `--unit=${unit}`,
        `--lines=${JOURNAL_LINES}`,
        '--follow',
        '--output=short-iso',
        '--no-pager',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SYSTEMD_COLORS: '0' } },
    );
    this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = (this.partial + chunk).split('\n');
      this.partial = lines.pop() ?? '';
      this.append(lines.map((line) => `${journalLine(stripAnsi(line))}\n`).join(''));
    });
    // e.g. a user not allowed to read the system journal
    this.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => this.append(stripAnsi(chunk)));
    this.child.on('error', (e) => this.append(`journalctl: ${e.message}\n`));
  }

  add(listener: JournalListener): void {
    this.listeners.add(listener);
    listener(this.text, true);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.child.kill();
  }

  private append(text: string): void {
    if (!text) {
      return;
    }
    this.text = (this.text + text).slice(-JOURNAL_LIMIT);
    this.pending += text;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const pending = this.pending.slice(-JOURNAL_LIMIT);
      this.pending = '';
      this.listeners.forEach((listener) => listener(pending, false));
    }, JOURNAL_PERIOD_MS);
  }
}

export class SystemdServices {
  private readonly logger: Logger;
  private readonly watches = new Map<string, ServicesWatch>();
  private readonly journals = new Map<string, JournalFollow>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // The services matching pattern, whenever they change, until the returned
  // function is called
  watch(pattern: string, listener: ServicesListener): () => void {
    const key = pattern.trim();
    let watch = this.watches.get(key);
    if (!watch) {
      watch = new ServicesWatch(key);
      this.watches.set(key, watch);
    }
    const shared = watch;
    shared.add(listener);
    return () => {
      shared.listeners.delete(listener);
      if (shared.listeners.size === 0) {
        shared.stop();
        this.watches.delete(key);
      }
    };
  }

  // Resolves once systemctl is done, the job included; throws its reason
  async act(unit: string, scope: ServiceScope, verb: ServiceVerb): Promise<void> {
    checkUnit(unit);
    if (!SCOPES.includes(scope) || !['start', 'stop', 'restart'].includes(verb)) {
      throw new Error(`Invalid action ${scope} ${verb}`);
    }
    this.logger.info(`${verb} ${unit} (${scope})`);
    // Shows it starting or stopping meanwhile
    setTimeout(() => this.refreshAll(), 300);
    const result = await systemctl(scope, ['--no-ask-password', verb, unit], ACTION_TIMEOUT_MS);
    this.refreshAll();
    if (result.code !== 0) {
      const reason = (result.stderr || result.stdout).trim() || `systemctl ${verb} ${unit} failed (${result.code})`;
      this.logger.warn(reason);
      throw new Error(reason);
    }
  }

  // The service's journal: the latest lines, then the new ones
  logs(unit: string, scope: ServiceScope, listener: JournalListener): () => void {
    checkUnit(unit);
    const key = `${scope} ${unit}`;
    let journal = this.journals.get(key);
    if (!journal) {
      journal = new JournalFollow(unit, scope);
      this.journals.set(key, journal);
    }
    const shared = journal;
    shared.add(listener);
    return () => {
      shared.listeners.delete(listener);
      if (shared.listeners.size === 0) {
        shared.stop();
        this.journals.delete(key);
      }
    };
  }

  // The server is shutting down
  stopAll(): void {
    this.watches.forEach((watch) => watch.stop());
    this.journals.forEach((journal) => journal.stop());
  }

  private refreshAll(): void {
    this.watches.forEach((watch) => void watch.refresh());
  }
}
