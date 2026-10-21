// ros2 topic pub for the monitor widgets: a message published once, a number
// of times or until stopped, at a rate, with the QoS asked for ("auto" matches
// the topic's subscriptions), made anew from its JSON for each message so that
// its "now" is now. Publishers are kept, shared by the pages: a first message
// on a new one is often lost to discovery, which it waits for.

import rclnodejs from 'rclnodejs';

import type { PublishQos, PublishState } from '../shared/monitor.ts';
import type { Interfaces } from './interfaces.ts';
import { interfaceType } from './ros.ts';
import { absoluteTopic, errorMessage } from './util.ts';

// Those not publishing go, the oldest first, beyond this many
const MAX_PUBLISHERS = 32;
// How long a new publisher waits for the topic's subscriptions to match it
// before its first message
const MATCH_TIMEOUT_MS = 1000;
const MATCH_POLL_MS = 50;
// A publishing's count is reported at most this often
const STATE_PERIOD_MS = 250;
const MAX_RATE = 1000;

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

interface Publisher {
  publish(message: unknown): void;
  readonly subscriptionCount: number;
}

export interface PublishRequest {
  topic: string;
  messageType: string;
  // JSON, as the page sends it (see Interfaces.message)
  message: unknown;
  // Messages a second; 0: once
  rate: number;
  // How many; 0: until stopped
  times: number;
  qos: PublishQos;
}

export class TopicPublishing {
  private readonly node: rclnodejs.Node;
  private readonly interfaces: Interfaces;
  // By type, topic and QoS: the latest used last
  private readonly publishers = new Map<string, { publisher: Publisher; users: number }>();

  constructor(node: rclnodejs.Node, interfaces: Interfaces) {
    this.node = node;
    this.interfaces = interfaces;
  }

  // Until done or the returned function is called, with its count of
  // messages published as it goes
  publish(request: PublishRequest, onState: (state: PublishState) => void): () => void {
    const topic = absoluteTopic(request.topic);
    const rate = Math.min(MAX_RATE, Math.max(0, request.rate));
    const times = rate === 0 ? 1 : Math.max(0, Math.round(request.times));
    let count = 0;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let reportTimer: NodeJS.Timeout | null = null;
    let reportedAt = 0;
    let entry: { publisher: Publisher; users: number } | null = null;
    let type = '';

    const report = (done: boolean, error: string | null = null) => {
      if (reportTimer) {
        clearTimeout(reportTimer);
        reportTimer = null;
      }
      reportedAt = Date.now();
      onState({ count, done, error });
    };
    const finish = (error: string | null = null) => {
      if (stopped) {
        return;
      }
      stop();
      report(true, error);
    };
    const stop = () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      if (reportTimer) {
        clearTimeout(reportTimer);
      }
      if (entry) {
        entry.users--;
        entry = null;
      }
    };
    const tick = () => {
      if (stopped || !entry) {
        return;
      }
      try {
        entry.publisher.publish(this.interfaces.message(type, request.message));
      } catch (e) {
        finish(errorMessage(e));
        return;
      }
      count++;
      if (times > 0 && count >= times) {
        finish();
      } else if (!reportTimer) {
        reportTimer = setTimeout(() => report(false), Math.max(0, reportedAt + STATE_PERIOD_MS - Date.now()));
      }
    };

    (async () => {
      type = interfaceType(request.messageType, 'msg');
      // Refused at once, before any publisher
      this.interfaces.message(type, request.message);
      const { publisher, fresh } = this.publisher(type, topic, request.qos);
      entry = publisher;
      entry.users++;
      if (fresh) {
        await this.matched(entry.publisher, topic);
      }
      if (stopped) {
        return;
      }
      report(false);
      tick();
      if (!stopped && rate > 0) {
        timer = setInterval(tick, 1000 / rate);
      }
    })().catch((e: unknown) => finish(errorMessage(e)));

    return stop;
  }

  private publisher(
    type: string,
    topic: string,
    qos: PublishQos,
  ): { publisher: { publisher: Publisher; users: number }; fresh: boolean } {
    const reliable = qos.reliability !== 'best_effort';
    const latched =
      qos.durability === 'transient_local' ||
      (qos.durability === 'auto' &&
        (this.node.getSubscriptionsInfoByTopic(topic, false) as { qos_profile: { durability: number } }[]).some(
          (s) => s.qos_profile.durability === DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL,
        ));
    const depth = Math.round(Math.min(1000, Math.max(1, qos.depth || 10)));
    const key = `${type} ${topic} ${reliable} ${latched} ${depth}`;
    const known = this.publishers.get(key);
    if (known) {
      // The latest used last
      this.publishers.delete(key);
      this.publishers.set(key, known);
      return { publisher: known, fresh: false };
    }
    const publisher = this.node.createPublisher(
      // @ts-expect-error: the type is a runtime string, not one of the literal types
      type,
      topic,
      {
        qos: new rclnodejs.QoS(
          HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
          depth,
          reliable
            ? ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE
            : ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT,
          latched
            ? DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL
            : DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
        ),
      },
    ) as unknown as Publisher;
    const entry = { publisher, users: 0 };
    this.publishers.set(key, entry);
    for (const [k, e] of this.publishers) {
      if (this.publishers.size <= MAX_PUBLISHERS) {
        break;
      }
      if (e.users === 0 && e !== entry) {
        this.node.destroyPublisher(e.publisher as unknown as rclnodejs.Publisher<never>);
        this.publishers.delete(k);
      }
    }
    return { publisher: entry, fresh: true };
  }

  // Once the topic's subscriptions match the new publisher, or after a while:
  // those of other types or incompatible QoS never do
  private async matched(publisher: Publisher, topic: string): Promise<void> {
    const deadline = Date.now() + MATCH_TIMEOUT_MS;
    while (Date.now() < deadline && publisher.subscriptionCount < this.node.countSubscribers(topic)) {
      await new Promise((resolve) => setTimeout(resolve, MATCH_POLL_MS));
    }
  }
}
