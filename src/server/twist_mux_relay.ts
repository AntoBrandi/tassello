// twist_mux's joystick relay (joystick_relay.py) as the server follows it for
// the Twist Mux inspectors (twist_mux.ts): the actions it serves, its turbo
// parameters, its priority, and its turbo steps, which it does not publish.
// They are seen in the velocities it publishes for the joystick's commands
// (each scaled by the step's velocity at full stick), worked out from its
// actions' goals, whoever sent them, once known, and known when it starts or
// resets. Kept apart from twist_mux.ts to be tested without ROS.

import type { ParamInfo, ParamValue } from '../shared/parameters.ts';
import {
  RELAY_ACTIONS,
  turboAt,
  type MuxRelay,
  type RelayAction,
  type RelayTurbo,
  type StepRange,
  type TurboAxis,
} from '../shared/twist_mux.ts';

export const JOY_TURBO = 'twist_mux_msgs/action/JoyTurbo';
export const JOY_PRIORITY = 'twist_mux_msgs/action/JoyPriority';
export const GOAL_STATUS_ARRAY = 'action_msgs/msg/GoalStatusArray';

// The relay's names of its actions, by what they do
const ACTION_NAMES: Record<string, RelayAction> = {
  joy_priority_action: 'priority',
  joy_turbo_increase: 'turbo-increase',
  joy_turbo_decrease: 'turbo-decrease',
  joy_turbo_angular_increase: 'turbo-angular-increase',
  joy_turbo_angular_decrease: 'turbo-angular-decrease',
  joy_turbo_reset: 'turbo-reset',
};

// action_msgs/msg/GoalStatus.STATUS_SUCCEEDED: the relay's goals succeed at
// once, once done
const SUCCEEDED = 4;
// An action's goals are latched on its status topic (those of the latest 15
// minutes, by default): those that come this soon after subscribing were
// before
export const BASELINE_MS = 1000;
// A joystick's command and the velocity the relay published for it come this
// close
export const PAIR_MS = 100;
// Of the joystick's command, smaller is not looked at
const MIN_STICK = 0.01;

// What an action of the relay does, by its name (or its type, for its
// priority): null if not one of its
export function relayActionOf(action: string, type: string): RelayAction | null {
  const base = action.slice(action.lastIndexOf('/') + 1);
  const known = Object.hasOwn(ACTION_NAMES, base) ? ACTION_NAMES[base] : undefined;
  if (known) {
    return (known === 'priority') === (type === JOY_PRIORITY) ? known : null;
  }
  return type === JOY_PRIORITY ? 'priority' : null;
}

function numberOf(value: ParamValue | undefined): number | null {
  if (value && (value.type === 'double' || value.type === 'integer')) {
    const n = Number(value.value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Its turbo, from its parameters, with its defaults: null without
// turbo.steps (not a relay's, or not declared)
export function turboFromParameters(params: Iterable<ParamInfo>): RelayTurbo | null {
  const values = new Map<string, ParamValue>();
  for (const param of params) {
    values.set(param.name, param.value);
  }
  const number = (name: string, fallback: number) => numberOf(values.get(`turbo.${name}`)) ?? fallback;
  const steps = numberOf(values.get('turbo.steps'));
  if (steps === null || steps < 1) {
    return null;
  }
  const n = Math.trunc(steps);
  const forward: TurboAxis = { min: number('linear_forward_min', 1), max: number('linear_forward_max', 1) };
  const backward: TurboAxis = {
    min: number('linear_backward_min', forward.min),
    max: number('linear_backward_max', forward.max),
  };
  const lateral: TurboAxis = { min: number('linear_lateral_min', 1), max: number('linear_lateral_max', 1) };
  const angular: TurboAxis = { min: number('angular_min', 1), max: number('angular_max', 1) };
  // As the relay falls back, out of range; at least 1, which it needs
  const fallback = Math.floor((n + 1) / 2);
  const init = number('init_step', fallback);
  const initStep = Math.max(1, Math.trunc(init < 0 || init > n ? fallback : init));
  return { steps: n, initStep, forward, backward, lateral, angular };
}

// The step at which the axis's velocity at full stick is `ratio`: null if
// none is, or if several are (its min and max the same)
export function stepOfRatio(axis: TurboAxis, steps: number, ratio: number): number | null {
  if (!Number.isFinite(ratio)) {
    return null;
  }
  const matches: number[] = [];
  for (let step = 1; step <= steps; step++) {
    const value = turboAt(axis, steps, step);
    if (Math.abs(value - ratio) <= 1e-6 * Math.max(1, Math.abs(value))) {
      matches.push(step);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// The linear and the angular steps a joystick's command and the velocity the
// relay published for it say: null those they do not
export function stepsOfCommand(
  turbo: RelayTurbo,
  command: number[],
  velocity: number[],
): { linear: number | null; angular: number | null } {
  const [x, y, , , , z] = command;
  const [vx, vy, , , , vz] = velocity;
  let linear: number | null = null;
  if (Math.abs(x) >= MIN_STICK) {
    linear = stepOfRatio(x >= 0 ? turbo.forward : turbo.backward, turbo.steps, vx / x);
  }
  if (linear === null && Math.abs(y) >= MIN_STICK) {
    linear = stepOfRatio(turbo.lateral, turbo.steps, vy / y);
  }
  const angular = Math.abs(z) >= MIN_STICK ? stepOfRatio(turbo.angular, turbo.steps, vz / z) : null;
  return { linear, angular };
}

function shift(range: StepRange, by: number, steps: number): StepRange {
  const clamp = (step: number) => Math.min(steps, Math.max(1, step));
  return { low: clamp(range.low + by), high: clamp(range.high + by) };
}

// The steps after one of the relay's actions, as it does it: at the ends, a
// step up or down does nothing
export function stepsAfter(
  steps: { linear: StepRange; angular: StepRange },
  action: RelayAction,
  turbo: RelayTurbo,
): { linear: StepRange; angular: StepRange } {
  const n = turbo.steps;
  switch (action) {
    case 'turbo-increase':
      return { linear: shift(steps.linear, 1, n), angular: shift(steps.angular, 1, n) };
    case 'turbo-decrease':
      return { linear: shift(steps.linear, -1, n), angular: shift(steps.angular, -1, n) };
    case 'turbo-angular-increase':
      return { linear: steps.linear, angular: shift(steps.angular, 1, n) };
    case 'turbo-angular-decrease':
      return { linear: steps.linear, angular: shift(steps.angular, -1, n) };
    case 'turbo-reset':
      return { linear: known(turbo.initStep), angular: known(turbo.initStep) };
    default:
      return steps;
  }
}

function known(step: number): StepRange {
  return { low: step, high: step };
}

// Any step, as far as the dashboard knows
function unknown(turbo: RelayTurbo): { linear: StepRange; angular: StepRange } {
  return { linear: { low: 1, high: turbo.steps }, angular: { low: 1, high: turbo.steps } };
}

function initial(turbo: RelayTurbo): { linear: StepRange; angular: StepRange } {
  return { linear: known(turbo.initStep), angular: known(turbo.initStep) };
}

function component(vector: unknown, axis: 'x' | 'y' | 'z'): number {
  const value = (vector as Record<string, unknown> | null)?.[axis];
  return typeof value === 'number' ? value : Number.NaN;
}

// A geometry_msgs/msg/Twist's numbers: linear x, y, z, angular x, y, z
export function twistNumbers(message: unknown): number[] {
  const { linear, angular } = (message ?? {}) as Record<string, unknown>;
  return [
    component(linear, 'x'),
    component(linear, 'y'),
    component(linear, 'z'),
    component(angular, 'x'),
    component(angular, 'y'),
    component(angular, 'z'),
  ];
}

// The relay in the ROS graph: what it serves, publishes and takes
export interface RelayGraph {
  node: string;
  // Each action's name, by what it does
  actions: Map<RelayAction, string>;
  priorityTopic: string | null;
  inputTopic: string | null;
  outputTopic: string | null;
}

// Of the graph's relays, the one of this mux: the one publishing on one of
// its inputs, else on one of its locks, else the only one
export function pickRelay(relays: RelayGraph[], inputTopics: Set<string>, lockTopics: Set<string>): RelayGraph | null {
  const score = (relay: RelayGraph) =>
    (relay.outputTopic && inputTopics.has(relay.outputTopic) ? 2 : 0) +
    (relay.priorityTopic && lockTopics.has(relay.priorityTopic) ? 1 : 0);
  const ranked = [...relays].sort((a, b) => score(b) - score(a) || a.node.localeCompare(b.node));
  if (ranked.length === 0) {
    return null;
  }
  return score(ranked[0]) > 0 || ranked.length === 1 ? ranked[0] : null;
}

interface Timed {
  at: number;
  twist: number[];
}

export class RelayTracker {
  private graph: RelayGraph | null = null;
  // The graph's relays at the last look, and whether it showed the mux (its
  // discovery done): a relay that comes after started then
  private present = new Set<string>();
  private settled = false;
  // Started since followed: at its initial steps, once its parameters say
  // them
  private started = false;
  private turbo: RelayTurbo | null = null;
  private paramsError = '';
  private priorityValue: boolean | null = null;
  // null while turbo is
  private steps: { linear: StepRange; angular: StepRange } | null = null;
  private lastCommand: Timed | null = null;
  private lastVelocity: Timed | null = null;
  // Of each action's status topic: since when subscribed, its goals that
  // succeeded, and whether its first message (the latched goals) is to come
  private readonly statuses = new Map<RelayAction, { at: number; done: Set<string>; first: boolean }>();
  private readonly errors = new Map<string, string>();

  get node(): string | null {
    return this.graph?.node ?? null;
  }

  get relay(): RelayGraph | null {
    return this.graph;
  }

  // Its latest priority: true, Manual; null: not heard of
  get manual(): boolean | null {
    return this.priorityValue;
  }

  // The mux's relay found in the graph now (null: none), of all the relays
  // there; settled: the graph shows the mux
  setGraph(graph: RelayGraph | null, relays: string[] = graph ? [graph.node] : [], settled = true): void {
    const before = this.graph;
    const appeared = graph !== null && this.settled && !this.present.has(graph.node);
    this.present = new Set(relays);
    this.settled ||= settled;
    if (!graph) {
      this.graph = null;
      return;
    }
    if (before?.node !== graph.node) {
      // Another one, or the same started again: nothing of it known
      this.started = appeared;
      this.priorityValue = null;
      this.lastCommand = null;
      this.lastVelocity = null;
      this.turbo = null;
      this.steps = null;
      this.paramsError = '';
      this.statuses.clear();
      this.errors.clear();
    } else if (before.priorityTopic !== graph.priorityTopic) {
      this.priorityValue = null;
    }
    this.graph = graph;
  }

  // Its parameters (null: not read, with why)
  setParameters(params: ParamInfo[] | null, error = ''): void {
    if (!params) {
      // As they were read, if they were
      this.paramsError = this.turbo ? '' : error;
      return;
    }
    const turbo = turboFromParameters(params);
    this.paramsError = turbo ? '' : `${this.node ?? 'The relay'} has no turbo.steps parameter`;
    if (!turbo) {
      this.turbo = null;
      this.steps = null;
      return;
    }
    if (!this.turbo || JSON.stringify(turbo) !== JSON.stringify(this.turbo)) {
      const kept = this.steps && this.steps.linear.high <= turbo.steps && this.steps.angular.high <= turbo.steps;
      this.steps = this.started ? initial(turbo) : kept && this.steps ? this.steps : unknown(turbo);
    }
    this.started = false;
    this.turbo = turbo;
  }

  // Of the subscriptions twist_mux.ts makes, by key ("priority", "in", "out",
  // "status <action>"): since when (null: none), and why it could not
  setSubscribed(key: string, at: number | null, error = ''): void {
    if (error) {
      this.errors.set(key, error);
    } else {
      this.errors.delete(key);
    }
    if (key.startsWith('status ')) {
      const action = key.slice('status '.length) as RelayAction;
      if (at === null) {
        this.statuses.delete(action);
      } else {
        this.statuses.set(action, { at, done: new Set(), first: true });
      }
    }
  }

  // Its joy_priority: std_msgs/Bool
  priority(message: unknown): void {
    this.priorityValue = (message as { data?: unknown } | null)?.data === true;
  }

  // A joystick's command (joy_vel_in), and a velocity it published
  // (joy_vel_out): of the same, they tell its steps
  command(message: unknown, now: number): void {
    this.lastCommand = { at: now, twist: twistNumbers(message) };
    this.pair();
  }

  velocity(message: unknown, now: number): void {
    this.lastVelocity = { at: now, twist: twistNumbers(message) };
    this.pair();
  }

  // An action's status topic (action_msgs/msg/GoalStatusArray): each of its
  // goals that succeeded since the latched ones is one of the action done
  goalStatuses(action: RelayAction, message: unknown, now: number): void {
    const status = this.statuses.get(action);
    if (!status) {
      return;
    }
    const list = ((message as { status_list?: unknown[] } | null)?.status_list ?? []) as {
      goal_info?: { goal_id?: { uuid?: ArrayLike<number> } };
      status?: number;
    }[];
    const done = new Set<string>();
    for (const entry of list) {
      if (entry.status === SUCCEEDED) {
        done.add(Array.from(entry.goal_info?.goal_id?.uuid ?? [], (b) => b.toString(16).padStart(2, '0')).join(''));
      }
    }
    const baseline = status.first && now - status.at < BASELINE_MS;
    status.first = false;
    if (!baseline) {
      for (const id of done) {
        if (!status.done.has(id)) {
          this.apply(action);
        }
      }
    }
    // Those gone from the list never come back
    status.done = done;
  }

  // One of its actions done, whoever asked: the priority comes on its topic
  apply(action: RelayAction): void {
    if (this.turbo && this.steps && action !== 'priority') {
      this.steps = stepsAfter(this.steps, action, this.turbo);
    }
  }

  snapshot(inputs: Map<string, string>, locks: Map<string, string>): MuxRelay | null {
    const graph = this.graph;
    if (!graph) {
      return null;
    }
    const nameOf = (topics: Map<string, string>, topic: string | null) =>
      topic === null ? null : ([...topics].find(([, t]) => t === topic)?.[0] ?? null);
    return {
      node: graph.node,
      actions: RELAY_ACTIONS.filter((action) => graph.actions.has(action)),
      priorityTopic: graph.priorityTopic,
      manual: this.priorityValue,
      lock: nameOf(locks, graph.priorityTopic),
      input: nameOf(inputs, graph.outputTopic),
      inputTopic: graph.inputTopic,
      outputTopic: graph.outputTopic,
      turbo: this.turbo,
      linearStep: this.turbo ? (this.steps?.linear ?? null) : null,
      angularStep: this.turbo ? (this.steps?.angular ?? null) : null,
      error: [...this.errors.values()][0] ?? this.paramsError,
    };
  }

  private pair(): void {
    const command = this.lastCommand;
    const velocity = this.lastVelocity;
    if (!command || !velocity || !this.turbo || !this.steps || Math.abs(command.at - velocity.at) > PAIR_MS) {
      return;
    }
    const { linear, angular } = stepsOfCommand(this.turbo, command.twist, velocity.twist);
    if (linear !== null) {
      this.steps = { ...this.steps, linear: known(linear) };
    }
    if (angular !== null) {
      this.steps = { ...this.steps, angular: known(angular) };
    }
  }
}
