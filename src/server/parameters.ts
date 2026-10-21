// Nodes' parameters for the parameters widgets, as ros2 param has them: each
// node's names, values and descriptors read through its parameter services
// (rcl_interfaces: ros2 param list, get, describe), set and deleted through
// them (set, delete), dumped and loaded as YAML (dump, load), and followed
// live on /parameter_events, on which nodes publish their changes, whoever
// makes them. A node's reading is shared by the pages showing it, and done
// again whenever one comes; its service clients live as long as it is shown.

import rclnodejs from 'rclnodejs';

import type { ParamInfo, ParamResult, ParamValue } from '../shared/parameters.ts';
import type { StreamState } from './frame_stream.ts';
import {
  fromDescriptor,
  fromParameterValue,
  toParameterValue,
  type ParameterDescriptorMessage,
  type ParameterValueMessage,
} from './param_format.ts';
import { dumpParameters, parseParameterFile } from './param_yaml.ts';
import { errorMessage, type Logger } from './util.ts';

const SERVICES = {
  list: 'rcl_interfaces/srv/ListParameters',
  describe: 'rcl_interfaces/srv/DescribeParameters',
  get: 'rcl_interfaces/srv/GetParameters',
  set: 'rcl_interfaces/srv/SetParameters',
  set_atomically: 'rcl_interfaces/srv/SetParametersAtomically',
} as const;
type Service = keyof typeof SERVICES;
const SERVICE_NAMES: Record<Service, string> = {
  list: 'list_parameters',
  describe: 'describe_parameters',
  get: 'get_parameters',
  set: 'set_parameters',
  set_atomically: 'set_parameters_atomically',
};
const EVENTS = 'rcl_interfaces/msg/ParameterEvent';
const TIMEOUT_MS = 5000;
// ListParameters's: every parameter, whatever its prefixes (a uint64, which
// rclnodejs takes as BigInt)
const DEPTH_RECURSIVE = 0n;

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

export interface ParamsUpdate {
  // parameters are all of them, which replace those of before
  reset: boolean;
  parameters: ParamInfo[];
  deleted: string[];
}

export interface ParamsWatcher {
  onStatus: (state: StreamState, message: string) => void;
  onUpdate: (update: ParamsUpdate) => void;
}

interface ParameterMessage {
  name: string;
  value: ParameterValueMessage;
}

interface ParameterEvent {
  node: string;
  new_parameters: ParameterMessage[];
  changed_parameters: ParameterMessage[];
  deleted_parameters: ParameterMessage[];
}

interface ServiceClient {
  waitForService(timeout?: number): Promise<boolean>;
  sendRequestAsync(request: unknown, options?: { timeout?: number }): Promise<unknown>;
}

// A node's service clients, while something uses them
interface Clients {
  clients: Partial<Record<Service, ServiceClient>>;
  users: number;
}

// A node shown by pages: its parameters as last read, kept up to date
class ShownNode {
  readonly watchers = new Set<ParamsWatcher>();
  readonly params = new Map<string, ParamInfo>();
  loaded = false;
  private loading = false;
  // Changed while being read: read again after
  private stale = false;
  private state: StreamState = 'waiting';
  private message = '';
  private readonly owner: Parameters;
  readonly node: string;

  constructor(owner: Parameters, node: string) {
    this.owner = owner;
    this.node = node;
  }

  add(watcher: ParamsWatcher): void {
    this.watchers.add(watcher);
    watcher.onStatus(this.state, this.message);
    void this.load();
  }

  // Reads them all, and sends them to every page
  async load(): Promise<void> {
    if (this.loading) {
      this.stale = true;
      return;
    }
    this.loading = true;
    this.setState('waiting', `Reading the parameters of ${this.node}`);
    try {
      const params = await this.owner.readAll(this.node);
      this.params.clear();
      for (const param of params) {
        this.params.set(param.name, param);
      }
      this.loaded = true;
      this.setState('streaming', '');
      this.broadcast({ reset: true, parameters: [...this.params.values()], deleted: [] });
    } catch (e) {
      this.setState('error', errorMessage(e));
    } finally {
      this.loading = false;
    }
    if (this.stale && this.watchers.size > 0) {
      this.stale = false;
      void this.load();
    }
  }

  // Values changed, parameters added or deleted: by an event, or a set
  async apply(changed: { name: string; value: ParamValue }[], deleted: string[]): Promise<void> {
    if (this.loading || !this.loaded) {
      this.stale = true;
      return;
    }
    const added = changed.filter((c) => !this.params.has(c.name)).map((c) => c.name);
    const descriptors = added.length > 0 ? await this.owner.describe(this.node, added).catch(() => new Map()) : new Map();
    const updated: ParamInfo[] = [];
    for (const { name, value } of changed) {
      // Known already: a set's own event, after the set read it back
      const known = this.params.get(name);
      if (known && JSON.stringify(known.value) === JSON.stringify(value)) {
        continue;
      }
      const param: ParamInfo = {
        name,
        value,
        descriptor: this.params.get(name)?.descriptor ?? descriptors.get(name) ?? null,
      };
      this.params.set(name, param);
      updated.push(param);
    }
    const gone = deleted.filter((name) => this.params.delete(name));
    if (updated.length > 0 || gone.length > 0) {
      this.broadcast({ reset: false, parameters: updated, deleted: gone });
    }
  }

  private broadcast(update: ParamsUpdate): void {
    for (const watcher of this.watchers) {
      watcher.onUpdate(update);
    }
  }

  private setState(state: StreamState, message: string): void {
    if (state === this.state && message === this.message) {
      return;
    }
    this.state = state;
    this.message = message;
    for (const watcher of this.watchers) {
      watcher.onStatus(state, message);
    }
  }
}

export class Parameters {
  private readonly rosNode: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly shown = new Map<string, ShownNode>();
  private readonly clients = new Map<string, Clients>();
  private events: rclnodejs.Subscription | null = null;

  constructor(rosNode: rclnodejs.Node, logger: Logger) {
    this.rosNode = rosNode;
    this.logger = logger;
  }

  // The node's parameters, then their changes, until the returned function is
  // called
  watch(node: string, watcher: ParamsWatcher): () => void {
    const name = nodeName(node);
    let shown = this.shown.get(name);
    if (!shown) {
      shown = new ShownNode(this, name);
      this.shown.set(name, shown);
      this.use(name);
      this.followEvents();
    }
    const current = shown;
    current.add(watcher);
    return () => {
      current.watchers.delete(watcher);
      if (current.watchers.size === 0) {
        this.shown.delete(name);
        this.release(name);
        if (this.shown.size === 0) {
          this.stopEvents();
        }
      }
    };
  }

  // ros2 param set, one by one or atomically; a value not_set deletes the
  // parameter (ros2 param delete). What the node says of each.
  async set(node: string, parameters: { name: string; value: ParamValue }[], atomically: boolean): Promise<ParamResult[]> {
    const name = nodeName(node);
    const request = {
      parameters: parameters.map((p) => ({ name: p.name, value: toParameterValue(p.value, p.name) })),
    };
    this.use(name);
    try {
      let results: ParamResult[];
      if (atomically) {
        const response = (await this.call(name, 'set_atomically', request)) as {
          result: { successful: boolean; reason: string };
        };
        results = parameters.map((p) => ({ name: p.name, ...response.result }));
      } else {
        const response = (await this.call(name, 'set', request)) as {
          results: { successful: boolean; reason: string }[];
        };
        results = parameters.map((p, i) => ({
          name: p.name,
          successful: response.results[i]?.successful ?? false,
          reason: response.results[i]?.reason ?? 'No answer for it',
        }));
      }
      // What the node has now: its events may come later, or not at all
      const done = parameters.filter((_, i) => results[i].successful);
      const shown = this.shown.get(name);
      if (shown && done.length > 0) {
        const deleted = done.filter((p) => p.value.type === 'not_set').map((p) => p.name);
        const kept = done.filter((p) => p.value.type !== 'not_set').map((p) => p.name);
        const values = kept.length > 0 ? await this.get(name, kept).catch(() => null) : [];
        await shown.apply(
          values ? kept.map((n, i) => ({ name: n, value: values[i] })) : done.filter((p) => p.value.type !== 'not_set'),
          deleted,
        );
      }
      return results;
    } finally {
      this.release(name);
    }
  }

  // ros2 param dump: the YAML of all of them, as they are now
  async dump(node: string): Promise<string> {
    const name = nodeName(node);
    this.use(name);
    try {
      return await dumpParameters(name, await this.readAll(name));
    } finally {
      this.release(name);
    }
  }

  // ros2 param load: the node's parameters in the YAML set, one by one
  async load(node: string, yaml: string): Promise<ParamResult[]> {
    const name = nodeName(node);
    const file = await parseParameterFile(name, yaml);
    const results = file.parameters.length > 0 ? await this.set(name, file.parameters, false) : [];
    return [...results, ...file.errors];
  }

  // list, describe and get
  async readAll(node: string): Promise<ParamInfo[]> {
    const list = (await this.call(node, 'list', { prefixes: [], depth: DEPTH_RECURSIVE })) as {
      result: { names: string[] };
    };
    const names = [...list.result.names].sort();
    if (names.length === 0) {
      return [];
    }
    const [descriptors, values] = await Promise.all([this.describe(node, names), this.get(node, names)]);
    return names.map((name, i) => ({ name, value: values[i], descriptor: descriptors.get(name) ?? null }));
  }

  async describe(node: string, names: string[]): Promise<Map<string, ParamInfo['descriptor']>> {
    const response = (await this.call(node, 'describe', { names })) as { descriptors: ParameterDescriptorMessage[] };
    return new Map(Array.from(response.descriptors, (d, i) => [names[i], fromDescriptor(d)]));
  }

  private async get(node: string, names: string[]): Promise<ParamValue[]> {
    const response = (await this.call(node, 'get', { names })) as { values: ParameterValueMessage[] };
    return names.map((_, i) => (response.values[i] ? fromParameterValue(response.values[i]) : { type: 'not_set', value: null }));
  }

  private async call(node: string, service: Service, request: unknown): Promise<unknown> {
    const entry = this.clients.get(node);
    if (!entry) {
      throw new Error(`No clients of ${node}`);
    }
    let client = entry.clients[service];
    if (!client) {
      client = this.rosNode.createClient(
        SERVICES[service],
        `${node === '/' ? '' : node}/${SERVICE_NAMES[service]}`,
      ) as unknown as ServiceClient;
      entry.clients[service] = client;
    }
    if (!(await client.waitForService(TIMEOUT_MS))) {
      throw new Error(`${node} has no parameter services: is it running?`);
    }
    return client.sendRequestAsync(request, { timeout: TIMEOUT_MS });
  }

  private use(node: string): void {
    const entry = this.clients.get(node) ?? { clients: {}, users: 0 };
    entry.users++;
    this.clients.set(node, entry);
  }

  private release(node: string): void {
    const entry = this.clients.get(node);
    if (!entry || --entry.users > 0) {
      return;
    }
    this.clients.delete(node);
    for (const client of Object.values(entry.clients)) {
      this.rosNode.destroyClient(client as unknown as rclnodejs.Client<never>);
    }
  }

  private followEvents(): void {
    if (this.events) {
      return;
    }
    try {
      this.events = this.rosNode.createSubscription(
        EVENTS,
        '/parameter_events',
        {
          // rclcpp's publishers'
          qos: new rclnodejs.QoS(
            HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
            1000,
            ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
            DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
          ),
        },
        (message: unknown) => this.onEvent(message as ParameterEvent),
      );
    } catch (e) {
      this.logger.warn(`Cannot follow /parameter_events: ${errorMessage(e)}`);
    }
  }

  private stopEvents(): void {
    if (this.events) {
      this.rosNode.destroySubscription(this.events);
      this.events = null;
    }
  }

  private onEvent(event: ParameterEvent): void {
    const shown = this.shown.get(nodeName(event.node));
    if (!shown) {
      return;
    }
    const changed = [...event.new_parameters, ...event.changed_parameters].map((p) => ({
      name: p.name,
      value: fromParameterValue(p.value),
    }));
    void shown.apply(
      changed,
      Array.from(event.deleted_parameters, (p) => p.name),
    );
  }
}

// /namespace/name, as the graph has it
export function nodeName(node: string): string {
  const trimmed = node.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
