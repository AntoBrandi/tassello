// Nodes' parameters, as the parameters widget shows them and ros2 param reads
// and writes them: list, get, describe, set, delete, dump, load. See
// src/server/parameters.ts.

// rcl_interfaces/msg/ParameterType's, in its order
export const PARAM_TYPES = [
  'not_set',
  'bool',
  'integer',
  'double',
  'string',
  'byte_array',
  'bool_array',
  'integer_array',
  'double_array',
  'string_array',
] as const;

export type ParamType = (typeof PARAM_TYPES)[number];

export type ParamScalar = boolean | number | string;

// A parameter's value, of its type: integers beyond JavaScript's numbers as
// text, doubles' NaN and infinities as "nan", "inf", "-inf"; null if not set
export interface ParamValue {
  type: ParamType;
  value: ParamScalar | ParamScalar[] | null;
}

// rcl_interfaces/msg/ParameterDescriptor's
export interface ParamDescriptor {
  // The type it was declared with: not_set if any (dynamic typing)
  type: ParamType;
  description: string;
  additionalConstraints: string;
  readOnly: boolean;
  dynamicTyping: boolean;
  // Its integer or floating point range: within from and to, in steps of
  // step (0: any)
  range: { from: number; to: number; step: number } | null;
}

export interface ParamInfo {
  // Its full name: dots separate its prefixes (qos_overrides./tf.depth)
  name: string;
  value: ParamValue;
  // null if the node did not describe it
  descriptor: ParamDescriptor | null;
}

// Of a set, a load or a delete, by parameter: the node refuses with why
export interface ParamResult {
  name: string;
  successful: boolean;
  reason: string;
}
