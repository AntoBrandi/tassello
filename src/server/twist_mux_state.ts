// A twist_mux node as the server follows it for the Twist Mux inspectors
// (twist_mux.ts): its configuration, read from its diagnostics or its
// parameters, and what it does with the messages of its inputs, worked out as
// twist_mux works it out (twist_mux.cpp, topic_handle.hpp) and checked
// against its output: a message on the output is the input's message it
// forwarded, unchanged. Kept apart from twist_mux.ts to be tested without ROS.

import type { ParamInfo, ParamValue } from '../shared/parameters.ts';
import type { DiagnosticEntry } from '../shared/protocol.ts';
import type { MuxDiagnostics, MuxFate, MuxInput, MuxLock, MuxOutput, TwistMuxState } from '../shared/twist_mux.ts';

export const TWIST = 'geometry_msgs/msg/Twist';
export const TWIST_STAMPED = 'geometry_msgs/msg/TwistStamped';
export const BOOL = 'std_msgs/msg/Bool';

// diagnostic_updater's task, which it names after the node: "twist_mux: Twist
// mux status"
const STATUS_NAME = 'Twist mux status';
// An input's message is decided once the output showed it, or this long after
// it came: twist_mux forwards it at once, from its callback. As long, an
// output's message waits for the input's that it is, which may come after it.
export const DECIDE_MS = 150;
// Once its output is subscribed for this long (discovery), what the mux
// forwards is taken to show there: an input's message that should have passed
// and did not was dropped
export const OUTPUT_READY_MS = 2000;
// Another input's message shown this close to one that should have passed
// says that input had the priority
const OUTRANKED_MS = 1000;
// Just subscribed, until the output's first message or for this long, the
// inputs heard first may not be those that have the priority: their
// messages are decided after, and nothing is shown
export const WARMUP_MS = 600;
// As long, at most, for twist_mux's diagnostics, while a lock is not heard of:
// it may have been published before, once
export const DIAGNOSTICS_WAIT_MS = 2500;
// Rates over the latest messages
const RATE_WINDOW_MS = 2000;
const MAX_TIMES = 1000;

// A topic or a lock, as twist_mux reads it from its parameters:
// <prefix>.topic, <prefix>.timeout, <prefix>.priority
export interface HandleConfig {
  // As twist_mux names its handles: topics.joystick, locks.pause
  prefix: string;
  // Without topics. or locks.: joystick, pause
  name: string;
  // As configured: in the node's namespace, unless absolute
  topic: string;
  // Seconds; 0: no timeout
  timeout: number;
  // 0 to 255
  priority: number;
}

export interface MuxConfig {
  inputs: HandleConfig[];
  locks: HandleConfig[];
  // use_stamped, if set (twist_mux 4.4 and later: TwistStamped by default)
  useStamped: boolean | null;
  problems: string[];
}

// A node of the graph publishing on a topic
export interface TopicPublisher {
  node: string;
  type: string;
}

// The mux in the ROS graph
export interface MuxGraph {
  found: boolean;
  // Its subscriptions and publications: topic, then types
  subscriptions: Map<string, string[]>;
  publications: Map<string, string[]>;
  // Of the topics of its inputs, locks and output
  publishers: Map<string, TopicPublisher[]>;
}

// As std::string compares, which orders twist_mux's parameters and so its
// handles: the first of equal priorities wins
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numberOf(value: ParamValue | undefined): number | null {
  if (value && (value.type === 'double' || value.type === 'integer')) {
    const n = Number(value.value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// rclcpp clamps them so
function clampPriority(priority: number): number {
  return Math.min(255, Math.max(0, Math.trunc(priority)));
}

function handlesOf(values: Map<string, ParamValue>, group: 'topics' | 'locks', problems: string[]): HandleConfig[] {
  // As twist_mux lists them: the prefix of each parameter under the group
  const prefixes = new Set<string>();
  for (const name of values.keys()) {
    if (name.startsWith(`${group}.`)) {
      prefixes.add(name.slice(0, name.lastIndexOf('.')));
    }
  }
  const handles: HandleConfig[] = [];
  for (const prefix of [...prefixes].sort(byteOrder)) {
    const topic = values.get(`${prefix}.topic`);
    if (topic?.type !== 'string' || typeof topic.value !== 'string' || !topic.value.trim()) {
      problems.push(`${prefix} has no topic`);
      continue;
    }
    const timeout = numberOf(values.get(`${prefix}.timeout`));
    const priority = numberOf(values.get(`${prefix}.priority`));
    if (timeout === null) {
      problems.push(`${prefix} has no timeout`);
    }
    if (priority === null) {
      problems.push(`${prefix} has no priority`);
    }
    handles.push({
      prefix,
      name: prefix.slice(group.length + 1) || prefix,
      topic: topic.value.trim(),
      timeout: Math.max(0, timeout ?? 0),
      priority: clampPriority(priority ?? 0),
    });
  }
  return handles;
}

// Its inputs and locks from its parameters (topics.*, locks.*)
export function configFromParameters(params: Iterable<ParamInfo>): MuxConfig {
  const values = new Map<string, ParamValue>();
  for (const param of params) {
    values.set(param.name, param.value);
  }
  const problems: string[] = [];
  const stamped = values.get('use_stamped');
  return {
    inputs: handlesOf(values, 'topics', problems),
    locks: handlesOf(values, 'locks', problems),
    useStamped: stamped?.type === 'bool' ? stamped.value === true : null,
    problems,
  };
}

// diagnostic_updater's name of the node's status
export function isMuxStatus(name: string, node: string): boolean {
  const base = node.slice(node.lastIndexOf('/') + 1);
  return name === `${base}: ${STATUS_NAME}` || name === STATUS_NAME;
}

// " masked (listening to nav_vel @ 0.500000s with priority #10)"
const HANDLE_VALUE = /^\s*(masked|unmasked|locked|free) \(listening to (.*) @ (\S+)s with priority #(-?\d+)\)\s*$/;

export interface MuxStatus {
  // The inputs and locks it runs with
  config: MuxConfig;
  // By lock name
  locked: Map<string, boolean>;
  diagnostics: MuxDiagnostics;
}

// What twist_mux says of itself once a second: each of its handles, as it
// runs with them (it reads its parameters once, when it starts), and its
// current priority
export function parseMuxStatus(entry: DiagnosticEntry): MuxStatus {
  const inputs: HandleConfig[] = [];
  const locks: HandleConfig[] = [];
  const locked = new Map<string, boolean>();
  let priority: number | null = null;
  for (const { key, value } of entry.values) {
    if (key === 'current priority') {
      const n = Number(value);
      priority = value.trim() && Number.isFinite(n) ? n : null;
      continue;
    }
    const kind = key.startsWith('velocity ') ? 'topics' : key.startsWith('lock ') ? 'locks' : null;
    const match = kind ? HANDLE_VALUE.exec(value) : null;
    if (!kind || !match) {
      continue;
    }
    const prefix = key.slice(key.indexOf(' ') + 1);
    const handle: HandleConfig = {
      prefix,
      name: prefix.startsWith(`${kind}.`) ? prefix.slice(kind.length + 1) : prefix,
      topic: match[2],
      timeout: Math.max(0, Number(match[3]) || 0),
      priority: clampPriority(Number(match[4])),
    };
    if (kind === 'topics') {
      inputs.push(handle);
    } else {
      locks.push(handle);
      locked.set(handle.name, match[1] === 'locked');
    }
  }
  const byPrefix = (a: HandleConfig, b: HandleConfig) => byteOrder(a.prefix, b.prefix);
  return {
    config: { inputs: inputs.sort(byPrefix), locks: locks.sort(byPrefix), useStamped: null, problems: [] },
    locked,
    diagnostics: { level: entry.level, message: entry.message, stale: entry.stale, priority },
  };
}

// A topic's name as the node resolves it: in its namespace, or under the node
// for ~
export function resolveTopic(topic: string, node: string): string {
  const namespace = node.slice(0, node.lastIndexOf('/'));
  let name = topic.trim();
  if (name.startsWith('~')) {
    name = node + name.slice(1);
  } else if (!name.startsWith('/')) {
    name = `${namespace}/${name}`;
  }
  return `/${name.split('/').filter(Boolean).join('/')}`;
}

// Its output: what it publishes velocity commands on, cmd_vel_out as remapped
export function outputOf(publications: Map<string, string[]>): { topic: string; type: string } | null {
  for (const [topic, types] of [...publications].sort(([a], [b]) => byteOrder(a, b))) {
    const type = types.find((t) => t === TWIST || t === TWIST_STAMPED);
    if (type) {
      return { topic, type };
    }
  }
  return null;
}

// Twist or TwistStamped, of a topic's types
function velocityType(types: string[] | undefined): string | null {
  return types?.find((t) => t === TWIST || t === TWIST_STAMPED) ?? null;
}

function component(vector: unknown, axis: 'x' | 'y' | 'z'): number {
  const value = (vector as Record<string, unknown> | null)?.[axis];
  return typeof value === 'number' ? value : Number.NaN;
}

function rounded(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : 0;
}

// A velocity command's numbers (linear x, y, z, angular x, y, z), and what
// tells it from others: those, exactly (key), and with a TwistStamped's header
// (full). A mux forwards the values as they came; its header too if it takes
// TwistStamped, but one that takes Twist and publishes TwistStamped stamps
// them itself.
export function commandOf(message: unknown, messageType: string): { twist: number[]; key: string; full: string } | null {
  const fields = (message ?? {}) as Record<string, unknown>;
  let twist: unknown;
  let header = '';
  if (messageType === TWIST) {
    twist = fields;
  } else if (messageType === TWIST_STAMPED) {
    twist = fields.twist;
    const { stamp, frame_id: frame } = (fields.header ?? {}) as Record<string, unknown>;
    const { sec, nanosec } = (stamp ?? {}) as Record<string, unknown>;
    header = `${String(sec)}.${String(nanosec)} ${String(frame)} `;
  } else {
    return null;
  }
  const { linear, angular } = (twist ?? {}) as Record<string, unknown>;
  const numbers = [
    component(linear, 'x'),
    component(linear, 'y'),
    component(linear, 'z'),
    component(angular, 'x'),
    component(angular, 'y'),
    component(angular, 'z'),
  ];
  const key = numbers.join(' ');
  return { twist: numbers.map(rounded), key, full: header + key };
}

// Of two ranks, compared in order: whether the first is higher
function betterRank(a: number[], b: number[]): boolean {
  const i = a.findIndex((value, k) => value !== b[k]);
  return i >= 0 && a[i] > b[i];
}

function addTime(times: number[], now: number): void {
  times.push(now);
  if (times.length > MAX_TIMES) {
    times.splice(0, times.length - MAX_TIMES);
  }
}

function rateOf(times: number[], now: number): number {
  const recent = times.findIndex((t) => t >= now - RATE_WINDOW_MS);
  times.splice(0, recent < 0 ? times.length : recent);
  if (times.length < 2) {
    return 0;
  }
  const span = times[times.length - 1] - times[0];
  return span > 0 ? Math.round(((times.length - 1) * 1000 * 10) / span) / 10 : 0;
}

function expired(timeout: number, lastAt: number | null, now: number): boolean {
  return timeout > 0 && (lastAt === null || now - lastAt > timeout * 1000);
}

function emptyFlow(): Record<MuxFate, number> {
  return { passed: 0, outranked: 0, locked: 0, dropped: 0 };
}

// An input's message, until decided
interface Arrival {
  at: number;
  key: string;
  full: string;
  // What twist_mux does with it, as the dashboard sees the mux
  predicted: MuxFate;
  // Came while warming up: predicted again when decided, from what is known
  // by then (the locks' states, the inputs heard since)
  provisional: boolean;
  // Seen on the output
  shown: boolean;
}

interface Tracked {
  config: HandleConfig;
  // Resolved
  topic: string;
  lastAt: number | null;
  // Of the subscription, from twist_mux.ts
  subscribeError: string;
}

interface InputTrack extends Tracked {
  // As the mux subscribes to it: Twist or TwistStamped. Kept while it is gone.
  type: string | null;
  times: number[];
  twist: number[] | null;
  arrivals: Arrival[];
  flow: Record<MuxFate, number>;
}

interface LockTrack extends Tracked {
  value: boolean | null;
  flow: { on: number; off: number };
}

interface OutputTrack {
  topic: string | null;
  // Since when it is subscribed; null: it is not
  subscribedAt: number | null;
  // Its first message since: what the mux forwards reaches the server
  firstAt: number | null;
  subscribeError: string;
  lastAt: number | null;
  times: number[];
  twist: number[] | null;
  source: string | null;
  // The input of the latest of its messages matched with an input's
  shown: { name: string; at: number } | null;
  // Its messages not matched yet with an input's, which may come after them
  unmatched: { at: number; key: string; full: string }[];
  flow: { inputs: Record<string, number>; other: number };
}

const NO_GRAPH: MuxGraph = { found: false, subscriptions: new Map(), publications: new Map(), publishers: new Map() };

export class MuxTracker {
  readonly node: string;
  // The dashboard's own node, among the publishers
  private readonly self: string;
  private inputs: InputTrack[] = [];
  private locks: LockTrack[] = [];
  private readonly output: OutputTrack = {
    topic: null,
    subscribedAt: null,
    firstAt: null,
    subscribeError: '',
    lastAt: null,
    times: [],
    twist: null,
    source: null,
    shown: null,
    unmatched: [],
    flow: { inputs: {}, other: 0 },
  };
  private graph: MuxGraph = NO_GRAPH;
  private fromParameters: MuxConfig | null = null;
  private status: MuxStatus | null = null;
  private parametersError = '';
  // What it publishes: Twist or TwistStamped. Kept while it is gone.
  private outType: string | null = null;

  // Since when it is followed
  private readonly startedAt: number;

  constructor(node: string, self: string, startedAt: number) {
    this.node = node;
    this.self = self;
    this.startedAt = startedAt;
  }

  // The configuration: what twist_mux says it runs with, else its parameters
  private get config(): MuxConfig | null {
    return this.status?.config ?? this.fromParameters;
  }

  // What its inputs take, and what it publishes: Twist or TwistStamped, as
  // the graph has its subscriptions and publications. They may differ: some
  // versions take Twist and publish TwistStamped (use_stamped). null: not
  // known yet.
  get inputType(): string | null {
    return this.inputs.find((t) => t.type)?.type ?? null;
  }

  get outputType(): string | null {
    return this.outType;
  }

  private updateTypes(): void {
    const stamped = this.config?.useStamped;
    this.outType =
      outputOf(this.graph.publications)?.type ??
      this.outType ??
      (stamped === undefined || stamped === null ? null : stamped ? TWIST_STAMPED : TWIST);
    for (const track of this.inputs) {
      track.type = velocityType(this.graph.subscriptions.get(track.topic)) ?? track.type;
    }
    // An input it does not subscribe to (remapped?): as the others
    const common = this.inputType;
    for (const track of this.inputs) {
      track.type ??= common;
    }
  }

  get found(): boolean {
    return this.graph.found;
  }

  // What to subscribe to: each input's topic and type, each lock's topic, by
  // name, and the output's
  topics(): {
    inputs: Map<string, { topic: string; type: string | null }>;
    locks: Map<string, string>;
    output: string | null;
  } {
    return {
      inputs: new Map(this.inputs.map((t) => [t.config.name, { topic: t.topic, type: t.type }])),
      locks: new Map(this.locks.map((t) => [t.config.name, t.topic])),
      output: this.output.topic,
    };
  }

  // A lock's topic, resolved, and timeout; null: no such lock
  lockHandle(name: string): { topic: string; timeout: number } | null {
    const track = this.locks.find((t) => t.config.name === name);
    return track ? { topic: track.topic, timeout: track.config.timeout } : null;
  }

  // Its parameters (null: not read, with why)
  setParameters(params: ParamInfo[] | null, error = ''): void {
    this.fromParameters = params ? configFromParameters(params) : null;
    this.parametersError = params ? '' : error;
    this.reconfigure();
  }

  // Its "Twist mux status" (null: none)
  setStatus(entry: DiagnosticEntry | null): void {
    this.status = entry ? parseMuxStatus(entry) : null;
    this.reconfigure();
  }

  setGraph(graph: MuxGraph): void {
    this.graph = graph;
    const topic = graph.found ? (outputOf(graph.publications)?.topic ?? null) : this.output.topic;
    if (topic !== this.output.topic) {
      Object.assign(this.output, {
        topic,
        subscribedAt: null,
        firstAt: null,
        subscribeError: '',
        unmatched: [],
        source: null,
        shown: null,
      });
    }
    this.updateTypes();
  }

  // Of the subscriptions twist_mux.ts makes: since when (null: none), and why
  // it could not
  setSubscribed(kind: 'input' | 'lock' | 'output', name: string, at: number | null, error = ''): void {
    if (kind === 'output') {
      Object.assign(this.output, { subscribedAt: at, firstAt: null, subscribeError: error });
      return;
    }
    const track = (kind === 'input' ? this.inputs : this.locks).find((t) => t.config.name === name);
    if (track) {
      track.subscribeError = error;
    }
  }

  // Each handle anew, keeping what was seen of those still on the same topic
  private reconfigure(): void {
    const config = this.config;
    const keep = <T extends Tracked>(tracks: T[], handle: HandleConfig, make: (base: Tracked) => T): T => {
      const topic = resolveTopic(handle.topic, this.node);
      const known = tracks.find((t) => t.config.name === handle.name && t.topic === topic);
      if (known) {
        known.config = handle;
        return known;
      }
      return make({ config: handle, topic, lastAt: null, subscribeError: '' });
    };
    this.inputs = (config?.inputs ?? []).map((handle) =>
      keep(this.inputs, handle, (base) => ({ ...base, type: null, times: [], twist: null, arrivals: [], flow: emptyFlow() })),
    );
    this.locks = (config?.locks ?? []).map((handle) =>
      keep(this.locks, handle, (base) => ({ ...base, value: null, flow: { on: 0, off: 0 } })),
    );
    this.updateTypes();
  }

  private lockState(track: LockTrack, now: number): Pick<MuxLock, 'expired' | 'locked' | 'source'> {
    const timedOut = expired(track.config.timeout, track.lastAt, now);
    if (track.value !== null) {
      return { expired: timedOut, locked: timedOut || track.value, source: 'messages' };
    }
    // Not heard of since watched: as twist_mux says, while it does
    const reported = this.status && !this.status.diagnostics.stale ? this.status.locked.get(track.config.name) : undefined;
    if (reported !== undefined) {
      return { expired: false, locked: reported, source: 'diagnostics' };
    }
    // twist_mux's own, without a message: free, or locked if it times out
    return { expired: timedOut, locked: timedOut, source: 'default' };
  }

  // getLockPriority(): the highest of the locks locked, the first of equals
  private lockPriority(now: number): { priority: number; by: string | null } {
    let priority = 0;
    let by: string | null = null;
    for (const track of this.locks) {
      if (this.lockState(track, now).locked && track.config.priority > priority) {
        priority = track.config.priority;
        by = track.config.name;
      }
    }
    return { priority, by };
  }

  // hasPriority(): the highest of the inputs not masked, the first of equals,
  // above 0
  private selection(now: number, lockPriority: number): InputTrack | null {
    let priority = 0;
    let selected: InputTrack | null = null;
    for (const track of this.inputs) {
      const masked = expired(track.config.timeout, track.lastAt, now) || track.config.priority < lockPriority;
      if (!masked && track.config.priority > priority) {
        priority = track.config.priority;
        selected = track;
      }
    }
    return selected;
  }

  input(name: string, message: unknown, now: number): void {
    const track = this.inputs.find((t) => t.config.name === name);
    const command = track?.type ? commandOf(message, track.type) : null;
    if (!track || !command) {
      return;
    }
    track.lastAt = now;
    track.twist = command.twist;
    addTime(track.times, now);
    const arrival: Arrival = {
      at: now,
      key: command.key,
      full: command.full,
      predicted: this.predict(track, now),
      provisional: this.warmingUp(now),
      shown: false,
    };
    track.arrivals.push(arrival);
    // Its output may have come first: with its header if the mux forwards it
    const { unmatched } = this.output;
    const recent = (u: (typeof unmatched)[number]) => u.key === command.key && now - u.at <= DECIDE_MS;
    let index = unmatched.findIndex((u) => recent(u) && u.full === command.full);
    if (index < 0) {
      index = unmatched.findIndex(recent);
    }
    if (index >= 0) {
      const [shown] = this.output.unmatched.splice(index, 1);
      this.show(track, arrival, shown.at);
    }
  }

  // What twist_mux does with the input's message that came at `at`: an input
  // heard of only after counts as publishing then
  private predict(track: InputTrack, at: number): MuxFate {
    if (!this.found) {
      return 'dropped';
    }
    const { priority } = this.lockPriority(at);
    return this.selection(at, priority) === track ? 'passed' : track.config.priority < priority ? 'locked' : 'outranked';
  }

  lock(name: string, message: unknown, now: number): void {
    const track = this.locks.find((t) => t.config.name === name);
    if (!track) {
      return;
    }
    const data = (message as { data?: unknown } | null)?.data === true;
    track.lastAt = now;
    track.value = data;
    track.flow[data ? 'on' : 'off']++;
  }

  outputMessage(message: unknown, now: number): void {
    const type = this.outType;
    const command = type ? commandOf(message, type) : null;
    if (!command) {
      return;
    }
    const output = this.output;
    if (output.subscribedAt !== null) {
      output.firstAt ??= now;
    }
    output.lastAt = now;
    output.twist = command.twist;
    addTime(output.times, now);
    // The input's message it is, of those not shown yet with its values: the
    // one with its header too, else the one that should pass, else the latest
    let found: { track: InputTrack; arrival: Arrival; rank: number[] } | null = null;
    for (const track of this.inputs) {
      for (const arrival of track.arrivals) {
        if (arrival.shown || arrival.key !== command.key) {
          continue;
        }
        const rank = [arrival.full === command.full ? 1 : 0, arrival.predicted === 'passed' ? 1 : 0, arrival.at];
        // Of equals, the later
        if (!found || !betterRank(found.rank, rank)) {
          found = { track, arrival, rank };
        }
      }
    }
    if (found) {
      this.show(found.track, found.arrival, now);
    } else {
      // Another publisher's, unless its input's comes after it
      output.source = null;
      output.unmatched.push({ at: now, key: command.key, full: command.full });
    }
  }

  private show(track: InputTrack, arrival: Arrival, outputAt: number): void {
    arrival.shown = true;
    const { flow } = this.output;
    flow.inputs[track.config.name] = (flow.inputs[track.config.name] ?? 0) + 1;
    if (outputAt === this.output.lastAt) {
      this.output.source = track.config.name;
    }
    if (!this.output.shown || outputAt >= this.output.shown.at) {
      this.output.shown = { name: track.config.name, at: outputAt };
    }
  }

  // What became of a message: what the output showed, else what twist_mux
  // should have done. Once the output shows what the mux forwards (it had a
  // message, or discovery is long done), one that should have passed and did
  // not was outranked, if another input's messages passed meanwhile (the
  // dashboard had not heard of it yet), else dropped.
  private fate(track: InputTrack, arrival: Arrival): MuxFate {
    if (arrival.shown) {
      return 'passed';
    }
    const { subscribedAt, firstAt, shown } = this.output;
    if (arrival.predicted !== 'passed') {
      return arrival.predicted;
    }
    if (shown && shown.name !== track.config.name && Math.abs(shown.at - arrival.at) <= OUTRANKED_MS) {
      return 'outranked';
    }
    const trusted =
      subscribedAt !== null && (arrival.at - subscribedAt >= OUTPUT_READY_MS || (firstAt !== null && arrival.at >= firstAt));
    return trusted ? 'dropped' : 'passed';
  }

  // Just subscribed, or just followed: see WARMUP_MS and DIAGNOSTICS_WAIT_MS
  warmingUp(now: number): boolean {
    const { subscribedAt, firstAt } = this.output;
    if (subscribedAt !== null && firstAt === null && now - subscribedAt < WARMUP_MS) {
      return true;
    }
    return (
      this.found &&
      this.status === null &&
      now - this.startedAt < DIAGNOSTICS_WAIT_MS &&
      this.locks.some((track) => track.value === null)
    );
  }

  // The state now. take: with the messages decided since the last time
  // (else none), for every page at once.
  snapshot(now: number, take: boolean): TwistMuxState {
    const { priority: lockPriority, by: lockedBy } = this.lockPriority(now);
    const selected = this.found ? this.selection(now, lockPriority) : null;
    const config = this.config;
    const publishers = (topic: string | null) => (topic ? (this.graph.publishers.get(topic) ?? []) : []);
    // What does not reach the mux on the topic: as it subscribes to it
    const graphError = (topic: string): string => {
      if (!this.found || this.graph.subscriptions.size === 0) {
        return '';
      }
      const takes = this.graph.subscriptions.get(topic);
      if (!takes) {
        return `${this.node} does not subscribe to ${topic}: remapped?`;
      }
      const others = publishers(topic).filter((p) => !takes.includes(p.type));
      return others.length > 0
        ? `${others.map((p) => p.node).join(', ')} publish${others.length === 1 ? 'es' : ''} ${others[0].type}, which ${this.node} does not take on ${topic}: it takes ${takes.join(', ')}`
        : '';
    };

    const warming = this.warmingUp(now);
    const inputs: MuxInput[] = this.inputs.map((track) => {
      const flow = emptyFlow();
      if (take && !warming) {
        track.arrivals = track.arrivals.filter((arrival) => {
          if (!arrival.shown && now - arrival.at < DECIDE_MS) {
            return true;
          }
          if (arrival.provisional) {
            arrival.predicted = this.predict(track, arrival.at);
          }
          flow[this.fate(track, arrival)]++;
          return false;
        });
      }
      const timedOut = expired(track.config.timeout, track.lastAt, now);
      return {
        name: track.config.name,
        topic: track.topic,
        timeout: track.config.timeout,
        priority: track.config.priority,
        publishers: publishers(track.topic).map((p) => p.node),
        lastAt: track.lastAt,
        rate: rateOf(track.times, now),
        twist: track.twist,
        expired: timedOut,
        masked: timedOut || track.config.priority < lockPriority,
        selected: track === selected,
        flow,
        error: track.subscribeError || graphError(track.topic),
      };
    });

    const locks: MuxLock[] = this.locks.map((track) => {
      const flow = take ? track.flow : { on: 0, off: 0 };
      if (take) {
        track.flow = { on: 0, off: 0 };
      }
      return {
        name: track.config.name,
        topic: track.topic,
        timeout: track.config.timeout,
        priority: track.config.priority,
        publishers: publishers(track.topic).map((p) => p.node),
        lastAt: track.lastAt,
        value: track.value,
        ...this.lockState(track, now),
        flow,
        error: track.subscribeError || graphError(track.topic),
      };
    });

    const track = this.output;
    let flow: MuxOutput['flow'] = { inputs: {}, other: 0 };
    if (take) {
      track.unmatched = track.unmatched.filter((u) => {
        if (now - u.at < DECIDE_MS) {
          return true;
        }
        track.flow.other++;
        if (u.at === track.lastAt) {
          track.source = null;
        }
        return false;
      });
      flow = track.flow;
      track.flow = { inputs: {}, other: 0 };
    }
    const output: MuxOutput = {
      topic: track.topic,
      publishers: publishers(track.topic)
        .map((p) => p.node)
        .filter((node) => node !== this.node),
      lastAt: track.lastAt,
      rate: rateOf(track.times, now),
      twist: track.twist,
      source: track.source,
      flow,
      error:
        track.subscribeError ||
        (this.found && this.graph.publications.size > 0 && !track.topic
          ? `${this.node} publishes no Twist nor TwistStamped`
          : ''),
    };

    const problems = [...(config?.problems ?? [])];
    if (config && config.inputs.length === 0) {
      problems.push(`${this.node} has no input topics (its topics.* parameters)`);
    }
    if (!config && this.found && this.parametersError) {
      problems.push(this.parametersError);
    }
    return {
      node: this.node,
      self: this.self,
      found: this.found,
      inputType: this.inputType,
      outputType: this.outType,
      configFrom: this.status ? 'diagnostics' : this.fromParameters ? 'parameters' : null,
      inputs,
      locks,
      output,
      lockPriority,
      lockedBy,
      selected: selected?.config.name ?? null,
      diagnostics: this.status?.diagnostics ?? null,
      problems,
      // twist_mux.ts's
      relay: null,
      time: now,
    };
  }
}
