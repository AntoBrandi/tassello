// The ROS graph as the monitor widgets have it (see ../shared/monitor.ts),
// from what rclnodejs reports: kept apart from ros_graph.ts to be tested
// without ROS.

import type {
  Durability,
  GraphEndpoints,
  GraphSnapshot,
  GraphTopic,
  History,
  Liveliness,
  QosProblem,
  QosProfile,
  Reliability,
  TopicEndpoint,
} from '../shared/monitor.ts';

export interface NamesAndTypes {
  name: string;
  types: string[];
}

// A node of the graph, and the services and actions it serves and uses
export interface GraphNode {
  name: string;
  namespace: string;
  servers: NamesAndTypes[];
  clients: NamesAndTypes[];
  actionServers: NamesAndTypes[];
  actionClients: NamesAndTypes[];
}

export interface GraphInput {
  topics: (NamesAndTypes & { publishers: number; subscribers: number })[];
  services: NamesAndTypes[];
  actions: NamesAndTypes[];
  nodes: GraphNode[];
  self: string;
}

// /namespace/name
export function nodeFullName(name: string, namespace: string): string {
  return namespace === '/' || namespace === '' ? `/${name}` : `${namespace}/${name}`;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

function endpoints(
  list: NamesAndTypes[],
  nodes: GraphNode[],
  served: (node: GraphNode) => NamesAndTypes[],
  used: (node: GraphNode) => NamesAndTypes[],
): GraphEndpoints[] {
  const named = new Map<string, GraphEndpoints>();
  for (const { name, types } of list) {
    named.set(name, { name, types: [...types], servers: [], clients: [] });
  }
  for (const node of nodes) {
    const full = nodeFullName(node.name, node.namespace);
    for (const [entries, key] of [
      [served(node), 'servers'],
      [used(node), 'clients'],
    ] as const) {
      for (const { name, types } of entries) {
        let entry = named.get(name);
        // A client of a service no node serves: listed too, as rqt does
        if (!entry) {
          entry = { name, types: [...types], servers: [], clients: [] };
          named.set(name, entry);
        }
        if (!entry[key].includes(full)) {
          entry[key].push(full);
        }
      }
    }
  }
  return [...named.values()]
    .map((entry) => ({ ...entry, servers: entry.servers.sort(), clients: entry.clients.sort() }))
    .sort(byName);
}

export function graphSnapshot(input: GraphInput): GraphSnapshot {
  const topics: GraphTopic[] = input.topics
    .map(({ name, types, publishers, subscribers }) => ({ name, types: [...types], publishers, subscribers }))
    .sort(byName);
  return {
    topics,
    services: endpoints(input.services, input.nodes, (n) => n.servers, (n) => n.clients),
    actions: endpoints(input.actions, input.nodes, (n) => n.actionServers, (n) => n.actionClients),
    nodes: [...new Set(input.nodes.map((n) => nodeFullName(n.name, n.namespace)))].sort(),
    self: input.self,
  };
}

// ── QoS ──────────────────────────────────────────────────────────────────────

// rmw's enums (rmw/types.h)
const RELIABILITY: Reliability[] = ['system_default', 'reliable', 'best_effort', 'unknown', 'best_available'];
const DURABILITY: Durability[] = ['system_default', 'transient_local', 'volatile', 'unknown', 'best_available'];
const HISTORY: History[] = ['system_default', 'keep_last', 'keep_all', 'unknown'];
const LIVELINESS: Liveliness[] = [
  'system_default',
  'automatic',
  'manual_by_node',
  'manual_by_topic',
  'unknown',
  'best_available',
];

// RMW_DURATION_INFINITE: 2^63 - 1 ns
const INFINITE_SECONDS = 9_223_372_036;

// As rclnodejs reports an endpoint's QoS
export interface RawQos {
  depth: number;
  history: number;
  reliability: number;
  durability: number;
  lifespan?: RawDuration;
  deadline?: RawDuration;
  liveliness?: number;
  liveliness_lease_duration?: RawDuration;
}

interface RawDuration {
  seconds: number | bigint;
  nanoseconds: number | bigint;
}

// In seconds; null: infinite, or not set (0, which the middleware takes as
// infinite)
function seconds(duration: RawDuration | undefined): number | null {
  if (!duration) {
    return null;
  }
  const s = Number(duration.seconds);
  const ns = Number(duration.nanoseconds);
  if (s >= INFINITE_SECONDS || (s === 0 && ns === 0)) {
    return null;
  }
  return s + ns / 1e9;
}

export function qosProfile(raw: RawQos): QosProfile {
  return {
    reliability: RELIABILITY[raw.reliability] ?? 'unknown',
    durability: DURABILITY[raw.durability] ?? 'unknown',
    history: HISTORY[raw.history] ?? 'unknown',
    depth: Number(raw.depth) || 0,
    deadline: seconds(raw.deadline),
    lifespan: seconds(raw.lifespan),
    liveliness: LIVELINESS[raw.liveliness ?? 0] ?? 'unknown',
    leaseDuration: seconds(raw.liveliness_lease_duration),
  };
}

// As rclnodejs reports a topic's endpoint
export interface RawEndpoint {
  node_name: string;
  node_namespace: string;
  topic_type: string;
  qos_profile: RawQos;
}

export function topicEndpoint(raw: RawEndpoint): TopicEndpoint {
  return {
    node: nodeFullName(raw.node_name, raw.node_namespace),
    type: raw.topic_type,
    qos: qosProfile(raw.qos_profile),
  };
}

// infinite, or 1.5 s
function durationText(value: number | null): string {
  return value === null ? 'infinite' : `${Number(value.toPrecision(6))} s`;
}

// Why a publisher and a subscription do not talk, as
// rmw_qos_profile_check_compatible tells; null if they do. Policies the
// middleware does not report (unknown, system default) are not judged.
export function qosIncompatibility(publisher: TopicEndpoint, subscription: TopicEndpoint): string | null {
  const pub = publisher.qos;
  const sub = subscription.qos;
  if (publisher.type !== subscription.type) {
    return `The publisher's type is ${publisher.type}, the subscription's ${subscription.type}`;
  }
  if (pub.reliability === 'best_effort' && sub.reliability === 'reliable') {
    return 'The publisher is best effort, the subscription wants reliable';
  }
  if (pub.durability === 'volatile' && sub.durability === 'transient_local') {
    return 'The publisher is volatile, the subscription wants transient local (latched)';
  }
  if (sub.deadline !== null && (pub.deadline === null || pub.deadline > sub.deadline)) {
    return `The subscription's deadline (${durationText(sub.deadline)}) is shorter than the publisher's (${durationText(pub.deadline)})`;
  }
  if (pub.liveliness === 'automatic' && sub.liveliness === 'manual_by_topic') {
    return 'The publisher’s liveliness is automatic, the subscription wants manual by topic';
  }
  if (sub.leaseDuration !== null && (pub.leaseDuration === null || pub.leaseDuration > sub.leaseDuration)) {
    return `The subscription's liveliness lease (${durationText(sub.leaseDuration)}) is shorter than the publisher's (${durationText(pub.leaseDuration)})`;
  }
  return null;
}

export function qosProblems(publishers: TopicEndpoint[], subscriptions: TopicEndpoint[]): QosProblem[] {
  const problems: QosProblem[] = [];
  publishers.forEach((publisher, p) =>
    subscriptions.forEach((subscription, s) => {
      const message = qosIncompatibility(publisher, subscription);
      if (message) {
        problems.push({ publisher: p, subscription: s, message });
      }
    }),
  );
  return problems;
}

// The endpoints in a stable order: by node, then type
export function sortEndpoints(list: TopicEndpoint[]): TopicEndpoint[] {
  return [...list].sort((a, b) => a.node.localeCompare(b.node) || a.type.localeCompare(b.type));
}
