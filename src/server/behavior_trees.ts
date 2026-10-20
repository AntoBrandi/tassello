// The logs of behavior trees (nav2_msgs/msg/BehaviorTreeLog), for the
// behavior tree inspector widgets: the tree a widget names (its XML file, see
// behavior_tree_file.ts) and what its nodes are doing (behavior_tree_state.ts).
//
// A log is a stream of transitions, not of states: none of them may be lost,
// unlike the latest-only messages of topics.ts. Each topic is subscribed once,
// with its publishers' QoS and a deep queue; each tree of it keeps its nodes'
// state, sent to its pages as it changes, at most BT_RATE a second. The state
// outlives its last page for LINGER_MS: a page reloaded, or a panel shown
// again, finds the nodes as they are, which the log only says when they change.
//
// A topic is recorded into a rosbag (ros2 bag record) when a page asks, until
// one asks to stop: every page following it is told. A bag is played back for
// the page that opens it (behavior_tree_playback.ts).

import { promises as fs } from 'node:fs';

import type rclnodejs from 'rclnodejs';

import { BT_RATE, type BehaviorTreeRecording, type BehaviorTreeUpdate } from '../shared/protocol.ts';
import { readTree, type TreeInfo } from './behavior_tree_file.ts';
import { logTransitions, type LogTransition } from './behavior_tree_log.ts';
import { BehaviorTreePlayback, type PlaybackWatcher } from './behavior_tree_playback.ts';
import { BehaviorTreeState } from './behavior_tree_state.ts';
import type { StreamState } from './frame_stream.ts';
import { publishersQos } from './qos.ts';
import { BagRecorder, newBagFolder } from './rosbag.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

// How often the graph is checked for the topic's publishers, until it has one
const RETRY_PERIOD_MS = 1000;
// Messages queued while the server is busy: a tree logs bursts of them
const QUEUE_DEPTH = 100;
const LINGER_MS = 10 * 60_000;
// How often the tree's files are checked for changes, while watched
const FILE_CHECK_MS = 3000;

export type RecordingInfo = BehaviorTreeRecording['recording'];

export interface BehaviorTreeWatcher {
  onStatus: (state: StreamState, message: string) => void;
  onTree: (tree: TreeInfo) => void;
  onUpdate: (update: Omit<BehaviorTreeUpdate, 'type' | 'id'>) => void;
  onRecording: (recording: RecordingInfo) => void;
}

interface Listener {
  onStatus: (state: StreamState, message: string) => void;
  onTransitions: (transitions: LogTransition[]) => void;
}

// The subscription to a topic, shared by its trees
class LogTopic {
  readonly listeners = new Set<Listener>();
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly topic: string;
  private subscription: rclnodejs.Subscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private state: StreamState = 'waiting';
  private message = '';

  constructor(node: rclnodejs.Node, logger: Logger, topic: string) {
    this.node = node;
    this.logger = logger;
    this.topic = topic;
    this.subscribe();
  }

  add(listener: Listener): void {
    this.listeners.add(listener);
    listener.onStatus(this.state, this.message);
  }

  destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.subscription) {
      this.node.destroySubscription(this.subscription);
    }
  }

  private subscribe(): void {
    this.retryTimer = null;
    const match = publishersQos(this.node, this.topic, null, QUEUE_DEPTH);
    if (!('qos' in match)) {
      this.setState(match.state, match.message);
      this.retryTimer = setTimeout(() => this.subscribe(), RETRY_PERIOD_MS);
      return;
    }
    try {
      this.subscription = this.node.createSubscription(
        // @ts-expect-error: the type is a runtime string, not one of the literal types
        match.type,
        this.topic,
        { qos: match.qos },
        (raw: unknown) => this.onMessage(raw, match.type),
      );
    } catch (e) {
      this.setState('error', `Cannot subscribe to ${this.topic}: ${errorMessage(e)}`);
      return;
    }
    this.setState('waiting', `Waiting for transitions on ${this.topic}`);
  }

  private onMessage(raw: unknown, type: string): void {
    let transitions: LogTransition[];
    try {
      transitions = logTransitions(raw);
    } catch (e) {
      this.setState('error', `${this.topic} is a ${type}, ${errorMessage(e)}`);
      return;
    }
    this.setState('streaming', type);
    for (const listener of this.listeners) {
      listener.onTransitions(transitions);
    }
  }

  private setState(state: StreamState, message: string): void {
    if (state === this.state && message === this.message) {
      return;
    }
    if (state === 'error') {
      this.logger.warn(message);
    }
    this.state = state;
    this.message = message;
    for (const listener of this.listeners) {
      listener.onStatus(state, message);
    }
  }
}

// A tree of a topic: its file, its nodes' state, its pages
class TreeMonitor implements Listener {
  readonly watchers = new Set<BehaviorTreeWatcher>();
  lingerTimer: NodeJS.Timeout | null = null;
  private readonly source: string;
  private readonly uploadsDir: string;
  private readonly logger: Logger;
  private tree: TreeInfo | null = null;
  private recording: RecordingInfo;
  private state = new BehaviorTreeState([]);
  // Transitions that came while the tree was read, applied after
  private queued: { transitions: LogTransition[]; at: number }[] | null = [];
  // The files read, and their versions then
  private versions = new Map<string, string>();
  private status: { state: StreamState; message: string } = { state: 'waiting', message: '' };
  private flushTimer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  private fileTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(source: string, uploadsDir: string, logger: Logger, recording: RecordingInfo) {
    this.source = source;
    this.uploadsDir = uploadsDir;
    this.logger = logger;
    this.recording = recording;
    void this.load();
  }

  add(watcher: BehaviorTreeWatcher): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    // What the others have not had yet, which the new one gets with the rest
    this.flush();
    this.watchers.add(watcher);
    watcher.onStatus(this.status.state, this.status.message);
    watcher.onRecording(this.recording);
    if (this.tree) {
      watcher.onTree(this.tree);
      watcher.onUpdate({ reset: true, ...this.state.snapshot() });
    }
    this.fileTimer ??= setInterval(() => void this.checkFiles(), FILE_CHECK_MS);
  }

  remove(watcher: BehaviorTreeWatcher): void {
    this.watchers.delete(watcher);
    if (this.watchers.size === 0 && this.fileTimer) {
      clearInterval(this.fileTimer);
      this.fileTimer = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of [this.flushTimer, this.lingerTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (this.fileTimer) {
      clearInterval(this.fileTimer);
    }
  }

  setRecording(recording: RecordingInfo): void {
    this.recording = recording;
    for (const watcher of this.watchers) {
      watcher.onRecording(recording);
    }
  }

  onStatus(state: StreamState, message: string): void {
    this.status = { state, message };
    for (const watcher of this.watchers) {
      watcher.onStatus(state, message);
    }
  }

  onTransitions(transitions: LogTransition[]): void {
    const now = Date.now();
    if (this.queued) {
      this.queued.push({ transitions, at: now });
      return;
    }
    for (const transition of transitions) {
      this.state.apply(transition, now);
    }
    this.scheduleFlush();
  }

  private async load(): Promise<void> {
    const { tree, files } = await readTree(this.source, this.uploadsDir, this.logger);
    if (this.destroyed) {
      return;
    }
    this.versions = new Map(await Promise.all(files.map(async (file) => [file, await version(file)] as const)));
    this.tree = tree;
    this.state = new BehaviorTreeState(tree.nodes);
    for (const { transitions, at } of this.queued ?? []) {
      for (const transition of transitions) {
        this.state.apply(transition, at);
      }
    }
    this.queued = null;
    for (const watcher of this.watchers) {
      watcher.onTree(tree);
      watcher.onUpdate({ reset: true, ...this.state.snapshot() });
    }
  }

  // The tree is read again when one of its files changed: its pages start over
  private async checkFiles(): Promise<void> {
    if (this.queued || this.versions.size === 0) {
      return;
    }
    for (const [file, known] of this.versions) {
      if ((await version(file)) !== known) {
        this.queued = [];
        await this.load();
        return;
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.watchers.size === 0) {
      return;
    }
    const wait = Math.max(0, this.lastFlush + 1000 / BT_RATE - Date.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlush = Date.now();
    const changes = this.state.takeChanges();
    if (!changes) {
      return;
    }
    for (const watcher of this.watchers) {
      watcher.onUpdate({ reset: false, ...changes });
    }
  }
}

// Size and time of a file, '' if gone
async function version(file: string): Promise<string> {
  const stat = await fs.stat(file).catch(() => null);
  return stat ? `${stat.size}-${stat.mtimeMs}` : '';
}

interface Recording {
  path: string;
  since: number;
  // null while it starts
  recorder: BagRecorder | null;
}

export class BehaviorTrees {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly uploadsDir: string;
  private readonly topics = new Map<string, LogTopic>();
  // By topic, then tree source
  private readonly monitors = new Map<string, Map<string, TreeMonitor>>();
  // By topic
  private readonly recordings = new Map<string, Recording>();

  constructor(node: rclnodejs.Node, logger: Logger, uploadsDir: string) {
    this.node = node;
    this.logger = logger;
    this.uploadsDir = uploadsDir;
  }

  // Until the returned function is called
  watch(topic: string, tree: string, watcher: BehaviorTreeWatcher): () => void {
    const name = absoluteTopic(topic);
    const source = tree.trim();
    let trees = this.monitors.get(name);
    if (!trees) {
      trees = new Map();
      this.monitors.set(name, trees);
    }
    let monitor = trees.get(source);
    if (!monitor) {
      monitor = new TreeMonitor(source, this.uploadsDir, this.logger, this.recordingOf(name));
      trees.set(source, monitor);
      let log = this.topics.get(name);
      if (!log) {
        log = new LogTopic(this.node, this.logger, name);
        this.topics.set(name, log);
      }
      log.add(monitor);
    }
    const shared = monitor;
    shared.add(watcher);
    return () => {
      shared.remove(watcher);
      if (shared.watchers.size === 0 && !shared.lingerTimer) {
        shared.lingerTimer = setTimeout(() => this.forget(name, source, shared), LINGER_MS);
      }
    };
  }

  // Records the topic into a new folder, or stops (path null): resolves with
  // the bag's folder, null if it was not recording
  async record(topic: string, path: string | null): Promise<string | null> {
    const name = absoluteTopic(topic);
    const current = this.recordings.get(name);
    if (path === null) {
      if (!current?.recorder) {
        return null;
      }
      this.recordings.delete(name);
      this.announce(name);
      await current.recorder.stop();
      this.logger.info(`Recorded ${name} into ${current.path}`);
      return current.path;
    }
    if (current) {
      throw new Error(`${name} is being recorded already, into ${current.path}`);
    }
    const recording: Recording = { path: '', since: 0, recorder: null };
    this.recordings.set(name, recording);
    try {
      recording.path = await newBagFolder(path);
      recording.recorder = await BagRecorder.start(recording.path, [name]);
    } catch (e) {
      this.recordings.delete(name);
      throw new Error(`Cannot record ${name}: ${errorMessage(e)}`);
    }
    recording.since = Date.now();
    recording.recorder.onExit = (reason) => {
      if (this.recordings.get(name) === recording) {
        this.recordings.delete(name);
        this.announce(name);
        this.logger.warn(`Recording ${name} stopped: ${reason}`);
      }
    };
    this.logger.info(`Recording ${name} into ${recording.path}`);
    this.announce(name);
    return recording.path;
  }

  // A bag played back for a page, until closed
  play(bag: string, topic: string, tree: string, watcher: PlaybackWatcher): BehaviorTreePlayback {
    return new BehaviorTreePlayback({ bag, topic, tree: tree.trim(), uploadsDir: this.uploadsDir, logger: this.logger }, watcher);
  }

  // The recordings completed, as the server stops
  async stopAll(): Promise<void> {
    const recorders = [...this.recordings.values()].flatMap((recording) => recording.recorder ?? []);
    this.recordings.clear();
    await Promise.all(recorders.map((recorder) => recorder.stop()));
  }

  private recordingOf(topic: string): RecordingInfo {
    const recording = this.recordings.get(topic);
    return recording?.recorder ? { path: recording.path, since: recording.since } : null;
  }

  private announce(topic: string): void {
    for (const monitor of this.monitors.get(topic)?.values() ?? []) {
      monitor.setRecording(this.recordingOf(topic));
    }
  }

  private forget(topic: string, source: string, monitor: TreeMonitor): void {
    monitor.destroy();
    const trees = this.monitors.get(topic);
    trees?.delete(source);
    const log = this.topics.get(topic);
    log?.listeners.delete(monitor);
    if (trees?.size === 0) {
      this.monitors.delete(topic);
      log?.destroy();
      this.topics.delete(topic);
    }
  }
}
