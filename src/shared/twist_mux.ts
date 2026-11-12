// A twist_mux node as the Twist Mux inspector shows it (see
// src/server/twist_mux.ts): its inputs and locks, as its parameters (or its
// diagnostics) configure them, its output, which input passes, and what
// became of the messages since the last update.
//
// twist_mux forwards an input's message to its output (cmd_vel_out) when that
// input has the priority: the highest of those not masked, the first by name
// among equals, above 0. An input is masked when its latest message is older
// than its timeout (0: never), or when its priority is below the lock
// priority: the highest of the locks locked, those whose latest
// std_msgs/Bool is true or older than their timeout.

// Updates a second at most, while anything changes
export const TWIST_MUX_RATE = 10;

// What became of an input's message: forwarded to the output; stopped by the
// input that has the priority (of a higher one, or the same and first by
// name, or one with no timeout that keeps it while silent); stopped by a lock
// (its priority below the lock priority); or not forwarded though it should
// have been, as far as the dashboard can tell (a lock published before it
// watched, say).
export type MuxFate = 'passed' | 'outranked' | 'locked' | 'dropped';

export const MUX_FATES: readonly MuxFate[] = ['passed', 'outranked', 'locked', 'dropped'];

export interface MuxInput {
  // Its parameters' prefix after `topics.`: "navigation" for topics.navigation
  name: string;
  // As the mux resolves it, in its namespace: /nav_vel
  topic: string;
  // In seconds: masked without a message for this long. 0: never.
  timeout: number;
  // 0 to 255
  priority: number;
  // The nodes publishing on it
  publishers: string[];
  // When its latest message came, on the server's clock; null: none since
  // the server watched it
  lastAt: number | null;
  // Messages a second, over the latest 2 s
  rate: number;
  // Its latest command: linear x, y, z, angular x, y, z
  twist: number[] | null;
  // No message within its timeout
  expired: boolean;
  // Expired, or of a priority below the lock priority
  masked: boolean;
  // It has the priority: its messages pass
  selected: boolean;
  // Its messages since the last update, by what became of them
  flow: Record<MuxFate, number>;
  // Why it is not followed as it should be: '' if it is
  error: string;
}

export interface MuxLock {
  // Its parameters' prefix after `locks.`: "pause" for locks.pause
  name: string;
  topic: string;
  // In seconds: locked without a message for this long. 0: never.
  timeout: number;
  // The inputs of a lower priority are masked while it is locked
  priority: number;
  publishers: string[];
  lastAt: number | null;
  // Its latest message's data; null: none since the server watched it
  value: boolean | null;
  // No message within its timeout: its publisher is gone
  expired: boolean;
  locked: boolean;
  // Whence `locked`: its messages; twist_mux's diagnostics, without them (e.g.
  // published once, before the server watched); else twist_mux's default
  // (free, or locked if it has a timeout)
  source: 'messages' | 'diagnostics' | 'default';
  // Its messages since the last update: true ones, false ones
  flow: { on: number; off: number };
  error: string;
}

export interface MuxOutput {
  // cmd_vel_out as remapped, e.g. /cmd_vel; null until the mux is found
  topic: string | null;
  // The other nodes publishing on it, bypassing the mux
  publishers: string[];
  lastAt: number | null;
  rate: number;
  twist: number[] | null;
  // The input its latest message came from; null: elsewhere, or not known
  source: string | null;
  // Its messages since the last update: from each input, by name, and from
  // other publishers
  flow: { inputs: Record<string, number>; other: number };
  error: string;
}

// twist_mux's own "Twist mux status" (diagnostic_updater, once a second)
export interface MuxDiagnostics {
  // OK 0, WARN 1, ERROR 2
  level: number;
  message: string;
  // Not received for a while
  stale: boolean;
  // Its "current priority": the lock priority, as twist_mux has it
  priority: number | null;
}

export interface TwistMuxState {
  // Its full name
  node: string;
  // The dashboard's own node, which may be among the publishers (its teleop
  // widgets')
  self: string;
  // In the ROS graph
  found: boolean;
  // What its inputs take and what it publishes, geometry_msgs/msg/Twist or
  // TwistStamped, as it subscribes and publishes: they may differ (some
  // versions take Twist and, with use_stamped, publish TwistStamped). null
  // until known.
  inputType: string | null;
  outputType: string | null;
  // Whence the inputs and locks: twist_mux's diagnostics, which say what it
  // runs with, or its parameters, until they come; null: neither yet
  configFrom: 'parameters' | 'diagnostics' | null;
  // By name, as twist_mux orders them
  inputs: MuxInput[];
  locks: MuxLock[];
  output: MuxOutput;
  // The highest priority of the locks locked; 0: none is
  lockPriority: number;
  // The lock that sets it
  lockedBy: string | null;
  // The input that has the priority
  selected: string | null;
  diagnostics: MuxDiagnostics | null;
  // What is wrong with its configuration, or why it is not followed
  problems: string[];
  // twist_mux's joystick relay feeding it, if one runs: its turbo and its
  // priority, which the inspector controls
  relay: MuxRelay | null;
  // Of the update, on the server's clock
  time: number;
}

// ── The joystick relay ───────────────────────────────────────────────────────
//
// twist_mux's joystick_relay scales a joystick's commands (joy_vel_in, each
// in [-1, 1]) into velocities (joy_vel_out, an input of the mux) by its turbo
// step, and passes them only while it has the priority, which it publishes,
// latched, on joy_priority: a lock of the mux, usually, masking the inputs
// below the joystick's while it is true (Manual), none (Autonomous). Both are
// changed by its actions, as a joystick's buttons do, through joy_teleop.

// What its actions do: toggle the priority; the turbo step up or down, the
// linear and the angular one together, or the angular one alone; both back
// to the initial step
export type RelayAction =
  | 'priority'
  | 'turbo-increase'
  | 'turbo-decrease'
  | 'turbo-angular-increase'
  | 'turbo-angular-decrease'
  | 'turbo-reset';

export const RELAY_ACTIONS: readonly RelayAction[] = [
  'priority',
  'turbo-increase',
  'turbo-decrease',
  'turbo-angular-increase',
  'turbo-angular-decrease',
  'turbo-reset',
];

// At full stick: at step 1, and at the last step (m/s, rad/s); evenly between
export interface TurboAxis {
  min: number;
  max: number;
}

// Its turbo.* parameters, as it read them when it started
export interface RelayTurbo {
  steps: number;
  // The step it starts with, and resets to
  initStep: number;
  forward: TurboAxis;
  backward: TurboAxis;
  lateral: TurboAxis;
  angular: TurboAxis;
}

// A turbo step, as far as the dashboard knows it: between low and high, known
// when they are equal. The relay does not publish it: it is seen in the
// velocities it publishes for the joystick's, or worked out from its actions'
// goals (whoever sent them) once known, or known when it starts or resets.
export interface StepRange {
  low: number;
  high: number;
}

export interface MuxRelay {
  // Its full name
  node: string;
  // Its actions it serves, by what they do
  actions: RelayAction[];
  // What it publishes its priority on (joy_priority as remapped)
  priorityTopic: string | null;
  // Its latest priority: true, Manual (the joystick's commands pass); null:
  // not heard of
  manual: boolean | null;
  // The mux's lock listening to its priority, and the input taking its
  // velocities; null: none
  lock: string | null;
  input: string | null;
  // The joystick's commands it takes, the velocities it publishes
  inputTopic: string | null;
  outputTopic: string | null;
  // null: its parameters not read
  turbo: RelayTurbo | null;
  // null while turbo is
  linearStep: StepRange | null;
  angularStep: StepRange | null;
  // Why it is not followed as it should be: '' if it is
  error: string;
}

// The velocity at full stick on an axis at a step (1 to steps), as the relay
// works it out
export function turboAt(axis: TurboAxis, steps: number, step: number): number {
  return steps > 1 ? axis.min + ((axis.max - axis.min) * (step - 1)) / (steps - 1) : axis.min;
}

// What the inspector asks of a twist_mux: one of its relay's actions; or one
// of its locks locked (true published on its topic) or released (false), or,
// for the lock listening to the relay's priority, the relay's priority
// toggled to it
export type MuxControl =
  | { kind: 'relay'; action: RelayAction }
  | { kind: 'lock'; lock: string; locked: boolean };
