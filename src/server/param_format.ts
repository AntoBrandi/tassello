// Parameters as rclnodejs has them (rcl_interfaces's ParameterValue and
// ParameterDescriptor) and as the pages do (../shared/parameters.ts), both
// ways: kept apart from parameters.ts to be tested without ROS. rclnodejs takes
// and gives 64 bit integers as BigInt.

import { PARAM_TYPES, type ParamDescriptor, type ParamType, type ParamValue } from '../shared/parameters.ts';

// As rclnodejs gives an rcl_interfaces/msg/ParameterValue
export interface ParameterValueMessage {
  type: number;
  bool_value: boolean;
  integer_value: bigint | number;
  double_value: number;
  string_value: string;
  byte_array_value: ArrayLike<number>;
  bool_array_value: ArrayLike<boolean>;
  integer_array_value: ArrayLike<bigint | number>;
  double_array_value: ArrayLike<number>;
  string_array_value: ArrayLike<string>;
}

interface Range {
  from_value: bigint | number;
  to_value: bigint | number;
  step: bigint | number;
}

// As rclnodejs gives an rcl_interfaces/msg/ParameterDescriptor
export interface ParameterDescriptorMessage {
  name: string;
  type: number;
  description: string;
  additional_constraints: string;
  read_only: boolean;
  dynamic_typing?: boolean;
  floating_point_range: ArrayLike<Range>;
  integer_range: ArrayLike<Range>;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function paramType(index: number): ParamType {
  return PARAM_TYPES[index] ?? 'not_set';
}

function integerOut(value: bigint | number): number | string {
  const big = BigInt(value);
  return big >= SAFE_MIN && big <= SAFE_MAX ? Number(big) : big.toString();
}

function doubleOut(value: number): number | string {
  if (Number.isFinite(value)) {
    return value;
  }
  return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
}

export function fromParameterValue(message: ParameterValueMessage): ParamValue {
  const type = paramType(message.type);
  switch (type) {
    case 'bool':
      return { type, value: message.bool_value };
    case 'integer':
      return { type, value: integerOut(message.integer_value) };
    case 'double':
      return { type, value: doubleOut(message.double_value) };
    case 'string':
      return { type, value: message.string_value };
    case 'byte_array':
      return { type, value: Array.from(message.byte_array_value, Number) };
    case 'bool_array':
      return { type, value: Array.from(message.bool_array_value, Boolean) };
    case 'integer_array':
      return { type, value: Array.from(message.integer_array_value, integerOut) };
    case 'double_array':
      return { type, value: Array.from(message.double_array_value, doubleOut) };
    case 'string_array':
      return { type, value: Array.from(message.string_array_value, String) };
    default:
      return { type: 'not_set', value: null };
  }
}

function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? String(value);
}

function integerIn(value: unknown, name: string): bigint {
  let big: bigint | null = null;
  if (typeof value === 'number' && Number.isInteger(value)) {
    big = BigInt(value);
  } else if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    big = BigInt(value.trim());
  }
  if (big === null || big < INT64_MIN || big > INT64_MAX) {
    throw new Error(`${name} must be an integer, not ${describe(value)}`);
  }
  return big;
}

function doubleIn(value: unknown, name: string): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'nan') {
      return NaN;
    }
    if (text === 'inf' || text === '+inf' || text === 'infinity') {
      return Infinity;
    }
    if (text === '-inf' || text === '-infinity') {
      return -Infinity;
    }
    if (text !== '' && Number.isFinite(Number(text))) {
      return Number(text);
    }
  }
  throw new Error(`${name} must be a number, not ${describe(value)}`);
}

function boolIn(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be true or false, not ${describe(value)}`);
  }
  return value;
}

function stringIn(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string, not ${describe(value)}`);
  }
  return value;
}

function listIn<T>(value: unknown, name: string, item: (v: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a list, not ${describe(value)}`);
  }
  return value.map((v, i) => item(v, `${name}[${i}]`));
}

// An rcl_interfaces/msg/ParameterValue for rclnodejs; not_set deletes the
// parameter. Throws what is wrong with the value, named after name.
export function toParameterValue(value: ParamValue, name = 'The value'): Record<string, unknown> {
  const index = PARAM_TYPES.indexOf(value.type);
  if (index < 0) {
    throw new Error(`${name}: "${value.type}" is not a parameter type`);
  }
  const v = value.value as unknown;
  switch (value.type) {
    case 'bool':
      return { type: index, bool_value: boolIn(v, name) };
    case 'integer':
      return { type: index, integer_value: integerIn(v, name) };
    case 'double':
      return { type: index, double_value: doubleIn(v, name) };
    case 'string':
      return { type: index, string_value: stringIn(v, name) };
    case 'byte_array':
      return {
        type: index,
        byte_array_value: listIn(v, name, (item, at) => {
          const byte = Number(integerIn(item, at));
          if (byte < 0 || byte > 255) {
            throw new Error(`${at} must be within 0 and 255`);
          }
          return byte;
        }),
      };
    case 'bool_array':
      return { type: index, bool_array_value: listIn(v, name, boolIn) };
    case 'integer_array':
      return { type: index, integer_array_value: listIn(v, name, integerIn) };
    case 'double_array':
      return { type: index, double_array_value: listIn(v, name, doubleIn) };
    case 'string_array':
      return { type: index, string_array_value: listIn(v, name, stringIn) };
    default:
      return { type: index };
  }
}

export function fromDescriptor(message: ParameterDescriptorMessage): ParamDescriptor {
  const range = message.integer_range[0] ?? message.floating_point_range[0];
  return {
    type: paramType(message.type),
    description: message.description,
    additionalConstraints: message.additional_constraints,
    readOnly: message.read_only,
    dynamicTyping: message.dynamic_typing ?? false,
    range: range
      ? { from: Number(range.from_value), to: Number(range.to_value), step: Number(range.step) }
      : null,
  };
}
