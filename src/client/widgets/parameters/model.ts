// The parameters widget's model, without React (tested as is): a node's
// parameters as a tree of their prefixes, their values as text to edit and
// back, and the type of a new one's value, as ros2 param set reads it.

import type { ParamDescriptor, ParamInfo, ParamScalar, ParamType, ParamValue } from '../../../shared/parameters.ts';

export type ParamRow =
  | {
      kind: 'group';
      // Its prefix: qos_overrides./tf
      key: string;
      label: string;
      depth: number;
      open: boolean;
      count: number;
    }
  | { kind: 'param'; key: string; label: string; depth: number; param: ParamInfo };

interface TreeNode {
  children: Map<string, TreeNode>;
  param: ParamInfo | null;
}

// Nodes ros2 node list leaves out: a part of their name starts with _
export function isHiddenNode(name: string): boolean {
  return name.split('/').some((part) => part.startsWith('_'));
}

function tree(params: ParamInfo[]): TreeNode {
  const root: TreeNode = { children: new Map(), param: null };
  for (const param of params) {
    let node = root;
    for (const part of param.name.split('.')) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), param: null };
        node.children.set(part, child);
      }
      node = child;
    }
    node.param = param;
  }
  return root;
}

function stats(node: TreeNode): { count: number; readOnly: number } {
  let count = node.param ? 1 : 0;
  let readOnly = node.param?.descriptor?.readOnly ? 1 : 0;
  for (const child of node.children.values()) {
    const s = stats(child);
    count += s.count;
    readOnly += s.readOnly;
  }
  return { count, readOnly };
}

// The rows shown: groups of the parameters' prefixes, folded as chosen (the
// top ones of read-only parameters only, such as qos_overrides, folded until
// opened), with the parameters matching the filter; filtering, every group
// with a match is open
export function paramRows(
  params: ParamInfo[],
  test: ((text: string) => boolean) | null,
  chosen: ReadonlyMap<string, boolean>,
): ParamRow[] {
  const matching = test
    ? params.filter((p) => test(p.name) || (p.descriptor?.description ? test(p.descriptor.description) : false))
    : params;
  const rows: ParamRow[] = [];
  const visit = (node: TreeNode, prefix: string, depth: number) => {
    for (const [part, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
      const key = prefix ? `${prefix}.${part}` : part;
      if (child.param) {
        rows.push({ kind: 'param', key, label: part, depth, param: child.param });
      }
      if (child.children.size > 0) {
        const { count, readOnly } = stats({ children: child.children, param: null });
        // Opened, a group shows all under it
        const open = test ? true : (chosen.get(key) ?? (depth > 0 || readOnly < count));
        rows.push({ kind: 'group', key, label: part, depth, open, count });
        if (open) {
          visit(child, key, depth + 1);
        }
      }
    }
  };
  visit(tree(matching), '', 0);
  return rows;
}

function scalarText(value: ParamScalar, type: ParamType): string {
  return type === 'string_array' ? JSON.stringify(value) : String(value);
}

// A value as its editor shows it: lists' items separated by commas, strings
// of lists quoted
export function valueText(value: ParamValue): string {
  if (value.value === null) {
    return '';
  }
  if (Array.isArray(value.value)) {
    return value.value.map((item) => scalarText(item, value.type)).join(', ');
  }
  return String(value.value);
}

const INTEGER = /^-?\d+$/;
const SPECIAL = /^[-+]?\.?(inf|infinity|nan)$/i;

function integer(text: string): number | string | null {
  if (!INTEGER.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : text;
}

function double(text: string): number | string | null {
  if (SPECIAL.test(text)) {
    const lower = text.toLowerCase().replace('.', '').replace('+', '').replace('infinity', 'inf');
    return lower === '-inf' ? '-inf' : lower === 'inf' ? 'inf' : 'nan';
  }
  return text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
}

function items(text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(',').map((item) => item.trim()) : [];
}

// The value of type the editor's text stands for, or what is wrong with it
export function parseValueText(text: string, type: ParamType): { value: ParamValue } | { error: string } {
  const t = text.trim();
  const of = (value: ParamValue['value']) => ({ value: { type, value } });
  switch (type) {
    case 'bool':
      return t === 'true' || t === 'false' ? of(t === 'true') : { error: 'true or false' };
    case 'integer': {
      const value = integer(t);
      return value === null ? { error: 'An integer' } : of(value);
    }
    case 'double': {
      const value = double(t);
      return value === null ? { error: 'A number' } : of(value);
    }
    case 'string':
      return of(text);
    case 'bool_array': {
      const list = items(t);
      return list.every((i) => i === 'true' || i === 'false')
        ? of(list.map((i) => i === 'true'))
        : { error: 'true or false, separated by commas' };
    }
    case 'integer_array':
    case 'byte_array': {
      const list = items(t).map(integer);
      return list.every((i) => i !== null) ? of(list as ParamScalar[]) : { error: 'Integers, separated by commas' };
    }
    case 'double_array': {
      const list = items(t).map(double);
      return list.every((i) => i !== null) ? of(list as ParamScalar[]) : { error: 'Numbers, separated by commas' };
    }
    case 'string_array':
      try {
        const list: unknown = JSON.parse(`[${t}]`);
        if (Array.isArray(list) && list.every((i) => typeof i === 'string')) {
          return of(list);
        }
      } catch {
        // Below
      }
      return { error: 'Strings in double quotes, separated by commas: "a", "b"' };
    default:
      return { error: 'It has no value' };
  }
}

function inferScalar(text: string): ParamValue {
  const t = text.trim();
  if (/^(true|false)$/i.test(t)) {
    return { type: 'bool', value: t.toLowerCase() === 'true' };
  }
  const i = integer(t);
  if (i !== null) {
    return { type: 'integer', value: i };
  }
  const d = /^[-+]?(\d+\.\d*|\.\d+|\d+(\.\d*)?[eE][-+]?\d+)$/.test(t) || /^[-+]?\.(inf|nan)$/i.test(t) ? double(t) : null;
  if (d !== null) {
    return { type: 'double', value: d };
  }
  const quoted = /^(["'])(.*)\1$/.exec(t);
  return { type: 'string', value: quoted ? quoted[2] : t };
}

// A new parameter's value, of the type ros2 param set gives it (YAML's):
// true/false, an integer, a number with a dot or an exponent, a list of one
// of them in brackets ([1, 2.5] is of doubles), else a string
export function inferValue(text: string): ParamValue {
  const t = text.trim();
  const list = /^\[(.*)\]$/s.exec(t);
  if (!list) {
    return inferScalar(t);
  }
  const values = items(list[1]).map(inferScalar);
  const types = new Set(values.map((v) => v.type));
  if (values.length === 0 || (types.size === 1 && types.has('string'))) {
    return { type: 'string_array', value: values.map((v) => String(v.value)) };
  }
  if (types.size === 1) {
    const [type] = types;
    return { type: `${type}_array` as ParamType, value: values.map((v) => v.value as ParamScalar) };
  }
  if ([...types].every((type) => type === 'integer' || type === 'double')) {
    return { type: 'double_array', value: values.map((v) => (typeof v.value === 'string' ? v.value : Number(v.value))) };
  }
  return { type: 'string_array', value: values.map((v) => String(v.value)) };
}

// 0 … 255, in steps of 1
export function rangeText(descriptor: ParamDescriptor | null): string | null {
  const range = descriptor?.range;
  if (!range) {
    return null;
  }
  return `${range.from} … ${range.to}${range.step ? `, in steps of ${range.step}` : ''}`;
}

const TYPE_NAMES: Record<ParamType, string> = {
  not_set: 'not set',
  bool: 'bool',
  integer: 'integer',
  double: 'double',
  string: 'string',
  byte_array: 'byte[]',
  bool_array: 'bool[]',
  integer_array: 'integer[]',
  double_array: 'double[]',
  string_array: 'string[]',
};

export function typeName(type: ParamType): string {
  return TYPE_NAMES[type];
}

// A value as YAML writes it, as ros2 param set reads it
function yamlScalar(value: ParamScalar, type: ParamType): string {
  if (typeof value === 'string' && (type === 'double' || type === 'double_array')) {
    return { inf: '.inf', '-inf': '-.inf', nan: '.nan' }[value] ?? value;
  }
  return typeof value === 'string' && (type === 'string' || type === 'string_array') ? JSON.stringify(value) : String(value);
}

// ros2 param set's command for the value
export function setCommand(node: string, name: string, value: ParamValue): string {
  const text = Array.isArray(value.value)
    ? `[${value.value.map((v) => yamlScalar(v, value.type)).join(', ')}]`
    : value.value === null
      ? ''
      : yamlScalar(value.value, value.type);
  return `ros2 param set ${node} ${name} '${text.replace(/'/g, "'\\''")}'`;
}
