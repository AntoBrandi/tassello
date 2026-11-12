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
// - twist_mux's joystick relay feeding it, if one runs (RelayTracker,
//   twist_mux_relay.ts): found by its actions, every GRAPH_PERIOD_MS; its
//   parameters (its turbo); its priority (latched, as it publishes it); the
//   joystick's commands it takes and the velocities it publishes, which say
//   its turbo steps; its actions' status topics, which say who changed them.
//
// Its pages get its state at most TWIST_MUX_RATE times a second, while
// anything changes, with what became of the messages since the last time.
// Operators lock and release its locks (std_msgs/Bool on their topics) and
// send goals to its relay's actions (Actions, actions.ts).

import rclnodejs from 'rclnodejs';

import type { ParamInfo } from '../shared/parameters.ts';
import type { DiagnosticEntry } from '../shared/protocol.ts';
import { TWIST_MUX_RATE, type MuxControl, type RelayAction, type TwistMuxState } from '../shared/twist_mux.ts';
import type { Actions } from './actions.ts';
import type { Diagnostics } from './diagnostics.ts';
import { nodeName, type Parameters } from './parameters.ts';
import { nodeFullName } from './ros_graph_format.ts';
import {
  GOAL_STATUS_ARRAY,
  JOY_PRIORITY,
  JOY_TURBO,
  pickRelay,
  RelayTracker,
  relayActionOf,
  type RelayGraph,
} from './twist_mux_relay.ts';
import { BOOL, isMuxStatus, MuxTracker, outputOf, TWIST, type TopicPublisher } from './twist_mux_state.ts';
import { errorMessage, type Logger } from './util.ts';

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

const GRAPH_PERIOD_MS = 2000;
// Read again this often while they cannot be, the node running
const PARAMS_RETRY_MS = 5000;
// After the last page: a page reloaded or reconnected finds it as it was
const LINGER_MS = 10_000;
const DIAGNOSTICS_TOPIC = '/diagnostics';
const QUEUE_DEPTH = 10;
// A lock's new publisher waits this long, at most, for the mux to match it:
// a first message is often lost to discovery
const MATCH_TIMEOUT_MS = 1000;
const MATCH_POLL_MS = 50;

// In words, of what a relay's action did
const RELAY_DONE: Record<RelayAction, string> = {
  priority: 'Priority toggled',
  'turbo-increase': 'Turbo up',
  'turbo-decrease': 'Turbo down',
  'turbo-angular-increase': 'Angular turbo up',
  'turbo-angular-decrease': 'Angular turbo down',
  'turbo-reset': 'Turbo reset',
};

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

interface LockPublisher {
  publish(message: unknown): void;
  readonly subscriptionCount: number;
}

type Kind = 'input' | 'lock' | 'output' | 'relay';

// A subscription's key: its kind, then its name ("input joystick", "relay
// status turbo-reset")
function splitKey(key: string): { kind: Kind; name: string } {
  const space = key.indexOf(' ');
  return space < 0 ? { kind: key as Kind, name: '' } : { kind: key.slice(0, space) as Kind, name: key.slice(space + 1) };
}

function splitNode(node: string): { base: string; namespace: string } {
  const slash = node.lastIndexOf('/');
  return { base: node.slice(slash + 1), namespace: node.slice(0, slash) || '/' };
}

// The parameters of a node, as Parameters.watch tells them, whole
function collectParameters(
  parameters: Parameters,
  node: string,
  onParams: (params: ParamInfo[]) => void,
  onError: (message: string) => void,
): () => void {
  let params = new Map<string, ParamInfo>();
  return parameters.watch(node, {
    onStatus: (state, message) => {
      if (state === 'error') {
        onError(message);
      }
    },
    onUpdate: (update) => {
      params = update.reset ? new Map() : params;
      for (const param of update.parameters) {
        params.set(param.name, param);
      }
      for (const deleted of update.deleted) {
        params.delete(deleted);
      }
      onParams([...params.values()]);
    },
  });
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
  private readonly actions: Actions;
  private readonly name: string;
  private readonly tracker: MuxTracker;
  private readonly relay = new RelayTracker();
  private readonly followed = new Map<string, Followed>();
  private stopParams: (() => void) | null = null;
  private paramsFailedAt = 0;
  private stopRelayParams: (() => void) | null = null;
  private relayParamsFailedAt = 0;
  // By topic: kept, as the mux matched them
  private readonly lockPublishers = new Map<string, LockPublisher>();
  private readonly stopDiagnostics: () => void;
  private readonly graphTimer: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;
  private lastSent = '';
  private lastWarning = '';

  constructor(
    rosNode: rclnodejs.Node,
    logger: Logger,
    parameters: Parameters,
    diagnostics: Diagnostics,
    actions: Actions,
    name: string,
  ) {
    this.rosNode = rosNode;
    this.logger = logger;
    this.parameters = parameters;
    this.actions = actions;
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
    watcher.onUpdate(this.state(Date.now(), false));
  }

  // What an operator asks of it: resolves with what was done, in words
  async control(control: MuxControl): Promise<string> {
    const relay = this.relay.relay;
    if (control.kind === 'relay') {
      if (!relay) {
        throw new Error(`No joystick relay feeds ${this.name}`);
      }
      return this.sendRelay(relay, control.action);
    }
    const lock = this.tracker.lockHandle(control.lock);
    if (!lock) {
      throw new Error(`${this.name} has no lock ${control.lock}`);
    }
    // The relay's priority: toggled by the relay, which publishes it
    if (relay && relay.priorityTopic === lock.topic && relay.actions.has('priority')) {
      const manual = this.relay.manual;
      if (manual === control.locked) {
        return `Already ${manual ? 'Manual' : 'Autonomous'}`;
      }
      await this.sendRelay(relay, 'priority');
      return control.locked ? 'Manual: the joystick has the priority' : 'Autonomous: the joystick has no priority';
    }
    if (!control.locked && lock.timeout > 0) {
      throw new Error(
        `${control.lock} has a ${lock.timeout} s timeout: a false once would lock it again, its own publisher must keep publishing false`,
      );
    }
    await this.publishLock(lock.topic, control.locked);
    return `${control.lock} ${control.locked ? 'locked' : 'released'}: ${String(control.locked)} published on ${lock.topic}`;
  }

  private async sendRelay(relay: RelayGraph, action: RelayAction): Promise<string> {
    const name = relay.actions.get(action);
    if (!name) {
      throw new Error(`${relay.node} serves no ${action} action`);
    }
    await this.actions.send(name, action === 'priority' ? JOY_PRIORITY : JOY_TURBO, {});
    return RELAY_DONE[action];
  }

  private async publishLock(topic: string, locked: boolean): Promise<void> {
    let publisher = this.lockPublishers.get(topic);
    if (!publisher) {
      // Volatile: a latched value would come again to those subscribing
      // later, after others' since
      const type: string = BOOL;
      // @ts-expect-error: the type is a runtime string, not one of the literal types
      publisher = this.rosNode.createPublisher(type, topic, {
        qos: new rclnodejs.QoS(
          HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
          1,
          ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
          DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
        ),
      }) as unknown as LockPublisher;
      this.lockPublishers.set(topic, publisher);
    }
    const deadline = Date.now() + MATCH_TIMEOUT_MS;
    while (Date.now() < deadline && publisher.subscriptionCount < Math.max(1, this.rosNode.countSubscribers(topic))) {
      await new Promise((resolve) => setTimeout(resolve, MATCH_POLL_MS));
    }
    publisher.publish({ data: locked });
  }

  private state(now: number, take: boolean): TwistMuxState {
    const state = this.tracker.snapshot(now, take);
    const { inputs, locks } = this.tracker.topics();
    const inputTopics = new Map([...inputs].map(([name, input]) => [name, input.topic]));
    return { ...state, relay: this.relay.snapshot(inputTopics, locks) };
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
    this.stopRelayParams?.();
    this.stopDiagnostics();
    for (const followed of this.followed.values()) {
      this.unsubscribe(followed);
    }
    this.followed.clear();
    for (const publisher of this.lockPublishers.values()) {
      try {
        this.rosNode.destroyPublisher(publisher as unknown as rclnodejs.Publisher<never>);
      } catch {
        // Gone with the node
      }
    }
    this.lockPublishers.clear();
  }

  // Read once, and again when they change: twist_mux only reads them when it
  // starts, but its diagnostics take a second to come
  private watchParameters(): void {
    this.stopParams?.();
    this.stopParams = collectParameters(
      this.parameters,
      this.name,
      (params) => {
        this.paramsFailedAt = 0;
        this.tracker.setParameters(params);
        this.resubscribe();
      },
      (message) => {
        this.paramsFailedAt = Date.now();
        this.tracker.setParameters(null, message);
      },
    );
  }

  // The relay's: its turbo, read once
  private watchRelayParameters(node: string | null): void {
    this.stopRelayParams?.();
    this.stopRelayParams = null;
    this.relayParamsFailedAt = 0;
    if (node) {
      this.stopRelayParams = collectParameters(
        this.parameters,
        node,
        (params) => {
          this.relayParamsFailedAt = 0;
          this.relay.setParameters(params);
        },
        (message) => {
          this.relayParamsFailedAt = Date.now();
          this.relay.setParameters(null, message);
        },
      );
    }
  }

  // The graph's joystick relays: the nodes serving their actions, and what
  // they publish and take
  private findRelays(): RelayGraph[] {
    const relays = new Map<string, RelayGraph>();
    const actions = rclnodejs.getActionNamesAndTypes(this.rosNode) as unknown as { name: string; types: string[] }[];
    for (const { name, types } of actions) {
      const type = types.find((t) => t === JOY_TURBO || t === JOY_PRIORITY);
      const action = type ? relayActionOf(name, type) : null;
      if (!action) {
        continue;
      }
      // Its server publishes its status
      for (const info of this.rosNode.getPublishersInfoByTopic(`${name}/_action/status`, false) as PublisherInfo[]) {
        const node = nodeFullName(info.node_name, info.node_namespace);
        let relay = relays.get(node);
        if (!relay) {
          relay = { node, actions: new Map(), priorityTopic: null, inputTopic: null, outputTopic: null };
          relays.set(node, relay);
        }
        if (!relay.actions.has(action)) {
          relay.actions.set(action, name);
        }
      }
    }
    for (const relay of relays.values()) {
      const { base, namespace } = splitNode(relay.node);
      const publications = this.rosNode.getPublisherNamesAndTypesByNode(base, namespace, false);
      const subscriptions = this.rosNode.getSubscriptionNamesAndTypesByNode(base, namespace, false);
      relay.priorityTopic = publications.find((p) => p.types.includes(BOOL))?.name ?? null;
      relay.outputTopic = publications.find((p) => p.types.includes(TWIST))?.name ?? null;
      relay.inputTopic = subscriptions.find((p) => p.types.includes(TWIST))?.name ?? null;
    }
    return [...relays.values()];
  }

  private pollRelay(): void {
    let relays: RelayGraph[];
    try {
      relays = this.findRelays();
    } catch (e) {
      this.warnOnce(`Cannot look for ${this.name}'s joystick relay: ${errorMessage(e)}`);
      return;
    }
    const { inputs, locks } = this.tracker.topics();
    const before = this.relay.node;
    this.relay.setGraph(
      pickRelay(relays, new Set([...inputs.values()].map((input) => input.topic)), new Set(locks.values())),
      relays.map((relay) => relay.node),
      this.tracker.found,
    );
    const node = this.relay.node;
    const retry = this.relayParamsFailedAt > 0 && Date.now() - this.relayParamsFailedAt > PARAMS_RETRY_MS;
    if (node !== before || retry) {
      this.watchRelayParameters(node);
    }
  }

  private poll(): void {
    const wasFound = this.tracker.found;
    let found = false;
    let subscriptions = new Map<string, string[]>();
    let publications = new Map<string, string[]>();
    const publishers = new Map<string, PublisherInfo[]>();
    try {
      const { base, namespace } = splitNode(this.name);
      found = this.rosNode
        .getNodeNamesAndNamespaces()
        .some((n) => nodeFullName(n.name, n.namespace) === this.name);
      if (found) {
        subscriptions = namesAndTypes(this.rosNode.getSubscriptionNamesAndTypesByNode(base, namespace, false));
        publications = namesAndTypes(this.rosNode.getPublisherNamesAndTypesByNode(base, namespace, false));
      }
      const { inputs, locks } = this.tracker.topics();
      const output = found ? outputOf(publications)?.topic : this.tracker.topics().output;
      const { priorityTopic } = this.relay.relay ?? {};
      const topics = [
        ...[...inputs.values()].map((input) => input.topic),
        ...locks.values(),
        ...(output ? [output] : []),
        ...(priorityTopic ? [priorityTopic] : []),
      ];
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
    this.pollRelay();
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
    // The relay's: its priority latched, as it publishes it; the joystick's
    // commands and its velocities as the mux subscribes; its actions' goals
    // latched, as action servers publish them
    const relay = this.relay.relay;
    if (relay) {
      if (relay.priorityTopic) {
        let priorityLatched = true;
        try {
          priorityLatched = all(relay.priorityTopic, (info) => reliable(info) && latched(info));
        } catch {
          // Its publishers next time
        }
        wanted.set('relay priority', {
          topic: relay.priorityTopic,
          type: BOOL,
          reliable: priorityLatched,
          latched: priorityLatched,
        });
      }
      if (relay.inputTopic) {
        wanted.set('relay in', { topic: relay.inputTopic, type: TWIST, reliable: false, latched: false });
      }
      if (relay.outputTopic) {
        wanted.set('relay out', { topic: relay.outputTopic, type: TWIST, reliable: false, latched: false });
      }
      for (const [action, name] of relay.actions) {
        if (action !== 'priority') {
          wanted.set(`relay status ${action}`, {
            topic: `${name}/_action/status`,
            type: GOAL_STATUS_ARRAY,
            reliable: true,
            latched: true,
          });
        }
      }
    }

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
    const { kind, name } = splitKey(key);
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
      } else if (kind === 'output') {
        this.tracker.outputMessage(message, now);
      } else if (name === 'priority') {
        this.relay.priority(message);
      } else if (name === 'in') {
        this.relay.command(message, now);
      } else if (name === 'out') {
        this.relay.velocity(message, now);
      } else if (name.startsWith('status ')) {
        this.relay.goalStatuses(name.slice('status '.length) as RelayAction, message, now);
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
    const { kind, name } = splitKey(key);
    if (kind === 'relay') {
      this.relay.setSubscribed(name, at, error);
    } else {
      this.tracker.setSubscribed(kind, name, at, error);
    }
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
    const state = this.state(now, true);
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
  private readonly actions: Actions;
  private readonly muxes = new Map<string, WatchedMux>();

  constructor(rosNode: rclnodejs.Node, logger: Logger, parameters: Parameters, diagnostics: Diagnostics, actions: Actions) {
    this.rosNode = rosNode;
    this.logger = logger;
    this.parameters = parameters;
    this.diagnostics = diagnostics;
    this.actions = actions;
  }

  // Of a twist_mux a page follows: resolves with what was done, in words
  control(node: string, control: MuxControl): Promise<string> {
    const mux = this.muxes.get(nodeName(node));
    if (!mux) {
      return Promise.reject(new Error(`${node} is not followed`));
    }
    return mux.control(control);
  }

  // The node's state now, then whenever it changes, until the returned
  // function is called
  watch(node: string, watcher: TwistMuxWatcher): () => void {
    const name = nodeName(node);
    let mux = this.muxes.get(name);
    if (!mux) {
      mux = new WatchedMux(this.rosNode, this.logger, this.parameters, this.diagnostics, this.actions, name);
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
