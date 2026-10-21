// What a monitor widget publishes (ros2 topic pub), by topic: it goes on
// while other topics are shown, as a terminal running ros2 topic pub would,
// until stopped or the widget goes.

import type { PublishState } from '../../../shared/monitor.ts';
import { connection, type TopicPublishOptions } from '../../connection.ts';

export interface Publishing {
  topic: string;
  // Until stopped (rate, times 0)
  continuous: boolean;
  state: PublishState;
}

export class Publishings {
  private publishing = new Map<string, Publishing>();
  private readonly stops = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  // Of the latest, for useSyncExternalStore
  private snapshot: Publishing[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  list = (): Publishing[] => this.snapshot;

  get(topic: string): Publishing | undefined {
    return this.publishing.get(topic);
  }

  start(options: TopicPublishOptions): void {
    this.stop(options.topic);
    const topic = options.topic;
    const continuous = options.rate > 0 && options.times === 0;
    this.set(topic, { topic, continuous, state: { count: 0, done: false, error: null } });
    const unsubscribe = connection.publishTopic(options, (state) => {
      this.set(topic, { topic, continuous, state });
      if (state.done) {
        this.stops.delete(topic);
      }
    });
    this.stops.set(topic, unsubscribe);
  }

  // Keeps its count, done
  stop(topic: string): void {
    const stop = this.stops.get(topic);
    if (!stop) {
      return;
    }
    stop();
    this.stops.delete(topic);
    const known = this.publishing.get(topic);
    if (known) {
      this.set(topic, { ...known, state: { ...known.state, done: true } });
    }
  }

  // Of those done, forgets them
  forget(topic: string): void {
    if (!this.stops.has(topic) && this.publishing.delete(topic)) {
      this.changed();
    }
  }

  stopAll(): void {
    for (const stop of this.stops.values()) {
      stop();
    }
    this.stops.clear();
  }

  private set(topic: string, publishing: Publishing): void {
    this.publishing = new Map(this.publishing).set(topic, publishing);
    this.changed();
  }

  private changed(): void {
    this.snapshot = [...this.publishing.values()];
    this.listeners.forEach((listener) => listener());
  }
}
