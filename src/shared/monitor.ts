// What the ROS monitor widget shows of the ROS graph, as the ros2 command line
// does: its topics, services and actions (ros2 topic, service and action
// list, info, echo, hz, bw, delay, pub, call, send_goal) and their interfaces
// (ros2 interface show). See src/server/ros_graph.ts, topic_monitor.ts,
// actions.ts and interfaces.ts.

// ── The graph ────────────────────────────────────────────────────────────────

export interface GraphTopic {
  name: string;
  // Several if its endpoints disagree, which keeps them from talking
  types: string[];
  publishers: number;
  subscribers: number;
}

// A service or an action, and the nodes serving and using it
export interface GraphEndpoints {
  name: string;
  types: string[];
  // Nodes' full names (/namespace/name)
  servers: string[];
  clients: string[];
}

// ros2 topic list, ros2 service list, ros2 action list, ros2 node list: again
// whenever it changes
export interface GraphSnapshot {
  topics: GraphTopic[];
  services: GraphEndpoints[];
  actions: GraphEndpoints[];
  nodes: string[];
  // The dashboard's own node, whose endpoints are the widgets'
  self: string;
}

// ── QoS ──────────────────────────────────────────────────────────────────────

export type Reliability = 'reliable' | 'best_effort' | 'system_default' | 'best_available' | 'unknown';
export type Durability = 'transient_local' | 'volatile' | 'system_default' | 'best_available' | 'unknown';
export type History = 'keep_last' | 'keep_all' | 'system_default' | 'unknown';
export type Liveliness =
  | 'automatic'
  | 'manual_by_node'
  | 'manual_by_topic'
  | 'system_default'
  | 'best_available'
  | 'unknown';

// An endpoint's, as the middleware reports it: others' history and depth are
// unknown
export interface QosProfile {
  reliability: Reliability;
  durability: Durability;
  history: History;
  depth: number;
  // Seconds; null: infinite
  deadline: number | null;
  lifespan: number | null;
  liveliness: Liveliness;
  leaseDuration: number | null;
}

export interface TopicEndpoint {
  // Its node's full name
  node: string;
  type: string;
  qos: QosProfile;
}

// A publisher and a subscription that do not talk, as rmw tells: their QoS
// are incompatible, or their types differ
export interface QosProblem {
  // Their indexes in TopicDetails
  publisher: number;
  subscription: number;
  message: string;
}

// ros2 topic info --verbose: again whenever it changes
export interface TopicDetails {
  topic: string;
  publishers: TopicEndpoint[];
  subscriptions: TopicEndpoint[];
  problems: QosProblem[];
}

// ── Topics' messages ─────────────────────────────────────────────────────────

// The mean, extremes and standard deviation of the latest messages'
export interface Spread {
  mean: number;
  min: number;
  max: number;
  stdDev: number;
}

// ros2 topic hz, bw and delay, of the latest messages: the window
export interface TopicStats {
  // Since the page started following the topic
  received: number;
  // Messages the figures are of: the latest, as many as the window
  window: number;
  // Messages a second; null under two messages
  rate: number | null;
  // Between messages, in seconds
  interval: Spread | null;
  // Bytes a second
  bandwidth: number | null;
  // Of the messages, serialized: in bytes
  size: Spread | null;
  // From their header's stamp to their arrival, on the ROS clock, in seconds;
  // null for messages without a header
  delay: Spread | null;
  // When the latest came, on the server's clock (ms since the epoch)
  lastAt: number | null;
}

// Echoed messages are JSON, but for these values, which JSON has not: a long
// array or string, its first items (ros2 topic echo's --truncate-length);
// 64 bit integers beyond JavaScript's numbers, as text; NaN and infinities
export interface TruncatedValue {
  $truncated: number;
  head: unknown[] | string;
}
export interface BigIntValue {
  $int: string;
}
export interface SpecialNumber {
  $number: 'nan' | 'inf' | '-inf';
}

export interface TopicEcho {
  // Of the messages received since the page started following the topic:
  // those between two echoes are not sent
  seq: number;
  // On the server's clock (ms since the epoch)
  receivedAt: number;
  // Serialized, in bytes
  size: number;
  // The message, or its field asked for; undefined if it has no such field
  message: unknown;
}

// How the monitor publishes: auto is reliable, and transient local when one
// of the topic's subscriptions is (latched topics, such as maps), which
// matches every subscription
export interface PublishQos {
  reliability: 'auto' | 'reliable' | 'best_effort';
  durability: 'auto' | 'volatile' | 'transient_local';
  depth: number;
}

export interface PublishState {
  // Messages published so far
  count: number;
  // Every message asked for is published, or publishing failed
  done: boolean;
  error: string | null;
}

// ── Interfaces ───────────────────────────────────────────────────────────────

export type InterfaceKind = 'msg' | 'srv' | 'action';

export interface MessageField {
  name: string;
  // A primitive (bool, int32, float64, string...) or a message type
  // (pkg/msg/Name), whose schema is given with it
  type: string;
  primitive: boolean;
  array: 'none' | 'fixed' | 'bounded' | 'dynamic';
  // A fixed array's size, a bounded one's bound
  size: number | null;
  // A bounded string's bound (string<=10)
  stringBound: number | null;
  // Its definition's (float64 w 1.0); null: zero, false, empty
  default: unknown;
}

export interface MessageConstant {
  name: string;
  type: string;
  value: unknown;
}

export interface MessageSchema {
  fields: MessageField[];
  constants: MessageConstant[];
}

// ros2 interface show, and what the widgets fill in
export interface InterfaceInfo {
  // pkg/msg/Name, pkg/srv/Name, pkg/action/Name
  type: string;
  kind: InterfaceKind;
  // Its definition with its comments, each nested one indented under its
  // field, without them, as ros2 interface show shows it; null if its file
  // was not found
  text: string | null;
  // A message's one part (message), a service's (request, response), an
  // action's (goal, result, feedback): their types and default values
  parts: { name: string; type: string; default: unknown }[];
  // Of the parts' types and of the types they nest
  schemas: Record<string, MessageSchema>;
}

// ── Actions ──────────────────────────────────────────────────────────────────

// action_msgs/msg/GoalStatus's
export type GoalStatus = 'unknown' | 'accepted' | 'executing' | 'canceling' | 'succeeded' | 'canceled' | 'aborted';

export interface ActionGoal {
  // Its UUID: 8-4-4-4-12 hex digits
  id: string;
  status: GoalStatus;
  // When the server accepted it, on its clock (ms since the epoch)
  acceptedAt: number;
  // The latest feedback, as echoed messages are (TruncatedValue...), and how
  // many came; null before the first
  feedback: unknown;
  feedbacks: number;
  // When it last changed, on the server's clock
  updatedAt: number;
  // Sent from the dashboard: the goal, when, and its result once done (or
  // why there is none)
  sent: { goal: unknown; at: number; result: unknown; error: string | null } | null;
}

// action_msgs/srv/CancelGoal's response
export interface CancelResult {
  // ERROR_NONE 0, ERROR_REJECTED 1, ERROR_UNKNOWN_GOAL_ID 2, ERROR_GOAL_TERMINATED 3
  code: number;
  // The goals now canceling
  canceling: string[];
}

export const GRAPH_PERIOD_MS = 2000;
// Echoes, at most, a second
export const ECHO_RATE = 10;
// Of ros2 topic hz's --window
export const MAX_WINDOW = 10_000;
// Of ros2 topic echo's --truncate-length: the page asks for less
export const MAX_TRUNCATE = 10_000;
