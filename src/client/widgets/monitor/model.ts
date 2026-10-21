// The ROS monitor widget's model, without React (tested as is): which names
// it lists, how it writes figures, QoS and messages, and the edits of the
// messages it publishes.

import type {
  GoalStatus,
  GraphEndpoints,
  GraphSnapshot,
  GraphTopic,
  MessageSchema,
  QosProfile,
} from '../../../shared/monitor.ts';

export type Sheet = 'topics' | 'services' | 'actions';

// A row of a sheet: a topic, a service or an action
export interface Entry {
  name: string;
  types: string[];
  // Publishers and subscribers; servers and clients
  out: number;
  in: number;
  // Hidden by ROS's convention, or one of every node's own services
  hidden: boolean;
}

// Names any of whose parts starts with an underscore: ROS hides them
// (ros2 topic list --include-hidden-topics shows them), e.g. the topics and
// services of actions (/navigate_to_pose/_action/status)
export function isHiddenName(name: string): boolean {
  return name.split('/').some((part) => part.startsWith('_'));
}

// The services every node has, of its parameters (rcl_interfaces) and type
// descriptions (since Jazzy)
const NODE_SERVICES = new Set([
  'rcl_interfaces/srv/DescribeParameters',
  'rcl_interfaces/srv/GetParameterTypes',
  'rcl_interfaces/srv/GetParameters',
  'rcl_interfaces/srv/ListParameters',
  'rcl_interfaces/srv/SetParameters',
  'rcl_interfaces/srv/SetParametersAtomically',
  'type_description_interfaces/srv/GetTypeDescription',
]);

export function isNodeService(service: GraphEndpoints): boolean {
  return service.types.length > 0 && service.types.every((type) => NODE_SERVICES.has(type));
}

export function sheetEntries(graph: GraphSnapshot | null, sheet: Sheet): Entry[] {
  if (!graph) {
    return [];
  }
  if (sheet === 'topics') {
    return graph.topics.map((topic: GraphTopic) => ({
      name: topic.name,
      types: topic.types,
      out: topic.publishers,
      in: topic.subscribers,
      hidden: isHiddenName(topic.name),
    }));
  }
  const list = sheet === 'services' ? graph.services : graph.actions;
  return list.map((entry) => ({
    name: entry.name,
    types: entry.types,
    out: entry.servers.length,
    in: entry.clients.length,
    hidden: isHiddenName(entry.name) || (sheet === 'services' && isNodeService(entry)),
  }));
}

// Those shown: not hidden (unless asked), whose name or type match
export function filterEntries(entries: Entry[], hidden: boolean, test: ((text: string) => boolean) | null): Entry[] {
  return entries.filter(
    (entry) => (hidden || !entry.hidden) && (!test || test(entry.name) || entry.types.some((type) => test(type))),
  );
}

// std_msgs/msg/String: std_msgs/String, as ros2 writes types for short
export function shortType(type: string): string {
  return type.replace(/^([^/]+)\/(?:msg|srv|action)\/([^/]+)$/, '$1/$2');
}

// ── Figures ──────────────────────────────────────────────────────────────────

function significant(value: number, digits = 3): string {
  if (value === 0) {
    return '0';
  }
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, digits - 1 - magnitude);
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, 6), minimumFractionDigits: 0 });
}

// 9.98 Hz, 1.2 kHz
export function formatRate(hz: number): string {
  return hz >= 1000 ? `${significant(hz / 1000)} kHz` : `${significant(hz)} Hz`;
}

// 512 B, 1.5 KB, 3.2 MB: of 1000s, as ros2 topic bw writes them
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? Math.round(value) : significant(value)} ${units[unit]}`;
}

// 12 µs, 3.5 ms, 1.25 s, 2 min; negative: ahead (clocks apart)
export function formatSeconds(seconds: number): string {
  const sign = seconds < 0 ? '−' : '';
  const s = Math.abs(seconds);
  // 999.9 ms is 1 s
  if (s < 0.9995e-3) {
    return `${sign}${significant(s * 1e6)} µs`;
  }
  if (s < 0.9995) {
    return `${sign}${significant(s * 1e3)} ms`;
  }
  if (s < 120) {
    return `${sign}${significant(s)} s`;
  }
  if (s < 7200) {
    return `${sign}${Math.round(s / 60)} min`;
  }
  return `${sign}${significant(s / 3600, 2)} h`;
}

// ── QoS ──────────────────────────────────────────────────────────────────────

const POLICY_NAMES: Record<string, string> = {
  reliable: 'reliable',
  best_effort: 'best effort',
  system_default: 'system default',
  best_available: 'best available',
  unknown: 'unknown',
  transient_local: 'transient local',
  volatile: 'volatile',
  keep_last: 'keep last',
  keep_all: 'keep all',
  automatic: 'automatic',
  manual_by_node: 'manual by node',
  manual_by_topic: 'manual by topic',
};

export function policyName(policy: string): string {
  return POLICY_NAMES[policy] ?? policy;
}

// reliable · transient local · keep last 10
export function qosSummary(qos: QosProfile): string {
  const history =
    qos.history === 'keep_last' && qos.depth > 0 ? `keep last ${qos.depth}` : qos.history === 'keep_all' ? 'keep all' : null;
  return [policyName(qos.reliability), policyName(qos.durability), history].filter(Boolean).join(' · ');
}

// Of a duration in seconds: infinite if null
export function qosDuration(value: number | null): string {
  return value === null ? 'infinite' : formatSeconds(value);
}

// ── Messages ─────────────────────────────────────────────────────────────────

interface Truncated {
  $truncated: number;
  head: unknown[] | string;
}

export function isTruncated(value: unknown): value is Truncated {
  return value !== null && typeof value === 'object' && '$truncated' in value && 'head' in value;
}

// A value of an echo that JSON has not: a 64 bit integer's text, NaN or an
// infinity; null if it is none
export function specialText(value: unknown): string | null {
  if (value !== null && typeof value === 'object') {
    if ('$int' in value && typeof value.$int === 'string') {
      return value.$int;
    }
    if ('$number' in value && typeof value.$number === 'string') {
      return value.$number === 'nan' ? '.nan' : value.$number === 'inf' ? '.inf' : '-.inf';
    }
  }
  return null;
}

// It has parts cut by the server: it cannot be published again as it is
export function hasTruncated(value: unknown): boolean {
  if (isTruncated(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasTruncated);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(hasTruncated);
  }
  return false;
}

function scalarText(value: unknown): string {
  const special = specialText(value);
  if (special !== null) {
    return special;
  }
  if (typeof value === 'string') {
    // Quoted when YAML would read it otherwise, as ros2 topic echo does
    return value === '' || /^[\s'"[\]{}#&*!|>%@`,?:-]|: | #|\s$|^(true|false|null|~|[-+.\d].*)$/i.test(value)
      ? `'${value.replace(/'/g, "''")}'`
      : value;
  }
  return value === null || value === undefined ? 'null' : String(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== 'object' || specialText(value) !== null;
}

// A message as ros2 topic echo prints it: YAML, lists cut by the server
// ending with their count ("- '...'" for ros2)
export function yamlText(value: unknown, indent = ''): string {
  if (isTruncated(value)) {
    if (typeof value.head === 'string') {
      return `${scalarText(value.head)}… (${value.$truncated.toLocaleString()} characters)`;
    }
    return yamlText([...value.head, `… ${value.$truncated.toLocaleString()} items in all`], indent);
  }
  if (isScalar(value)) {
    return scalarText(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    return value
      .map((item) => {
        const text = yamlText(item, `${indent}  `);
        return `${indent}- ${isScalar(item) || isTruncated(item) ? text : text.trimStart()}`;
      })
      .join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return '{}';
  }
  return entries
    .map(([key, item]) => {
      if (isScalar(item) || (isTruncated(item) && typeof item.head === 'string')) {
        return `${indent}${key}: ${yamlText(item)}`;
      }
      if ((Array.isArray(item) && item.length === 0) || (isTruncated(item) && item.head.length === 0)) {
        return `${indent}${key}: ${yamlText(item)}`;
      }
      return `${indent}${key}:\n${yamlText(item, `${indent}  `)}`;
    })
    .join('\n');
}

// The message with its value at path replaced
export function setAt(message: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [step, ...rest] = path;
  if (typeof step === 'number') {
    const list = Array.isArray(message) ? [...message] : [];
    list[step] = setAt(list[step], rest, value);
    return list;
  }
  const object = message !== null && typeof message === 'object' && !Array.isArray(message) ? { ...message } : {};
  (object as Record<string, unknown>)[step] = setAt((object as Record<string, unknown>)[step], rest, value);
  return object;
}

// What a number field's text stands for: the number, or the text as typed
// while it is not one (-, 1e), which the server refuses with why
export function numberValue(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
    return text;
  }
  const value = Number(trimmed);
  // Integers beyond JavaScript's are kept as typed: the server reads them
  return Number.isInteger(value) && !Number.isSafeInteger(value) ? trimmed : value;
}

// A primitive list's text: JSON, its items separated by commas
export function listText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => JSON.stringify(item)).join(', ') : '';
}

// The list a primitive list's text stands for; an error if it is not one
export function parseList(text: string, type: string): { value: unknown[] } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { value: [] };
  }
  if (type === 'string' || type === 'wstring') {
    try {
      const parsed: unknown = JSON.parse(`[${trimmed}]`);
      return Array.isArray(parsed) ? { value: parsed } : { error: 'Not a list' };
    } catch {
      return { error: 'Strings in double quotes, separated by commas: "a", "b"' };
    }
  }
  const items = trimmed.split(',').map((item) => item.trim());
  if (type === 'bool') {
    if (items.every((item) => item === 'true' || item === 'false')) {
      return { value: items.map((item) => item === 'true') };
    }
    return { error: 'true or false, separated by commas' };
  }
  const values = items.map(numberValue);
  const wrong = items.find((item, i) => typeof values[i] === 'string' && !/^(-?inf|nan)$/i.test(item));
  return wrong !== undefined ? { error: `Not a number: ${wrong || '(empty)'}` } : { value: values };
}

// A value of type (a primitive or a message) with every field at its
// default, as the server makes a message's: fixed lists full
export function defaultValue(schemas: Record<string, MessageSchema>, type: string): unknown {
  const schema = schemas[type];
  if (!schema) {
    return type === 'bool' ? false : type === 'string' || type === 'wstring' ? '' : 0;
  }
  const message: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.default !== null && field.default !== undefined) {
      message[field.name] = field.default;
    } else if (field.array === 'fixed') {
      message[field.name] = Array.from({ length: field.size ?? 0 }, () => defaultValue(schemas, field.type));
    } else {
      message[field.name] = field.array === 'none' ? defaultValue(schemas, field.type) : [];
    }
  }
  return message;
}

// The constants of a field's type in its message, as ros2 names its values
// (NavSatStatus's STATUS_FIX for its status)
export function fieldConstants(schema: MessageSchema, type: string): { name: string; value: unknown }[] {
  return schema.constants.filter((c) => c.type === type);
}

// ── Actions ──────────────────────────────────────────────────────────────────

export const GOAL_DONE = new Set<GoalStatus>(['succeeded', 'canceled', 'aborted']);

export function goalTone(status: GoalStatus): 'on' | 'busy' | 'warn' | 'failed' | 'idle' {
  switch (status) {
    case 'succeeded':
      return 'on';
    case 'accepted':
    case 'executing':
      return 'busy';
    case 'canceling':
    case 'canceled':
      return 'warn';
    case 'aborted':
      return 'failed';
    default:
      return 'idle';
  }
}

// action_msgs/srv/CancelGoal's return codes
export function cancelCodeText(code: number): string {
  return (
    ['Canceling', 'The server refused to cancel', 'No such goal', 'The goal is already done'][code] ??
    `Cancel failed (${code})`
  );
}

// The topic of a service's events (ros2 service echo), since Jazzy
export function serviceEventTopic(service: string): string {
  return `${service.replace(/\/+$/, '')}/_service_event`;
}
