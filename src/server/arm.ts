// The arm teleop widget's side of the server.
//
// An arm subscription follows the joints of trajectory controllers (ros2_control
// JointTrajectoryControllers, whose `joints` parameter names them): where they
// are, from the joint states, and how far they may go, from the URDF, or from
// the hardware interface's calibration state when there is one (limits lifted
// while it calibrates).
//
// Its jogs stream the controllers one-point trajectories just ahead of the arm,
// 20 times a second: positions only, as a trajectory
// controller refuses a trajectory that ends moving. When the stream ends the arm
// stops at the last point, a fraction of a second ahead of it, and a page that
// vanishes leaves it still: the watchdog ends its stream. Cartesian jogs move
// the end effector by damped least squares on the URDF's kinematics
// (kinematics.ts), as MoveIt Servo does: as far as the joints allow, slower
// near singularities; smooth, unlike the solutions of move_group's IK for a 5
// joint arm. A step move_group finds colliding (/check_state_validity) is not
// taken; without move_group, nothing is checked.

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import type rclnodejs from 'rclnodejs';

import {
  ARM_STATE_RATE,
  TELEOP_WATCHDOG_MS,
  type ArmIk,
  type ArmJointState,
  type ArmUpdate,
} from '../shared/protocol.ts';
import { urdfJoints, type UrdfJoint } from '../shared/urdf.ts';
import { clampCommand, controllerNamespace, duration } from './arm_motion.ts';
import { dampedLeastSquares, Kinematics } from './kinematics.ts';
import type { StreamState } from './frame_stream.ts';
import type { Topics } from './topics.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const JOINT_TRAJECTORY = 'trajectory_msgs/msg/JointTrajectory';

const PERIOD_MS = 50;
const PERIOD_S = PERIOD_MS / 1000;
// One step is never longer than this, however late it comes
const MAX_STEP_S = 0.25;
// How far ahead of the command's time each point is placed
const LOOKAHEAD_S = 0.1;
// How far ahead of a joint its command may run: this many seconds at its jog
// speed, plus the minimum
const MAX_LEAD_S = 0.5;
const MIN_LEAD = 0.05; // rad
// In Cartesian jogs, how far ahead of a joint its command may run
const CARTESIAN_LEAD = 0.3; // rad
// Damping of the least squares, m: the joints slow down near singularities
const DAMPING = 0.01;
const SOLVER_ITERATIONS = 3;
// A Cartesian step is taken if the end effector goes at least this share of
// the way asked, and strays sideways at most this share of it
const MIN_PROGRESS = 0.2;
const MAX_STRAY = 0.5;
const SERVICE_TIMEOUT_MS = 1000;
// A controller not found, or whose joints could not be read, is tried again
const CONTROLLER_RETRY_MS = 3000;
// Sent to the page when it changes: positions to 0.1 mrad
const POSITION_DECIMALS = 4;

// A calibration state the robot's hardware interface may publish, JSON on a
// std_msgs/String topic, as much of it as used here (see the README's Arm
// Teleop): limits that replace the URDF's, and joints not yet located
interface CalibrationState {
  active: boolean;
  calibrating: boolean;
  problem: string | null;
  joints: {
    name: string;
    has_motor: boolean;
    located: boolean;
    drivable: boolean;
    lower: number | null;
    upper: number | null;
    allowed_lower: number | null;
    allowed_upper: number | null;
  }[];
}

interface JointStateMessage {
  name: string[];
  position: number[];
}

interface Vector {
  x: number;
  y: number;
  z: number;
}

interface ServiceClient {
  isServiceServerAvailable(): boolean;
  sendRequestAsync(request: unknown, options?: { timeout?: number }): Promise<unknown>;
}

export interface ArmOptions {
  controllers: string[];
  jointStatesTopic: string;
  descriptionTopic: string;
  calibrationTopic: string;
}

export interface ArmJogInput {
  joints: Record<string, number>;
  cartesian: Vector;
  ik: ArmIk;
}

interface Controller {
  name: string;
  joints: string[] | null;
  error: string | null;
}

function isZero(v: Vector): boolean {
  return v.x === 0 && v.y === 0 && v.z === 0;
}

function hasInput(input: ArmJogInput): boolean {
  return Object.values(input.joints).some((v) => v !== 0) || !isZero(input.cartesian);
}

function round(value: number): number {
  const scale = 10 ** POSITION_DECIMALS;
  return Math.round(value * scale) / scale;
}

// What the server keeps for the arm widgets: the clients and publishers,
// shared by the pages
export class Arm {
  readonly node: rclnodejs.Node;
  readonly topics: Topics;
  readonly logger: Logger;
  private readonly clients = new Map<string, ServiceClient>();
  private readonly trajectoryPublishers = new Map<string, rclnodejs.Publisher<typeof JOINT_TRAJECTORY>>();

  constructor(node: rclnodejs.Node, topics: Topics, logger: Logger) {
    this.node = node;
    this.topics = topics;
    this.logger = logger;
  }

  // Until its dispose()
  watch(options: ArmOptions, send: (update: Omit<ArmUpdate, 'type' | 'id'>) => void): ArmWatcher {
    return new ArmWatcher(this, options, send);
  }

  client(type: string, name: string): ServiceClient {
    const key = `${type} ${name}`;
    let client = this.clients.get(key);
    if (!client) {
      // @ts-expect-error: the type is a runtime string, not one of the literal types
      client = this.node.createClient(type, name) as ServiceClient;
      this.clients.set(key, client);
    }
    return client;
  }

  // To positions `ahead` seconds from now; from `start` first, if given
  publishTrajectory(
    controller: string,
    joints: string[],
    positions: number[],
    ahead: number,
    start: number[] | null,
  ): void {
    const topic = `${controllerNamespace(controller)}/joint_trajectory`;
    let publisher = this.trajectoryPublishers.get(topic);
    if (!publisher) {
      publisher = this.node.createPublisher(JOINT_TRAJECTORY, topic);
      this.trajectoryPublishers.set(topic, publisher);
    }
    const point = (at: number[], seconds: number) => ({
      positions: at,
      velocities: [],
      accelerations: [],
      effort: [],
      time_from_start: duration(seconds),
    });
    // A zero stamp: the controller starts it at once
    publisher.publish({
      header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
      joint_names: joints,
      points: start ? [point(start, 0), point(positions, ahead)] : [point(positions, ahead)],
    });
  }
}

// One page's arm subscription, and its jog
export class ArmWatcher {
  private readonly arm: Arm;
  private readonly options: ArmOptions;
  private readonly send: (update: Omit<ArmUpdate, 'type' | 'id'>) => void;
  private readonly unwatch: (() => void)[] = [];
  private disposed = false;

  readonly controllers: Controller[];
  readonly positions = new Map<string, number>();
  private urdf = new Map<string, UrdfJoint>();
  private urdfKinematics: Kinematics | null = null;
  private calibration: CalibrationState | null = null;
  private topicProblems = new Map<string, string>();

  private jog: Jog | null = null;
  jogStatus: ArmUpdate['jog'] = { state: 'idle', message: '' };

  private lastSent = '';
  private sendTimer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;

  constructor(arm: Arm, options: ArmOptions, send: (update: Omit<ArmUpdate, 'type' | 'id'>) => void) {
    this.arm = arm;
    this.options = options;
    this.send = send;
    this.controllers = [...new Set(options.controllers.map((c) => c.trim()).filter(Boolean))].map((name) => ({
      name,
      joints: null,
      error: null,
    }));
    this.watchTopic(options.jointStatesTopic, true, (message) => this.onJointStates(message as JointStateMessage));
    this.watchTopic(options.descriptionTopic, false, (message) => {
      const urdf = (message as { data?: unknown }).data;
      if (typeof urdf === 'string') {
        this.urdf = urdfJoints(urdf);
        this.urdfKinematics = new Kinematics(this.urdf);
        this.changed();
      }
    });
    if (options.calibrationTopic.trim()) {
      this.watchTopic(options.calibrationTopic, false, (message) => {
        try {
          this.calibration = JSON.parse(String((message as { data?: unknown }).data)) as CalibrationState;
        } catch {
          this.calibration = null;
        }
        this.changed();
      });
    }
    for (const controller of this.controllers) {
      void this.resolve(controller);
    }
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.jog?.stop();
    this.unwatch.forEach((end) => end());
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
    }
  }

  // A jog input of the page
  input(input: ArmJogInput): void {
    if (this.disposed) {
      return;
    }
    if (!this.jog || this.jog.finished) {
      if (!hasInput(input)) {
        return;
      }
      this.jog = new Jog(this.arm, this, input);
    } else {
      this.jog.input(input);
    }
  }

  setJogStatus(state: ArmUpdate['jog']['state'], message = ''): void {
    if (state !== this.jogStatus.state || message !== this.jogStatus.message) {
      this.jogStatus = { state, message };
      this.changed();
    }
  }

  // Where the joint may be commanded now
  range(name: string): { lower: number | null; upper: number | null } {
    const joint = this.calibrationJoint(name);
    if (joint) {
      return joint.drivable
        ? { lower: joint.allowed_lower, upper: joint.allowed_upper }
        : { lower: joint.lower, upper: joint.upper };
    }
    const urdf = this.urdf.get(name);
    return { lower: urdf?.lower ?? null, upper: urdf?.upper ?? null };
  }

  // Why the hardware will not move the joint, null if it may
  refusal(name: string): string | null {
    const joint = this.calibrationJoint(name);
    if (!joint || joint.drivable) {
      return null;
    }
    if (!joint.has_motor) {
      return `${name} has no motor in the calibration state`;
    }
    if (!joint.located) {
      return `${name} is not located: calibrate it`;
    }
    return `${name} has no limits: calibrate it`;
  }

  // From the robot description, null until it arrives
  kinematics(): Kinematics | null {
    return this.urdfKinematics;
  }

  controllerOf(joint: string): Controller | undefined {
    return this.controllers.find((c) => c.joints?.includes(joint));
  }

  // The hardware interface's state of the joint, if it is active and drives it
  private calibrationJoint(name: string) {
    return this.calibration?.active ? this.calibration.joints.find((j) => j.name === name) : undefined;
  }

  private watchTopic(name: string, fast: boolean, onMessage: (message: unknown) => void): void {
    if (!name.trim()) {
      return;
    }
    const topic = absoluteTopic(name);
    this.unwatch.push(
      this.arm.topics.watch(topic, {
        // The joint states at their rate: the jogs start from them
        minIntervalMs: fast ? 0 : 200,
        onStatus: (state: StreamState, message: string) => {
          if (state === 'streaming') {
            this.topicProblems.delete(topic);
          } else {
            this.topicProblems.set(topic, message);
          }
          this.changed();
        },
        onMessage: (_type, message) => onMessage(message),
      }),
    );
  }

  private onJointStates(message: JointStateMessage): void {
    const names = message.name ?? [];
    const positions = message.position ?? [];
    names.forEach((name, i) => {
      if (Number.isFinite(positions[i])) {
        this.positions.set(name, positions[i]);
      }
    });
    this.changed();
  }

  // Reads the controller's joints, again and again until it answers
  private async resolve(controller: Controller): Promise<void> {
    while (!this.disposed) {
      const service = `${controllerNamespace(controller.name)}/get_parameters`;
      try {
        const client = this.arm.client('rcl_interfaces/srv/GetParameters', service);
        if (!client.isServiceServerAvailable()) {
          throw new Error(`Controller ${controller.name} not found`);
        }
        const response = (await client.sendRequestAsync({ names: ['joints'] }, { timeout: SERVICE_TIMEOUT_MS })) as {
          values: { string_array_value: string[] }[];
        };
        const joints = response.values[0]?.string_array_value ?? [];
        if (joints.length === 0) {
          throw new Error(`Controller ${controller.name} has no joints`);
        }
        controller.joints = [...joints];
        controller.error = null;
        this.changed();
        return;
      } catch (e) {
        controller.error = errorMessage(e);
        this.changed();
      }
      await sleep(CONTROLLER_RETRY_MS);
    }
  }

  // Sends the state if it changed, at most ARM_STATE_RATE a second
  private changed(): void {
    if (this.disposed || this.sendTimer) {
      return;
    }
    const wait = this.lastSentAt + 1000 / ARM_STATE_RATE - Date.now();
    this.sendTimer = setTimeout(
      () => {
        this.sendTimer = null;
        this.lastSentAt = Date.now();
        const update = this.update();
        const text = JSON.stringify(update);
        if (text !== this.lastSent) {
          this.lastSent = text;
          this.send(update);
        }
      },
      Math.max(0, wait),
    );
  }

  private update(): Omit<ArmUpdate, 'type' | 'id'> {
    const joints: ArmJointState[] = [];
    const problems: string[] = [];
    for (const controller of this.controllers) {
      if (!controller.joints) {
        problems.push(controller.error ?? `Reading the joints of ${controller.name}…`);
        continue;
      }
      for (const name of controller.joints) {
        const position = this.positions.get(name);
        const range = this.range(name);
        const calibration = this.calibrationJoint(name);
        joints.push({
          name,
          controller: controller.name,
          position: position === undefined ? null : round(position),
          lower: range.lower === null ? null : round(range.lower),
          upper: range.upper === null ? null : round(range.upper),
          located: calibration ? calibration.located : true,
          drivable: calibration ? calibration.drivable : true,
        });
      }
    }
    for (const [topic, message] of this.topicProblems) {
      // The calibration state only exists on the real robot
      if (topic !== absoluteTopic(this.options.calibrationTopic)) {
        problems.push(message);
      }
    }
    if (this.calibration && !this.calibration.active) {
      problems.push('The hardware interface is not active');
    } else if (this.calibration?.problem) {
      problems.push(this.calibration.problem);
    }
    return {
      joints,
      calibrating: this.calibration?.active === true && this.calibration.calibrating,
      problems,
      jog: this.jogStatus,
    };
  }
}

// One jog: from the first input to the end of the stream
class Jog {
  finished = false;
  private readonly arm: Arm;
  private readonly watcher: ArmWatcher;
  private current: ArmJogInput = {
    joints: {},
    cartesian: { x: 0, y: 0, z: 0 },
    ik: { group: '', link: '', frameId: '' },
  };
  private lastInputAt = 0;
  private stopped = false;
  // Commanded positions of the joints of every controller known
  private readonly command = new Map<string, number>();
  // The controllers this jog moved: they get its final command
  private readonly touched = new Set<string>();
  // Where the joints were when the jog started
  private readonly start = new Map<string, number>();
  // The controllers sent a trajectory from there already
  private readonly anchored = new Set<string>();
  // Why the moves are not checked for collisions, if they are not
  private unchecked: string | null = null;

  constructor(arm: Arm, watcher: ArmWatcher, first: ArmJogInput) {
    this.arm = arm;
    this.watcher = watcher;
    this.input(first);
    void this.run();
  }

  input(input: ArmJogInput): void {
    this.current = input;
    this.lastInputAt = performance.now();
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    // From where the arm is
    const missing: string[] = [];
    for (const controller of this.watcher.controllers) {
      for (const name of controller.joints ?? []) {
        const position = this.watcher.positions.get(name);
        if (position === undefined) {
          missing.push(name);
        } else {
          this.command.set(name, position);
          this.start.set(name, position);
        }
      }
    }
    if (this.command.size === 0 || missing.length > 0) {
      this.watcher.setJogStatus(
        'blocked',
        this.command.size === 0 && missing.length === 0
          ? 'No controller joints known yet'
          : `No joint state for ${missing.join(', ')}`,
      );
      this.finished = true;
      return;
    }
    this.watcher.setJogStatus('moving');

    let last = performance.now();
    try {
      while (!this.stopped) {
        const now = performance.now();
        if (now - this.lastInputAt > TELEOP_WATCHDOG_MS && hasInput(this.current)) {
          this.arm.logger.warn('An arm jog stopped without its final zero: holding the arm');
          this.current = { ...this.current, joints: {}, cartesian: { x: 0, y: 0, z: 0 } };
        }
        if (!hasInput(this.current)) {
          break;
        }
        // Real time: slow IK round trips do not slow the arm down
        const dt = Math.min(MAX_STEP_S, Math.max(PERIOD_S, (now - last) / 1000));
        last = now;
        const blocked = this.stepJoints(dt) ?? (await this.stepCartesian(dt));
        this.watcher.setJogStatus(blocked ? 'blocked' : 'moving', blocked ?? this.unchecked ?? '');
        this.publish(Math.max(LOOKAHEAD_S, dt * 1.5));
        await sleep(Math.max(0, PERIOD_MS - (performance.now() - now)));
      }
    } catch (e) {
      this.arm.logger.error(`Arm jog: ${errorMessage(e)}`);
    } finally {
      // Holds the arm where it got to
      this.publish(PERIOD_S);
      this.finished = true;
      if (!this.stopped) {
        this.watcher.setJogStatus('idle');
      }
    }
  }

  // Moves the joints jogged; returns why one cannot move, if so
  private stepJoints(dt: number): string | null {
    let blocked: string | null = null;
    for (const [name, speed] of Object.entries(this.current.joints)) {
      const previous = this.command.get(name);
      if (speed === 0 || previous === undefined) {
        continue;
      }
      const refusal = this.watcher.refusal(name);
      if (refusal) {
        blocked = refusal;
        continue;
      }
      const position = this.watcher.positions.get(name) ?? previous;
      const { value, limit } = clampCommand(
        previous + speed * dt,
        previous,
        position,
        this.watcher.range(name),
        Math.abs(speed) * MAX_LEAD_S + MIN_LEAD,
      );
      if (limit) {
        blocked = `${name} is at its ${limit} limit`;
      }
      this.command.set(name, value);
      const controller = this.watcher.controllerOf(name);
      if (controller) {
        this.touched.add(controller.name);
      }
    }
    return blocked;
  }

  // Moves the end effector, from where the joints are commanded; returns why
  // it cannot, if so
  private async stepCartesian(dt: number): Promise<string | null> {
    const { cartesian: velocity, ik } = this.current;
    if (isZero(velocity)) {
      return null;
    }
    const kinematics = this.watcher.kinematics();
    if (!kinematics) {
      return 'Waiting for the robot description: the Cartesian jog needs it';
    }
    if (!ik.link || !ik.frameId) {
      return 'Set the end effector link and the frame of the Cartesian jog';
    }
    for (const link of [ik.link, ik.frameId]) {
      if (!kinematics.hasLink(link)) {
        return `No link ${link} in the robot description`;
      }
    }
    // The joints moving the end effector that the jog may move
    const joints = kinematics
      .chain(ik.link)
      .map((j) => j.name)
      .filter((name) => this.command.has(name) && !this.watcher.refusal(name));
    if (joints.length === 0) {
      return `No joint of the controllers moves ${ik.link}`;
    }

    const state = new Map(this.watcher.positions);
    for (const [name, value] of this.command) {
      state.set(name, value);
    }
    const start = kinematics.position(ik.link, ik.frameId, state);
    const step: [number, number, number] = [velocity.x * dt, velocity.y * dt, velocity.z * dt];
    const goal: [number, number, number] = [start[0] + step[0], start[1] + step[1], start[2] + step[2]];

    const next = new Map(state);
    let limited: string | null = null;
    for (let i = 0; i < SOLVER_ITERATIONS; i++) {
      const at = kinematics.position(ik.link, ik.frameId, next);
      const error: [number, number, number] = [goal[0] - at[0], goal[1] - at[1], goal[2] - at[2]];
      if (Math.hypot(...error) < 1e-6) {
        break;
      }
      const dq = dampedLeastSquares(kinematics.jacobian(ik.link, ik.frameId, next, joints), error, DAMPING);
      joints.forEach((name, k) => {
        const previous = next.get(name)!;
        const { value, limit } = clampCommand(previous + dq[k], previous, previous, this.watcher.range(name), Infinity);
        if (limit) {
          limited = `${name} is at its ${limit} limit`;
        }
        next.set(name, value);
      });
    }
    // How far it went along the way asked, and aside
    const reached = kinematics.position(ik.link, ik.frameId, next);
    const moved = [reached[0] - start[0], reached[1] - start[1], reached[2] - start[2]];
    const length = Math.hypot(...step);
    const along = (moved[0] * step[0] + moved[1] * step[1] + moved[2] * step[2]) / length;
    const aside = Math.hypot(...moved.map((m, i) => m - (along * step[i]) / length));
    if (along < MIN_PROGRESS * length || aside > MAX_STRAY * length) {
      return limited ?? 'Cannot go further that way: out of reach';
    }
    const collision = await this.collision(ik.group, next);
    if (collision) {
      return collision;
    }
    for (const name of joints) {
      const previous = this.command.get(name)!;
      const position = this.watcher.positions.get(name) ?? previous;
      this.command.set(
        name,
        clampCommand(next.get(name)!, previous, position, this.watcher.range(name), CARTESIAN_LEAD).value,
      );
      const controller = this.watcher.controllerOf(name);
      if (controller) {
        this.touched.add(controller.name);
      }
    }
    return null;
  }

  // Why move_group finds the arm colliding at those positions, null if it
  // does not, or cannot tell
  private async collision(group: string, positions: Map<string, number>): Promise<string | null> {
    const client = this.arm.client('moveit_msgs/srv/GetStateValidity', '/check_state_validity');
    if (!client.isServiceServerAvailable()) {
      this.unchecked = 'Without collision checking: move_group is not running';
      return null;
    }
    this.unchecked = null;
    const response = (await client.sendRequestAsync(
      {
        robot_state: {
          joint_state: {
            header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
            name: [...positions.keys()],
            position: [...positions.values()],
            velocity: [],
            effort: [],
          },
          // The rest of the robot as move_group knows it
          is_diff: true,
        },
        group_name: group,
      },
      { timeout: SERVICE_TIMEOUT_MS },
    )) as { valid: boolean; contacts: { contact_body_1: string; contact_body_2: string }[] };
    if (response.valid) {
      return null;
    }
    const contact = response.contacts[0];
    return contact
      ? `That way ${contact.contact_body_1} hits ${contact.contact_body_2}`
      : 'That way the arm collides, or leaves its limits';
  }

  // The first trajectory of each controller starts from where the arm was:
  // a trajectory controller starts from its last command, which may be
  // another's or, once the hardware located the arm again, elsewhere
  private publish(ahead: number): void {
    for (const controller of this.watcher.controllers) {
      if (!controller.joints || !this.touched.has(controller.name)) {
        continue;
      }
      const positions = controller.joints.map((name) => this.command.get(name));
      const start = controller.joints.map((name) => this.start.get(name));
      if (positions.every((p): p is number => p !== undefined) && start.every((p): p is number => p !== undefined)) {
        const anchor = !this.anchored.has(controller.name);
        this.anchored.add(controller.name);
        this.arm.publishTrajectory(controller.name, controller.joints, positions, ahead, anchor ? start : null);
      }
    }
  }
}
