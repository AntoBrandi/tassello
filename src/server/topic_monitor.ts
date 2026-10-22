// Topics followed for the monitor widgets: ros2 topic hz, bw, delay and echo
// at once. One subscription per topic, with its publishers' QoS, shared by
// its pages, taking the messages serialized (rclnodejs's raw subscriptions):
// their size is exact, a header's stamp is read from the bytes, and only the
// messages echoed are deserialized, at most ECHO_RATE a second for each page,
// but for those of a topic a page plots: all of them, whose numbers at the
// page's fields it gets every SAMPLES_PERIOD_MS. Each page gets the figures
// of its own window (ros2 topic hz --window) twice a second while messages
// come.

import { performance } from 'node:perf_hooks';

import rclnodejs from 'rclnodejs';

import {
  ECHO_RATE,
  MAX_SAMPLED_FIELDS,
  MAX_TRUNCATE,
  MAX_WINDOW,
  SAMPLES_PERIOD_MS,
  type TopicEcho,
  type TopicSamples,
  type TopicStats,
} from '../shared/monitor.ts';
import type { StreamState } from './frame_stream.ts';
import type { Interfaces } from './interfaces.ts';
import { missingCodeHint } from './message_code.ts';
import { echoJson, fieldAt, sampleValue } from './message_format.ts';
import { publishersQos } from './qos.ts';
import { headerStamp, TopicStatsWindow } from './topic_stats.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

// How often the graph is checked for the topic's publishers, until it has one
const RETRY_PERIOD_MS = 1000;
const STATS_PERIOD_MS = 500;
// Of the subscription: messages that come in bursts are all counted
const QUEUE_DEPTH = 10;

export interface MonitorOptions {
  // Messages the figures are of
  window: number;
  // Messages echoed: their field at this path (all of them: ''), lists and
  // strings cut to truncate items; null: none
  echo: { field: string; truncate: number } | null;
  // Fields whose numbers (see sampleValue) every message gives; null: none
  samples: string[] | null;
}

export interface MonitorWatcher extends MonitorOptions {
  onStatus: (state: StreamState, message: string) => void;
  onStats: (stats: TopicStats) => void;
  onEcho: (echo: TopicEcho) => void;
  onSamples: (samples: TopicSamples) => void;
}

// rclnodejs's generated message classes, and their instances
interface RosMessage {
  readonly refObject: unknown;
  deserialize(refObject: unknown): void;
  toPlainObject(typedArrays: boolean): unknown;
}

interface MessageClass {
  new (): RosMessage;
  destroyRawROS(message: RosMessage): void;
}

interface Delivery {
  // The count of messages when the page started following the topic
  since: number;
  // The count of messages of the figures and the echo last sent
  statsCount: number;
  echoCount: number;
  echoAt: number;
  timer: NodeJS.Timeout | null;
  // Those of the messages since the samples were last sent
  samples: TopicSamples | null;
  // Told that the messages cannot be read
  unreadable: boolean;
}

interface Latest {
  count: number;
  buffer: Buffer;
  receivedAt: number;
  // Deserialized once, when first echoed
  message: unknown;
}

class MonitoredTopic {
  readonly watchers = new Map<MonitorWatcher, Delivery>();
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly interfaces: Interfaces;
  private readonly topic: string;
  private readonly window = new TopicStatsWindow(MAX_WINDOW);
  private subscription: rclnodejs.Subscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly statsTimer: NodeJS.Timeout;
  private samplesTimer: NodeJS.Timeout | null = null;
  private type = '';
  private hasHeader = false;
  private latest: Latest | null = null;
  private state: StreamState = 'waiting';
  private message = '';

  constructor(node: rclnodejs.Node, logger: Logger, interfaces: Interfaces, topic: string) {
    this.node = node;
    this.logger = logger;
    this.interfaces = interfaces;
    this.topic = topic;
    this.statsTimer = setInterval(() => this.sendStats(), STATS_PERIOD_MS);
    this.subscribe();
  }

  add(watcher: MonitorWatcher): void {
    const delivery: Delivery = {
      since: this.window.count,
      statsCount: -1,
      echoCount: this.window.count,
      echoAt: 0,
      timer: null,
      samples: null,
      unreadable: false,
    };
    this.watchers.set(watcher, delivery);
    watcher.onStatus(this.state, this.message);
    this.sendStatsTo(watcher, delivery);
    // The latest message, if latched (a map): echoed though received before
    if (this.latest && this.latest.count === this.window.count) {
      delivery.echoCount = this.latest.count - 1;
      this.echo(watcher, delivery);
    }
    // And plotted: a battery's state, that comes once a second or less
    if (this.latest) {
      this.sample(watcher, delivery, this.latest);
    }
  }

  remove(watcher: MonitorWatcher): void {
    const delivery = this.watchers.get(watcher);
    if (delivery?.timer) {
      clearTimeout(delivery.timer);
    }
    this.watchers.delete(watcher);
  }

  destroy(): void {
    clearInterval(this.statsTimer);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.samplesTimer) {
      clearTimeout(this.samplesTimer);
    }
    for (const delivery of this.watchers.values()) {
      if (delivery.timer) {
        clearTimeout(delivery.timer);
      }
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
        { qos: match.qos, isRaw: true },
        (buffer: Buffer) => this.onMessage(buffer),
      );
    } catch (e) {
      this.setState('error', `Cannot subscribe to ${this.topic}: ${missingCodeHint(errorMessage(e))}`);
      return;
    }
    this.type = match.type;
    this.hasHeader = this.interfaces.hasHeader(match.type);
    this.setState('waiting', `Waiting for messages on ${this.topic}`);
  }

  private onMessage(buffer: Buffer): void {
    let delay: number | null = null;
    if (this.hasHeader) {
      const stamp = headerStamp(buffer);
      if (stamp !== null) {
        const now = this.interfaces.now();
        delay = now.sec - stamp + now.nanosec / 1e9;
      }
    }
    const receivedAt = Date.now();
    this.window.add(performance.now() / 1000, buffer.length, delay, receivedAt);
    const latest: Latest = { count: this.window.count, buffer, receivedAt, message: undefined };
    this.latest = latest;
    this.setState('streaming', this.type);
    for (const [watcher, delivery] of this.watchers) {
      this.echo(watcher, delivery);
      this.sample(watcher, delivery, latest);
    }
  }

  // The numbers of a message at the page's fields, sent with those of the
  // next ones
  private sample(watcher: MonitorWatcher, delivery: Delivery, latest: Latest): void {
    if (!watcher.samples) {
      return;
    }
    try {
      latest.message ??= this.deserialize(latest.buffer);
    } catch (e) {
      if (!delivery.unreadable) {
        delivery.unreadable = true;
        watcher.onStatus('error', `Cannot read the messages of ${this.topic}: ${errorMessage(e)}`);
      }
      return;
    }
    const samples = (delivery.samples ??= { at: [], values: watcher.samples.map(() => []) });
    samples.at.push(latest.receivedAt);
    watcher.samples.forEach((field, index) => samples.values[index].push(sampleValue(fieldAt(latest.message, field))));
    this.samplesTimer ??= setTimeout(() => this.sendSamples(), SAMPLES_PERIOD_MS);
  }

  private sendSamples(): void {
    this.samplesTimer = null;
    for (const [watcher, delivery] of this.watchers) {
      if (delivery.samples) {
        watcher.onSamples(delivery.samples);
        delivery.samples = null;
      }
    }
  }

  // The latest message, now or when the page's rate allows
  private echo(watcher: MonitorWatcher, delivery: Delivery): void {
    const latest = this.latest;
    if (!watcher.echo || !latest || latest.count === delivery.echoCount || delivery.timer) {
      return;
    }
    const wait = delivery.echoAt + 1000 / ECHO_RATE - Date.now();
    if (wait > 0) {
      delivery.timer = setTimeout(() => {
        delivery.timer = null;
        this.echo(watcher, delivery);
      }, wait);
      return;
    }
    delivery.echoAt = Date.now();
    delivery.echoCount = latest.count;
    try {
      latest.message ??= this.deserialize(latest.buffer);
    } catch (e) {
      watcher.onStatus('error', `Cannot read the messages of ${this.topic}: ${errorMessage(e)}`);
      return;
    }
    const { field, truncate } = watcher.echo;
    const value = field ? fieldAt(latest.message, field) : latest.message;
    watcher.onEcho({
      seq: latest.count - delivery.since,
      receivedAt: latest.receivedAt,
      size: latest.buffer.length,
      message: value === undefined ? undefined : echoJson(value, truncate),
    });
  }

  // As rclnodejs takes a message: deserializeMessage only fills its C
  // structure, which a message is then made from
  private deserialize(buffer: Buffer): unknown {
    const typeClass = rclnodejs.require(this.type) as unknown as MessageClass;
    const filled = rclnodejs.deserializeMessage(buffer, typeClass as unknown as rclnodejs.Class) as RosMessage;
    try {
      const message = new typeClass();
      message.deserialize(filled.refObject);
      return message.toPlainObject(true);
    } finally {
      typeClass.destroyRawROS(filled);
    }
  }

  private sendStats(): void {
    for (const [watcher, delivery] of this.watchers) {
      this.sendStatsTo(watcher, delivery);
    }
  }

  // Only when messages came since the last
  private sendStatsTo(watcher: MonitorWatcher, delivery: Delivery): void {
    if (delivery.statsCount === this.window.count) {
      return;
    }
    delivery.statsCount = this.window.count;
    watcher.onStats(this.window.stats(watcher.window, delivery.since));
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
    for (const watcher of this.watchers.keys()) {
      watcher.onStatus(state, message);
    }
  }
}

export class TopicMonitors {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly interfaces: Interfaces;
  private readonly topics = new Map<string, MonitoredTopic>();

  constructor(node: rclnodejs.Node, logger: Logger, interfaces: Interfaces) {
    this.node = node;
    this.logger = logger;
    this.interfaces = interfaces;
  }

  // Until the returned function is called
  watch(topic: string, watcher: MonitorWatcher): () => void {
    const name = absoluteTopic(topic);
    const options: MonitorWatcher = {
      ...watcher,
      window: Math.round(Math.min(MAX_WINDOW, Math.max(2, watcher.window))),
      echo: watcher.echo && {
        field: watcher.echo.field.trim(),
        truncate: Math.round(Math.min(MAX_TRUNCATE, Math.max(1, watcher.echo.truncate))),
      },
      samples: watcher.samples?.length ? watcher.samples.slice(0, MAX_SAMPLED_FIELDS) : null,
    };
    let monitored = this.topics.get(name);
    if (!monitored) {
      monitored = new MonitoredTopic(this.node, this.logger, this.interfaces, name);
      this.topics.set(name, monitored);
    }
    const shared = monitored;
    shared.add(options);
    return () => {
      shared.remove(options);
      if (shared.watchers.size === 0) {
        shared.destroy();
        this.topics.delete(name);
      }
    };
  }
}
