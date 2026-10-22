// ROS messages for the monitor widgets, without ROS (tested as is): the parts
// of an interface, its definition as ros2 interface show prints it, a
// message's default value, the JSON a page sends made into what rclnodejs
// publishes, and a message made into JSON for an echo, as ros2 topic echo
// truncates it.

import type { InterfaceKind, MessageSchema } from '../shared/monitor.ts';

const INTEGERS: Record<string, [bigint, bigint]> = {
  bool: [0n, 1n],
  byte: [0n, 255n],
  char: [-128n, 255n],
  int8: [-128n, 127n],
  uint8: [0n, 255n],
  int16: [-32768n, 32767n],
  uint16: [0n, 65535n],
  int32: [-2147483648n, 2147483647n],
  uint32: [0n, 4294967295n],
  int64: [-9223372036854775808n, 9223372036854775807n],
  uint64: [0n, 18446744073709551615n],
};
const FLOATS = new Set(['float32', 'float64']);
const STRINGS = new Set(['string', 'wstring']);
// rclnodejs takes these as BigInt only
const WIDE = new Set(['int64', 'uint64']);

export const TIME_TYPE = 'builtin_interfaces/msg/Time';
export const HEADER_TYPE = 'std_msgs/msg/Header';

export function isPrimitive(type: string): boolean {
  return type in INTEGERS || FLOATS.has(type) || STRINGS.has(type);
}

// ── Interfaces ───────────────────────────────────────────────────────────────

const TYPE = /^([A-Za-z]\w*)\/(msg|srv|action)\/([A-Za-z]\w*)$/;

export function parseType(type: string): { pkg: string; kind: InterfaceKind; name: string } {
  const match = TYPE.exec(type.trim());
  if (!match) {
    throw new Error(`"${type}" is not a ROS interface type (package/msg/Name, package/srv/Name, package/action/Name)`);
  }
  return { pkg: match[1], kind: match[2] as InterfaceKind, name: match[3] };
}

// The types of its parts: a message's own, a service's request and response,
// an action's goal, result and feedback. The messages and services services
// and actions are made of are named after them: an action's feedback topic is
// of pkg/action/Name_FeedbackMessage, its goal service of
// pkg/action/Name_SendGoal; a service's events (since Jazzy) of
// pkg/srv/Name_Event.
export function partTypes(type: string): { name: string; type: string }[] {
  const { kind, name } = parseType(type);
  if (kind === 'msg' || /_(Request|Response|Event|Goal|Result|Feedback|FeedbackMessage)$/.test(name)) {
    return [{ name: 'message', type }];
  }
  const names = kind === 'srv' || /_(SendGoal|GetResult)$/.test(name) ? ['Request', 'Response'] : ['Goal', 'Result', 'Feedback'];
  return names.map((name) => ({ name: name.toLowerCase(), type: `${type}_${name}` }));
}

// ── ros2 interface show ──────────────────────────────────────────────────────

// Reads a message's definition (the .msg file of package pkg); null if
// unknown
export type DefinitionReader = (pkg: string, name: string) => string | null;

// The line without its comment: from a # that is not in a quoted default
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

// The message type a line declares a field of, as [package, name]; null for
// constants, comments, primitives and separators
export function nestedFieldType(line: string, pkg: string): [string, string] | null {
  const text = stripComment(line).trim();
  const match = /^([A-Za-z][\w/]*)(?:<=\d+)?(?:\[(?:<=)?\d*\])?\s+[A-Za-z]\w*(\s*=)?/.exec(text);
  if (!match || match[2] || isPrimitive(match[1])) {
    return null;
  }
  const parts = match[1].split('/');
  if (parts.length === 1) {
    return [pkg, parts[0]];
  }
  // pkg/Name, or pkg/msg/Name
  return [parts[0], parts[parts.length - 1]];
}

// As ros2 interface show prints it: the definition as written, each field of
// a message type followed by that type's definition, indented, without its
// comments and blank lines
export function expandDefinition(text: string, pkg: string, read: DefinitionReader, depth = 0): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')) {
    if (depth > 0) {
      const bare = stripComment(line).trimEnd();
      if (!bare.trim()) {
        continue;
      }
      lines.push(bare.trim());
    } else {
      lines.push(line.trimEnd());
    }
    const nested = depth < 8 ? nestedFieldType(line, pkg) : null;
    const definition = nested && read(nested[0], nested[1]);
    if (nested && definition !== null && definition !== undefined) {
      const expanded = expandDefinition(definition, nested[0], read, depth + 1);
      lines.push(...expanded.split('\n').filter(Boolean).map((l) => `\t${l}`));
    }
  }
  return lines.join('\n');
}

// ── Default values ───────────────────────────────────────────────────────────

function primitiveDefault(type: string): unknown {
  if (type === 'bool') {
    return false;
  }
  return STRINGS.has(type) ? '' : 0;
}

// A message of type with every field at its default: its definition's, or
// zero, false, empty; fixed arrays full of them
export function defaultMessage(type: string, schemas: Record<string, MessageSchema>): Record<string, unknown> {
  const schema = schemas[type];
  const message: Record<string, unknown> = {};
  for (const field of schema?.fields ?? []) {
    const element = () => (field.primitive ? primitiveDefault(field.type) : defaultMessage(field.type, schemas));
    if (field.default !== undefined && field.default !== null) {
      message[field.name] = field.default;
    } else if (field.array === 'fixed') {
      message[field.name] = Array.from({ length: field.size ?? 0 }, element);
    } else if (field.array !== 'none') {
      message[field.name] = [];
    } else {
      message[field.name] = element();
    }
  }
  return message;
}

// ── From the page's JSON ─────────────────────────────────────────────────────

export interface RosTime {
  sec: number;
  nanosec: number;
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'string') {
    return `"${value.length > 20 ? `${value.slice(0, 20)}…` : value}"`;
  }
  return typeof value === 'object' ? 'an object' : String(value);
}

function integer(value: unknown, type: string, path: string): number | bigint {
  let parsed: bigint | null = null;
  if (typeof value === 'number' && Number.isInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    parsed = BigInt(value.trim());
  } else if (value !== null && typeof value === 'object' && typeof (value as { $int?: unknown }).$int === 'string') {
    return integer((value as { $int: string }).$int, type, path);
  } else if (type === 'bool' && typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (parsed === null) {
    throw new Error(`${path} must be an integer (${type}), not ${describe(value)}`);
  }
  const [min, max] = INTEGERS[type];
  if (parsed < min || parsed > max) {
    throw new Error(`${path} must be within ${min} and ${max} (${type})`);
  }
  return WIDE.has(type) ? parsed : Number(parsed);
}

function float(value: unknown, type: string, path: string): number {
  if (typeof value === 'number') {
    return value;
  }
  const text =
    typeof value === 'string'
      ? value.trim().toLowerCase()
      : value !== null && typeof value === 'object' && typeof (value as { $number?: unknown }).$number === 'string'
        ? (value as { $number: string }).$number
        : null;
  if (text === 'nan') {
    return NaN;
  }
  if (text === 'inf' || text === '+inf' || text === 'infinity') {
    return Infinity;
  }
  if (text === '-inf' || text === '-infinity') {
    return -Infinity;
  }
  if (text !== null && text !== '' && Number.isFinite(Number(text))) {
    return Number(text);
  }
  throw new Error(`${path} must be a number (${type}), not ${describe(value)}`);
}

function primitive(value: unknown, type: string, stringBound: number | null, path: string): unknown {
  if (type === 'bool') {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 0 || value === 1) {
      return value === 1;
    }
    throw new Error(`${path} must be true or false, not ${describe(value)}`);
  }
  if (STRINGS.has(type)) {
    if (typeof value !== 'string') {
      throw new Error(`${path} must be a string, not ${describe(value)}`);
    }
    if (stringBound !== null && value.length > stringBound) {
      throw new Error(`${path} must be ${stringBound} characters at most`);
    }
    return value;
  }
  if (FLOATS.has(type)) {
    return float(value, type, path);
  }
  return integer(value, type, path);
}

// The message of type the JSON value describes, for rclnodejs: every field,
// those left out at their default; 64 bit integers as BigInt (from numbers or
// strings), floats also from "nan", "inf" and "-inf". As ros2 topic pub does,
// "now" stands for the time now in a builtin_interfaces/msg/Time, "auto" for
// a std_msgs/msg/Header stamped now. Throws what is wrong, with the field's
// path: a value of another type, a field the type does not have.
export function toRosMessage(
  value: unknown,
  type: string,
  schemas: Record<string, MessageSchema>,
  now: () => RosTime,
  path = '',
): Record<string, unknown> {
  const name = path || 'The message';
  if (type === TIME_TYPE && value === 'now') {
    return { ...now() };
  }
  if (type === HEADER_TYPE && value === 'auto') {
    return { stamp: { ...now() }, frame_id: '' };
  }
  const schema = schemas[type];
  if (!schema) {
    throw new Error(`No definition of ${type}`);
  }
  if (value === null || value === undefined) {
    value = {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object (${type}), not ${describe(value)}`);
  }
  const given = value as Record<string, unknown>;
  const known = new Set(schema.fields.map((f) => f.name));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      throw new Error(`${type} has no field ${path ? `${path}.` : ''}${key}`);
    }
  }
  const defaults = defaultMessage(type, schemas);
  const message: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const fieldPath = path ? `${path}.${field.name}` : field.name;
    const v = given[field.name] === undefined ? defaults[field.name] : given[field.name];
    const convert = (item: unknown, at: string) =>
      field.primitive
        ? primitive(item, field.type, field.stringBound, at)
        : toRosMessage(item, field.type, schemas, now, at);
    if (field.array === 'none') {
      message[field.name] = convert(v, fieldPath);
      continue;
    }
    if (!Array.isArray(v) && !ArrayBuffer.isView(v)) {
      throw new Error(`${fieldPath} must be a list, not ${describe(v)}`);
    }
    const items = Array.from(v as ArrayLike<unknown>);
    if (field.array === 'fixed' && items.length !== field.size) {
      throw new Error(`${fieldPath} must have ${field.size} items, not ${items.length}`);
    }
    if (field.array === 'bounded' && field.size !== null && items.length > field.size) {
      throw new Error(`${fieldPath} must have ${field.size} items at most, not ${items.length}`);
    }
    message[field.name] = items.map((item, i) => convert(item, `${fieldPath}[${i}]`));
  }
  return message;
}

// ── To JSON, echoed ──────────────────────────────────────────────────────────

// The value at path in a message: field names separated by dots, list items
// by their index (pose.position.x, ranges[0], points.0.x); undefined if none
export function fieldAt(message: unknown, path: string): unknown {
  let value = message;
  for (const step of path.split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== '')) {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const index = Number(step);
      const list = value as unknown as ArrayLike<unknown>;
      if (!Number.isInteger(index) || index < 0 || index >= list.length) {
        return undefined;
      }
      value = list[index];
    } else {
      if (!Object.hasOwn(value, step)) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[step];
    }
  }
  return value;
}

// A field's value as a plot takes it: numbers, 64 bit integers, booleans (0
// or 1), times and durations (in seconds); null for anything else, and for
// NaN and infinities
export function sampleValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value !== null && typeof value === 'object' && 'sec' in value && 'nanosec' in value) {
    const { sec, nanosec } = value as { sec: unknown; nanosec: unknown };
    if (typeof sec === 'number' && typeof nanosec === 'number') {
      return sec + nanosec / 1e9;
    }
  }
  return null;
}

function number(value: number): unknown {
  if (Number.isFinite(value)) {
    return value;
  }
  return { $number: Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf' };
}

// A message as JSON for the page (see TruncatedValue and the like in
// ../shared/monitor.ts): lists and strings longer than limit cut to their
// first limit items; typed arrays as lists; 64 bit integers as numbers, as
// text beyond 2^53; NaN and infinities named
export function echoJson(value: unknown, limit: number): unknown {
  if (typeof value === 'number') {
    return number(value);
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : { $int: value.toString() };
  }
  if (typeof value === 'string') {
    return value.length > limit ? { $truncated: value.length, head: value.slice(0, limit) } : value;
  }
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    const list = value as unknown as ArrayLike<unknown> & { slice(start: number, end: number): ArrayLike<unknown> };
    const head = Array.from(list.length > limit ? list.slice(0, limit) : list, (item) => echoJson(item, limit));
    return list.length > limit ? { $truncated: list.length, head } : head;
  }
  if (value !== null && typeof value === 'object') {
    const object: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      object[key] = echoJson(v, limit);
    }
    return object;
  }
  return value ?? null;
}
