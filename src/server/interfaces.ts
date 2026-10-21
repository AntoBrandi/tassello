// The ROS interfaces (messages, services, actions) for the monitor widgets:
// their definitions as ros2 interface show prints them, from the files of
// their packages; their schemas and default values, from rclnodejs's code of
// them; and the JSON of the pages made into their messages.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import rclnodejs from 'rclnodejs';

import type { InterfaceInfo, InterfaceKind, MessageField, MessageSchema } from '../shared/monitor.ts';
import {
  defaultMessage,
  expandDefinition,
  HEADER_TYPE,
  parseType,
  partTypes,
  toRosMessage,
  type RosTime,
} from './message_format.ts';
import { missingCodeHint } from './message_code.ts';
import { errorMessage, packageShareDirectory } from './util.ts';

// As rclnodejs describes a message (its class's ROSMessageDef)
interface RosMessageDef {
  fields: {
    name: string;
    type: {
      type: string;
      pkgName: string | null;
      isPrimitiveType: boolean;
      isArray: boolean;
      isFixedSizeArray: boolean | null;
      isUpperBound: boolean;
      arraySize: number | null;
      stringUpperBound: number | null;
    };
    default_value: unknown;
  }[];
  constants: { name: string; type: string; value: unknown }[];
}

function load(type: string): { ROSMessageDef: RosMessageDef } {
  let typeClass: { ROSMessageDef?: RosMessageDef };
  try {
    typeClass = rclnodejs.require(type) as { ROSMessageDef?: RosMessageDef };
  } catch (e) {
    throw new Error(missingCodeHint(errorMessage(e)));
  }
  if (!typeClass?.ROSMessageDef) {
    throw new Error(`${type} is not a message type`);
  }
  return typeClass as { ROSMessageDef: RosMessageDef };
}

// A field's message type, pkg/<msg|srv|action>/Name: rclnodejs tells only
// its package and name, which the parts of services and actions share
function nestedType(pkg: string, name: string): string {
  const kinds = /_(Request|Response|Event)$/.test(name)
    ? ['srv', 'msg', 'action']
    : /_(Goal|Result|Feedback|FeedbackMessage|SendGoal_Request|SendGoal_Response|GetResult_Request|GetResult_Response)$/.test(
          name,
        )
      ? ['action', 'msg', 'srv']
      : ['msg', 'action', 'srv'];
  for (const kind of kinds) {
    try {
      if ((rclnodejs.require(`${pkg}/${kind}/${name}`) as { ROSMessageDef?: unknown })?.ROSMessageDef) {
        return `${pkg}/${kind}/${name}`;
      }
    } catch {
      // Not of this kind
    }
  }
  return `${pkg}/msg/${name}`;
}

function plain(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number | bigint>, (v) => (typeof v === 'bigint' ? Number(v) : v));
  }
  return typeof value === 'bigint' ? Number(value) : value;
}

export class Interfaces {
  private readonly node: rclnodejs.Node;
  private readonly schemas = new Map<string, MessageSchema>();
  private readonly infos = new Map<string, InterfaceInfo>();

  constructor(node: rclnodejs.Node) {
    this.node = node;
  }

  // The schema of a message type, and of those it nests
  schemasOf(type: string, into: Record<string, MessageSchema> = {}): Record<string, MessageSchema> {
    if (into[type]) {
      return into;
    }
    const schema = this.schema(type);
    into[type] = schema;
    for (const field of schema.fields) {
      if (!field.primitive) {
        this.schemasOf(field.type, into);
      }
    }
    return into;
  }

  // ros2 interface show, and the schemas and default values of its parts
  info(type: string): InterfaceInfo {
    const known = this.infos.get(type);
    if (known) {
      return known;
    }
    const { pkg, kind, name } = parseType(type);
    const schemas: Record<string, MessageSchema> = {};
    const parts = partTypes(type).map((part) => {
      this.schemasOf(part.type, schemas);
      return { ...part, default: defaultMessage(part.type, schemas) };
    });
    const info: InterfaceInfo = { type, kind, text: this.definition(pkg, kind, name), parts, schemas };
    this.infos.set(type, info);
    return info;
  }

  // The message of type the page's JSON describes (see toRosMessage)
  message(type: string, value: unknown): Record<string, unknown> {
    return toRosMessage(value, type, this.schemasOf(type), () => this.now());
  }

  // Its messages begin with a std_msgs/msg/Header, whose stamp ros2 topic
  // delay compares with their arrival
  hasHeader(type: string): boolean {
    try {
      const first = this.schema(type).fields[0];
      return first?.name === 'header' && first.type === HEADER_TYPE;
    } catch {
      return false;
    }
  }

  // On the ROS clock: the simulation's with use_sim_time
  now(): RosTime {
    const { seconds, nanoseconds } = this.node.getClock().now().secondsAndNanoseconds;
    return { sec: Number(seconds), nanosec: Number(nanoseconds) };
  }

  private schema(type: string): MessageSchema {
    const known = this.schemas.get(type);
    if (known) {
      return known;
    }
    const { ROSMessageDef: def } = load(type);
    const schema: MessageSchema = {
      fields: def.fields.map(({ name, type: t, default_value }): MessageField => ({
        name,
        type: t.isPrimitiveType ? t.type : nestedType(t.pkgName ?? '', t.type),
        primitive: t.isPrimitiveType,
        array: !t.isArray ? 'none' : t.isFixedSizeArray ? 'fixed' : t.isUpperBound ? 'bounded' : 'dynamic',
        size: t.isArray && (t.isFixedSizeArray || t.isUpperBound) ? t.arraySize : null,
        stringBound: t.stringUpperBound ?? null,
        default: plain(default_value) ?? null,
      })),
      constants: def.constants.map(({ name, type: t, value }) => ({ name, type: t, value: plain(value) })),
    };
    this.schemas.set(type, schema);
    return schema;
  }

  // Its file's text, expanded; null if not found
  private definition(pkg: string, kind: InterfaceKind, name: string): string | null {
    const text = readDefinition(pkg, kind, name);
    return text === null ? null : expandDefinition(text, pkg, (p, n) => readDefinition(p, 'msg', n));
  }
}

function readDefinition(pkg: string, kind: InterfaceKind, name: string): string | null {
  const share = packageShareDirectory(pkg);
  if (!share) {
    return null;
  }
  try {
    return readFileSync(path.join(share, kind, `${name}.${kind}`), 'utf8');
  } catch {
    return null;
  }
}
