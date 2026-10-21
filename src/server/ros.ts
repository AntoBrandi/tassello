// Generic ROS access for the widgets: publishing any message on any topic, and
// calling any service, their messages as JSON. What lets a plugin's widget
// drive the robot without a server side of its own.

import type rclnodejs from 'rclnodejs';

import { MAX_TRUNCATE } from '../shared/monitor.ts';
import type { Interfaces } from './interfaces.ts';
import { echoJson } from './message_format.ts';
import { absoluteTopic, toJson } from './util.ts';

// pkg/msg/Name, pkg/srv/Name; pkg/Name is completed with the kind
const INTERFACE_TYPE = /^([A-Za-z][A-Za-z0-9_]*)\/(?:(msg|srv)\/)?([A-Za-z][A-Za-z0-9_]*)$/;
const MAX_TIMEOUT_MS = 60_000;

interface ServiceClient {
  waitForService(timeout?: number): Promise<boolean>;
  sendRequestAsync(request: unknown, options?: { timeout?: number }): Promise<unknown>;
}

export function interfaceType(type: string, kind: 'msg' | 'srv'): string {
  const match = INTERFACE_TYPE.exec(type.trim());
  if (!match || (match[2] && match[2] !== kind)) {
    throw new Error(`"${type}" is not a ROS ${kind === 'msg' ? 'message' : 'service'} type (package/${kind}/Name)`);
  }
  return `${match[1]}/${kind}/${match[3]}`;
}

export class Ros {
  private readonly node: rclnodejs.Node;
  private readonly interfaces: Interfaces;
  // Kept for the server's life: shared by the pages, and a first message on a
  // new publisher is often lost to discovery
  private readonly publishers = new Map<string, rclnodejs.Publisher<never>>();
  private readonly clients = new Map<string, ServiceClient>();

  constructor(node: rclnodejs.Node, interfaces: Interfaces) {
    this.node = node;
    this.interfaces = interfaces;
  }

  publish(topic: string, messageType: string, message: unknown): void {
    const type = interfaceType(messageType, 'msg');
    const name = absoluteTopic(topic);
    const key = `${type} ${name}`;
    let publisher = this.publishers.get(key);
    if (!publisher) {
      // @ts-expect-error: the type is a runtime string, not one of the literal types
      publisher = this.node.createPublisher(type, name) as rclnodejs.Publisher<never>;
      this.publishers.set(key, publisher);
    }
    publisher.publish((message ?? {}) as never);
  }

  // Resolves with the response, as JSON. Checked, the request is made from
  // the service's definition (see Interfaces.message: 64 bit integers from
  // numbers, "now" for a time...), a field it has not refused, and the
  // response is JSON as echoed messages are (see echoJson).
  async call(service: string, serviceType: string, request: unknown, timeoutMs: number, checked = false): Promise<unknown> {
    const type = interfaceType(serviceType, 'srv');
    const name = absoluteTopic(service);
    const message = checked ? this.interfaces.message(`${type}_Request`, request) : (request ?? {});
    const key = `${type} ${name}`;
    let client = this.clients.get(key);
    if (!client) {
      // @ts-expect-error: as above
      client = this.node.createClient(type, name) as ServiceClient;
      this.clients.set(key, client);
    }
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1, timeoutMs));
    const started = Date.now();
    if (!(await client.waitForService(timeout))) {
      throw new Error(`No service ${name}`);
    }
    const response = await client.sendRequestAsync(message, {
      timeout: Math.max(1, timeout - (Date.now() - started)),
    });
    return checked ? echoJson(response, MAX_TRUNCATE) : toJson(response);
  }
}
