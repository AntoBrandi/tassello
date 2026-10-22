// A rosbag of a behavior tree's log played back for one page, as the live log
// would be (behavior_trees.ts): its transitions applied, on the bag's clock,
// to a state of their own, sent as they change; at the page's speed, from
// where it seeks. Read whole when opened: logs are small, and seeking back
// replays them from the start.

import { BT_RATE, type BehaviorTreePlaybackState, type BtNode } from '../shared/protocol.ts';
import { readTree } from './behavior_tree_file.ts';
import { decodeLog, logLayout, type LogTransition } from './behavior_tree_log.ts';
import { BehaviorTreeState } from './behavior_tree_state.ts';
import type { BehaviorTreeWatcher } from './behavior_trees.ts';
import { openBag, readBag } from './rosbag.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const TICK_MS = 50;
// How often the page is told where the playback is, while playing
const STATE_MS = 250;
const MIN_SPEED = 0.05;
const MAX_SPEED = 64;
// Beyond them, the bag is too long to play whole
const MAX_TRANSITIONS = 2_000_000;

export type PlaybackState = Omit<BehaviorTreePlaybackState, 'type' | 'id'>;

export type PlaybackWatcher = Omit<BehaviorTreeWatcher, 'onRecording'> & {
  onPlayback: (state: PlaybackState) => void;
};

export interface PlaybackOptions {
  bag: string;
  // The log's topic in the bag, if it has several
  topic: string;
  tree: string;
  uploadsDir: string;
  logger: Logger;
}

// A message's transitions, and when it was recorded (ms since the epoch)
interface Timed {
  time: number;
  transitions: LogTransition[];
}

// The bag's log: of the topic if it has it, else its first
export async function readLog(bag: string, topic: string): Promise<{ topic: string; messages: Timed[] }> {
  const logs = await readBag(await openBag(bag), (t) => /\/BehaviorTreeLog$/.test(t.type));
  const found = (topic && logs.get(absoluteTopic(topic))) || [...logs.values()][0];
  if (!found) {
    throw new Error(`No behavior tree log in ${bag}: no nav2_msgs/msg/BehaviorTreeLog topic`);
  }
  const uids = logLayout(found.messages.map((message) => message.data));
  if (uids === null) {
    throw new Error(`No transition in ${bag}, of ${found.topic.name}`);
  }
  const messages: Timed[] = [];
  let count = 0;
  for (const { time, data } of found.messages) {
    let transitions: LogTransition[];
    try {
      transitions = decodeLog(data, uids);
    } catch {
      continue;
    }
    count += transitions.length;
    if (count > MAX_TRANSITIONS) {
      throw new Error(`${bag} is too long to play: more than ${MAX_TRANSITIONS} transitions`);
    }
    messages.push({ time, transitions });
  }
  return { topic: found.topic.name, messages };
}

export class BehaviorTreePlayback {
  private readonly watcher: PlaybackWatcher;
  private nodes: BtNode[] = [];
  private messages: Timed[] = [];
  private state = new BehaviorTreeState([]);
  // The next message to apply
  private next = 0;
  private topic = '';
  private start = 0;
  private end = 0;
  private time = 0;
  private playing = false;
  private speed = 1;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private lastFlush = 0;
  private lastState = 0;
  private closed = false;

  constructor(options: PlaybackOptions, watcher: PlaybackWatcher) {
    this.watcher = watcher;
    void this.open(options);
  }

  // What the page asks: any of them
  control({ playing, speed, time }: { playing?: boolean; speed?: number; time?: number }): void {
    if (this.messages.length === 0) {
      return;
    }
    if (speed !== undefined && Number.isFinite(speed)) {
      this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
    }
    if (time !== undefined && Number.isFinite(time)) {
      this.seek(time);
    }
    if (playing !== undefined) {
      // From the start again, once at the end
      if (playing && this.time >= this.end) {
        this.seek(this.start);
      }
      this.playing = playing;
      if (playing && !this.timer) {
        this.lastTick = Date.now();
        this.timer = setInterval(() => this.tick(), TICK_MS);
      } else if (!playing) {
        this.stopTimer();
      }
    }
    this.sendState();
  }

  close(): void {
    this.closed = true;
    this.stopTimer();
  }

  private async open({ bag, topic, tree: source, uploadsDir, logger }: PlaybackOptions): Promise<void> {
    this.watcher.onStatus('waiting', `Reading ${bag}…`);
    const [{ tree }, log] = await Promise.all([
      readTree(source, uploadsDir, logger),
      readLog(bag, topic).catch((e: unknown) => new Error(errorMessage(e))),
    ]);
    if (this.closed) {
      return;
    }
    this.nodes = tree.nodes;
    this.state = new BehaviorTreeState(this.nodes);
    this.watcher.onTree(tree);
    if (log instanceof Error) {
      this.error = log.message;
      this.watcher.onStatus('error', log.message);
      this.watcher.onUpdate({ reset: true, ...this.state.snapshot() });
      this.sendState();
      return;
    }
    this.topic = log.topic;
    this.messages = log.messages;
    this.start = this.messages[0]?.time ?? 0;
    this.end = this.messages.at(-1)?.time ?? 0;
    this.time = this.start;
    this.watcher.onStatus('streaming', `Playing ${bag}`);
    this.seek(this.start);
    this.control({ playing: true });
  }

  private tick(): void {
    const now = Date.now();
    this.time = Math.min(this.end, this.time + (now - this.lastTick) * this.speed);
    this.lastTick = now;
    this.advance();
    if (this.time >= this.end) {
      this.playing = false;
      this.stopTimer();
      this.flush();
      this.sendState();
      return;
    }
    if (now - this.lastFlush >= 1000 / BT_RATE) {
      this.flush();
    }
    if (now - this.lastState >= STATE_MS) {
      this.sendState();
    }
  }

  // The messages recorded until the playback's time
  private advance(): void {
    while (this.next < this.messages.length && this.messages[this.next].time <= this.time) {
      const { time, transitions } = this.messages[this.next++];
      for (const transition of transitions) {
        this.state.apply(transition, time);
      }
    }
  }

  // Back: the state again from the start. The page gets it whole.
  private seek(time: number): void {
    const target = Math.min(this.end, Math.max(this.start, time));
    if (target < this.time) {
      this.state = new BehaviorTreeState(this.nodes);
      this.next = 0;
    }
    this.time = target;
    this.advance();
    this.watcher.onUpdate({ reset: true, ...this.state.snapshot() });
    this.lastFlush = Date.now();
  }

  private flush(): void {
    this.lastFlush = Date.now();
    const changes = this.state.takeChanges();
    if (changes) {
      this.watcher.onUpdate({ reset: false, ...changes });
    }
  }

  private sendState(): void {
    this.lastState = Date.now();
    const { topic, start, end, time, playing, speed, error } = this;
    this.watcher.onPlayback({ topic, start, end, time, playing, speed, error });
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
