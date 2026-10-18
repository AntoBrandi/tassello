// Publishes the teleop widgets' velocity commands. A widget streams them at
// its rate while a pad is held, then a zero when released; if the stream stops
// without that zero (browser closed, network lost, ...), the watchdog
// publishes it, so the robot never keeps the last command.

import type rclnodejs from 'rclnodejs';

import { TELEOP_WATCHDOG_MS, type TwistCommand } from '../shared/protocol.ts';
import type { Logger } from './util.ts';

const TWIST = 'geometry_msgs/msg/Twist';
const TWIST_STAMPED = 'geometry_msgs/msg/TwistStamped';

interface ActiveStream {
  sessionId: string;
  command: TwistCommand;
  watchdog: NodeJS.Timeout;
}

function isZero(command: TwistCommand): boolean {
  return command.linear.x === 0 && command.linear.y === 0 && command.angular.z === 0;
}

function zeroed(command: TwistCommand): TwistCommand {
  return { ...command, linear: { x: 0, y: 0 }, angular: { z: 0 } };
}

export class Teleop {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  // Created on first use and kept: there are few teleop topics
  private readonly publishers = new Map<string, rclnodejs.Publisher<typeof TWIST | typeof TWIST_STAMPED>>();
  // Non-zero streams, by session and topic
  private readonly active = new Map<string, ActiveStream>();

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  command(sessionId: string, command: TwistCommand): void {
    const key = `${sessionId} ${command.stamped} ${command.topic}`;
    clearTimeout(this.active.get(key)?.watchdog);
    this.active.delete(key);
    this.publish(command);
    if (isZero(command)) {
      return;
    }
    const watchdog = setTimeout(() => {
      this.active.delete(key);
      this.logger.warn(`Velocity commands on ${command.topic} stopped without a final zero: publishing it`);
      this.publish(zeroed(command));
    }, TELEOP_WATCHDOG_MS);
    this.active.set(key, { sessionId, command, watchdog });
  }

  // The session is gone: stop whatever it was driving
  release(sessionId: string): void {
    for (const [key, stream] of this.active) {
      if (stream.sessionId === sessionId) {
        clearTimeout(stream.watchdog);
        this.active.delete(key);
        this.publish(zeroed(stream.command));
      }
    }
  }

  private publish(command: TwistCommand): void {
    const type = command.stamped ? TWIST_STAMPED : TWIST;
    const key = `${type} ${command.topic}`;
    let publisher = this.publishers.get(key);
    if (!publisher) {
      publisher = this.node.createPublisher(type, command.topic);
      this.publishers.set(key, publisher);
    }
    const twist = {
      linear: { x: command.linear.x, y: command.linear.y, z: 0 },
      angular: { x: 0, y: 0, z: command.angular.z },
    };
    if (command.stamped) {
      // The node's clock: sim time in simulation, which the controllers expect
      publisher.publish({
        header: { stamp: this.node.getClock().now().toMsg(), frame_id: command.frameId },
        twist,
      });
    } else {
      publisher.publish(twist);
    }
  }
}
