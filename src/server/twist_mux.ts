// twist_mux nodes for the Twist Mux inspectors, each followed once for every
// page showing it (MuxTracker, twist_mux_state.ts):
//
// - its configuration, from its diagnostics, which say what it runs with (it
//   reads its parameters once, when it starts), or from its parameters until
//   they come (Parameters, Diagnostics);
// - the graph, every GRAPH_PERIOD_MS: whether it runs, its output (cmd_vel_out
//   as remapped), the type of its commands, who publishes on its topics;
// - every message of its inputs, locks and output. The inputs are subscribed
//   as twist_mux subscribes (best effort, volatile: every publisher matches),
//   the locks the same, or latched as their publishers if they all are (their
//   state then comes at once), the output reliable if its publishers are.
//
// Its pages get its state at most TWIST_MUX_RATE times a second, while
// anything changes, with what became of the messages since the last time.

import rclnodejs from 'rclnodejs';

import type { ParamInfo } from '../shared/parameters.ts';
import type { DiagnosticEntry } from '../shared/protocol.ts';
import { TWIST_MUX_RATE, type TwistMuxState } from '../shared/twist_mux.ts';
import type { Diagnostics } from './diagnostics.ts';
import { nodeName, type Parameters } from './parameters.ts';
import { nodeFullName } from './ros_graph_format.ts';
import { BOOL, isMuxStatus, MuxTracker, outputOf, type TopicPublisher } from './twist_mux_state.ts';
import { errorMessage, type Logger } from './util.ts';

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

const GRAPH_PERIOD_MS = 2000;
// Read again this often while they cannot be, the node running
const PARAMS_RETRY_MS = 5000;
// After the last page: a page reloaded or reconnected finds it as it was
const LINGER_MS = 10_000;
const DIAGNOSTICS_TOPIC = '/diagnostics';
const QUEUE_DEPTH = 10;

export interface TwistMuxWatcher {
  onUpdate: (state: TwistMuxState) => void;
}

interface PublisherInfo {
  node_name: string;
  node_namespace: string;
  topic_type: string;
  qos_profile: { reliability: number; durability: number };
}

// A subscription to one of its topics, as it should be
interface Wanted {
  topic: string;
  type: string;
  // reliable or best effort, transient local or volatile
  reliable: boolean;
  latched: boolean;
}

interface Followed extends Wanted {
  subscription: rclnodejs.Subscription | null;
}

function same(a: Wanted | undefined, b: Wanted | null): boolean {
  return !!a && !!b && a.topic === b.topic && a.type === b.type && a.reliable === b.reliable && a.latched === b.latched;
}

function namesAndTypes(list: { name: string; types: string[] }[]): Map<string, string[]> {
  return new Map(list.map(({ name, types }) => [name, [...types]]));
}

// A twist_mux node: its tracker, its subscriptions, its pages
class WatchedMux {
  readonly watchers = new Set<TwistMuxWatcher>();
  lingerTimer: NodeJS.Timeout | null = null;
  private readonly rosNode: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly parameters: Parameters;
  private readonly name: string;
  private readonly tracker: MuxTracker;
  private readonly followed = new Map<string, Followed>();
  private stopParams: (() => void) | null = null;
  private params = new Map<string, ParamInfo>();
  private paramsFailedAt = 0;
  private readonly stopDiagnostics: () => void;
  private readonly graphTimer: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;
  private lastSent = '';
  private lastWarning = '';

  constructor(rosNode: rclnodejs.Node, logger: Logger, parameters: Parameters, diagnostics: Diagnostics, name: string) {
    this.rosNode = rosNode;
    this.logger = logger;
    this.parameters = parameters;
    this.name = name;
    this.tracker = new MuxTracker(name, nodeFullName(rosNode.name(), rosNode.namespace()), Date.now());
    this.watchParameters();
    let status: DiagnosticEntry | null = null;
    this.stopDiagnostics = diagnostics.watch(DIAGNOSTICS_TOPIC, {
      onStatus: () => {},
      onUpdate: (update) => {
        const latest = update.statuses.findLast((entry) => isMuxStatus(entry.name, name));
        if (update.reset || latest) {
          status = latest ?? (update.reset ? null : status);
          this.tracker.setStatus(status);
          this.resubscribe();
        }
      },
    });
    this.poll();
    this.graphTimer = setInterval(() => this.poll(), GRAPH_PERIOD_MS);
    this.tickTimer = setInterval(() => this.tick(), 1000 / TWIST_MUX_RATE);
  }

  add(watcher: TwistMuxWatcher): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.watchers.add(watcher);
    // Its messages so far are the others'
    watcher.onUpdate(this.tracker.snapshot(Date.now(), false));
  }

  remove(watcher: TwistMuxWatcher): void {
    this.watchers.delete(watcher);
  }

  destroy(): void {
    clearInterval(this.graphTimer);
    clearInterval(this.tickTimer);
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
    }
    this.stopParams?.();
    this.stopDiagnostics();
    for (const followed of this.followed.values()) {
      this.unsubscribe(followed);
    }
    this.followed.clear();
  }

  // Read once, and again when they change: twist_mux only reads them when it
  // starts, but its diagnostics take a second to come
  private watchParameters(): void {
    this.stopParams?.();
    this.stopParams = this.parameters.watch(this.name, {
      onStatus: (state, message) => {
        if (state === 'error') {
          this.paramsFailedAt = Date.now();
          this.tracker.setParameters(null, message);
        }
      },
      onUpdate: (update) => {
        this.paramsFailedAt = 0;
        this.params = update.reset ? new Map() : this.params;
        for (const param of update.parameters) {
          this.params.set(param.name, param);
        }
        for (const deleted of update.deleted) {
          this.params.delete(deleted);
        }
        this.tracker.setParameters([...this.params.values()]);
        this.resubscribe();
      },
    });
  }

  private poll(): void {
    const wasFound = this.tracker.found;
    let found = false;
    let subscriptions = new Map<string, string[]>();
    let publications = new Map<string, string[]>();
    const publishers = new Map<string, PublisherInfo[]>();
    try {
      const slash = this.name.lastIndexOf('/');
      const base = this.name.slice(slash + 1);
      const namespace = this.name.slice(0, slash) || '/';
      found = this.rosNode
        .getNodeNamesAndNamespaces()
        .some((n) => nodeFullName(n.name, n.namespace) === this.name);
      if (found) {
        subscriptions = namesAndTypes(this.rosNode.getSubscriptionNamesAndTypesByNode(base, namespace, false));
        publications = namesAndTypes(this.rosNode.getPublisherNamesAndTypesByNode(base, namespace, false));
      }
      const { inputs, locks } = this.tracker.topics();
      const output = found ? outputOf(publications)?.topic : this.tracker.topics().output;
      const topics = [...[...inputs.values()].map((input) => input.topic), ...locks.values(), ...(output ? [output] : [])];
      for (const topic of new Set(topics)) {
        publishers.set(topic, this.rosNode.getPublishersInfoByTopic(topic, false) as PublisherInfo[]);
      }
      this.lastWarning = '';
    } catch (e) {
      // e.g. gone since listed: next time
      this.warnOnce(`Cannot read the graph of ${this.name}: ${errorMessage(e)}`);
      return;
    }
    const byNode = new Map<string, TopicPublisher[]>(
      [...publishers].map(([topic, infos]) => [
        topic,
        infos
          .map((info) => ({ node: nodeFullName(info.node_name, info.node_namespace), type: info.topic_type }))
          .sort((a, b) => a.node.localeCompare(b.node)),
      ]),
    );
    this.tracker.setGraph({ found, subscriptions, publications, publishers: byNode });
    // Started since: its parameters can be read now
    const now = Date.now();
    if (found && (!wasFound || (this.paramsFailedAt > 0 && now - this.paramsFailedAt > PARAMS_RETRY_MS))) {
      this.paramsFailedAt = 0;
      this.watchParameters();
    }
    this.resubscribe(publishers);
  }

  // Each topic subscribed as it should be: anew if it changed, its type or
  // the QoS of its publishers
  private resubscribe(publishers?: Map<string, PublisherInfo[]>): void {
    const outputType = this.tracker.outputType;
    const { inputs, locks, output } = this.tracker.topics();
    const infos = (topic: string) =>
      publishers?.get(topic) ?? (this.rosNode.getPublishersInfoByTopic(topic, false) as PublisherInfo[]);
    const all = (topic: string, check: (info: PublisherInfo) => boolean) => {
      const list = infos(topic);
      return list.length > 0 && list.every(check);
    };
    const reliable = (info: PublisherInfo) =>
      info.qos_profile.reliability === ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE;
    const latched = (info: PublisherInfo) =>
      info.qos_profile.durability === DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL;

    const wanted = new Map<string, Wanted | null>();
    // Each as the mux subscribes to it, which may not be as it publishes
    for (const [name, { topic, type }] of inputs) {
      wanted.set(`input ${name}`, type ? { topic, type, reliable: false, latched: false } : null);
    }
    for (const [name, topic] of locks) {
      // Latched, its latest state comes at once: reliable and transient
      // local, which only such publishers match
      let lockLatched = false;
      try {
        lockLatched = all(topic, (info) => reliable(info) && latched(info));
      } catch {
        // Its publishers next time
      }
      wanted.set(`lock ${name}`, { topic, type: BOOL, reliable: lockLatched, latched: lockLatched });
    }
    let outputReliable = true;
    if (output) {
      try {
        outputReliable = all(output, reliable) || infos(output).length === 0;
      } catch {
        // As twist_mux publishes it
      }
    }
    wanted.set(
      'output',
      output && outputType ? { topic: output, type: outputType, reliable: outputReliable, latched: false } : null,
    );

    for (const [key, followed] of this.followed) {
      if (!same(followed, wanted.get(key) ?? null)) {
        this.unsubscribe(followed);
        this.followed.delete(key);
        this.setSubscribed(key, null);
      }
    }
    for (const [key, want] of wanted) {
      if (want && !this.followed.has(key)) {
        this.subscribe(key, want);
      }
    }
  }

  private subscribe(key: string, want: Wanted): void {
    const [kind, ...rest] = key.split(' ');
    const name = rest.join(' ');
    const qos = new rclnodejs.QoS(
      HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
      QUEUE_DEPTH,
      want.reliable
        ? ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE
        : ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT,
      want.latched
        ? DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL
        : DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
    );
    const onMessage = (message: unknown) => {
      const now = Date.now();
      if (kind === 'input') {
        this.tracker.input(name, message, now);
      } else if (kind === 'lock') {
        this.tracker.lock(name, message, now);
      } else {
        this.tracker.outputMessage(message, now);
      }
    };
    let subscription: rclnodejs.Subscription | null = null;
    try {
      // @ts-expect-error: the type is a runtime string, not one of the literal types
      subscription = this.rosNode.createSubscription(want.type, want.topic, { qos }, onMessage);
      this.setSubscribed(key, Date.now());
    } catch (e) {
      const message = `Cannot subscribe to ${want.topic}: ${errorMessage(e)}`;
      this.warnOnce(message);
      this.setSubscribed(key, null, message);
    }
    // Kept even if it failed, not to try again until it changes
    this.followed.set(key, { ...want, subscription });
  }

  private setSubscribed(key: string, at: number | null, error = ''): void {
    const [kind, ...rest] = key.split(' ');
    this.tracker.setSubscribed(kind as 'input' | 'lock' | 'output', rest.join(' '), at, error);
  }

  private unsubscribe(followed: Followed): void {
    if (followed.subscription) {
      try {
        this.rosNode.destroySubscription(followed.subscription);
      } catch {
        // Gone with the node
      }
    }
  }

  private tick(): void {
    const now = Date.now();
    // Its inputs heard first may not be those that have the priority
    if (this.tracker.warmingUp(now)) {
      return;
    }
    const state = this.tracker.snapshot(now, true);
    // The same as last sent, but for its time: nothing to say
    const json = JSON.stringify({ ...state, time: 0 });
    if (json === this.lastSent || this.watchers.size === 0) {
      this.lastSent = this.watchers.size === 0 ? '' : json;
      return;
    }
    this.lastSent = json;
    for (const watcher of this.watchers) {
      watcher.onUpdate(state);
    }
  }

  private warnOnce(message: string): void {
    if (message !== this.lastWarning) {
      this.lastWarning = message;
      this.logger.warn(message);
    }
  }
}

export class TwistMuxes {
  private readonly rosNode: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly parameters: Parameters;
  private readonly diagnostics: Diagnostics;
  private readonly muxes = new Map<string, WatchedMux>();

  constructor(rosNode: rclnodejs.Node, logger: Logger, parameters: Parameters, diagnostics: Diagnostics) {
    this.rosNode = rosNode;
    this.logger = logger;
    this.parameters = parameters;
    this.diagnostics = diagnostics;
  }

  // The node's state now, then whenever it changes, until the returned
  // function is called
  watch(node: string, watcher: TwistMuxWatcher): () => void {
    const name = nodeName(node);
    let mux = this.muxes.get(name);
    if (!mux) {
      mux = new WatchedMux(this.rosNode, this.logger, this.parameters, this.diagnostics, name);
      this.muxes.set(name, mux);
    }
    const shared = mux;
    shared.add(watcher);
    return () => {
      shared.remove(watcher);
      if (shared.watchers.size === 0 && !shared.lingerTimer) {
        shared.lingerTimer = setTimeout(() => {
          shared.destroy();
          if (this.muxes.get(name) === shared) {
            this.muxes.delete(name);
          }
        }, LINGER_MS);
      }
    };
  }
}
