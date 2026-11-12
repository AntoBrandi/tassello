import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParamInfo, ParamValue } from '../shared/parameters.ts';
import { turboAt, type RelayTurbo } from '../shared/twist_mux.ts';
import {
  BASELINE_MS,
  JOY_PRIORITY,
  JOY_TURBO,
  pickRelay,
  RelayTracker,
  relayActionOf,
  stepOfRatio,
  stepsAfter,
  stepsOfCommand,
  topicOfType,
  turboFromParameters,
  type RelayGraph,
} from './twist_mux_relay.ts';

const param = (name: string, value: ParamValue['value'], type: ParamValue['type']): ParamInfo => ({
  name,
  value: { type, value },
  descriptor: null,
});

// twist_mux's config/joystick.yaml
function joystickParams(): ParamInfo[] {
  return [
    param('priority', true, 'bool'),
    param('turbo.linear_forward_min', 0.5, 'double'),
    param('turbo.linear_forward_max', 1.0, 'double'),
    param('turbo.linear_backward_min', 0.25, 'double'),
    param('turbo.linear_backward_max', 0.5, 'double'),
    param('turbo.linear_lateral_min', 1.0, 'double'),
    param('turbo.linear_lateral_max', 1.0, 'double'),
    param('turbo.angular_min', 0.7, 'double'),
    param('turbo.angular_max', 1.2, 'double'),
    param('turbo.steps', 4, 'integer'),
    // As the relay declares it by default: floor((steps + 1) / 2), a double
    param('turbo.init_step', 2.0, 'double'),
  ];
}

const twist = (x: number, y: number, z: number) => ({
  linear: { x, y, z: 0 },
  angular: { x: 0, y: 0, z },
});

// What the relay publishes for a joystick's command at a step
function scaled(turbo: RelayTurbo, x: number, z: number, linear: number, angular: number) {
  const axis = x >= 0 ? turbo.forward : turbo.backward;
  return twist(x * turboAt(axis, turbo.steps, linear), 0, z * turboAt(turbo.angular, turbo.steps, angular));
}

function relayGraph(fields: Partial<RelayGraph> = {}): RelayGraph {
  return {
    node: '/joystick_relay',
    actions: new Map([
      ['priority', '/joy_priority_action'],
      ['turbo-increase', '/joy_turbo_increase'],
      ['turbo-decrease', '/joy_turbo_decrease'],
      ['turbo-angular-increase', '/joy_turbo_angular_increase'],
      ['turbo-angular-decrease', '/joy_turbo_angular_decrease'],
      ['turbo-reset', '/joy_turbo_reset'],
    ]),
    priorityTopic: '/joy_priority',
    inputTopic: '/input_joy/cmd_vel',
    outputTopic: '/joy_vel',
    ...fields,
  };
}

const goals = (...ids: number[]) => ({
  status_list: ids.map((id) => ({ goal_info: { goal_id: { uuid: new Array(16).fill(id) } }, status: 4 })),
});

const MUX_INPUTS = new Map([
  ['joystick', '/joy_vel'],
  ['navigation', '/nav_vel'],
]);
const MUX_LOCKS = new Map([
  ['joystick', '/joy_priority'],
  ['pause', '/pause_navigation'],
]);

// A tracker following the example relay, its turbo read, its turbo-increase,
// -decrease and -reset status topics subscribed at 0 and their latched goals
// come
function following(): RelayTracker {
  const tracker = new RelayTracker();
  tracker.setGraph(relayGraph());
  tracker.setParameters(joystickParams());
  for (const action of ['turbo-increase', 'turbo-decrease', 'turbo-reset'] as const) {
    tracker.setSubscribed(`status ${action}`, 0);
    tracker.goalStatuses(action, goals(), 10);
  }
  return tracker;
}

test('relayActionOf tells the relay’s actions by their names, and its priority by its type', () => {
  assert.equal(relayActionOf('/joy_turbo_increase', JOY_TURBO), 'turbo-increase');
  assert.equal(relayActionOf('/robot/joy_turbo_angular_decrease', JOY_TURBO), 'turbo-angular-decrease');
  assert.equal(relayActionOf('/joy_priority_action', JOY_PRIORITY), 'priority');
  // Remapped: its priority still, the turbo's not
  assert.equal(relayActionOf('/teleop/toggle_mode', JOY_PRIORITY), 'priority');
  assert.equal(relayActionOf('/teleop/faster', JOY_TURBO), null);
  // Not of the type its name says
  assert.equal(relayActionOf('/joy_priority_action', JOY_TURBO), null);
  assert.equal(relayActionOf('/constructor', JOY_TURBO), null);
});

test('turboFromParameters reads the turbo as the relay does, with its defaults', () => {
  const turbo = turboFromParameters(joystickParams());
  assert.deepEqual(turbo, {
    steps: 4,
    initStep: 2,
    forward: { min: 0.5, max: 1 },
    backward: { min: 0.25, max: 0.5 },
    lateral: { min: 1, max: 1 },
    angular: { min: 0.7, max: 1.2 },
  });
  // Backward as forward, unless said; init_step out of range falls back
  const fewer = turboFromParameters([
    param('turbo.steps', 3, 'integer'),
    param('turbo.linear_forward_min', 0.2, 'double'),
    param('turbo.linear_forward_max', 0.8, 'double'),
    param('turbo.init_step', 7, 'integer'),
  ]);
  assert.deepEqual(fewer?.backward, { min: 0.2, max: 0.8 });
  assert.deepEqual(fewer?.angular, { min: 1, max: 1 });
  assert.equal(fewer?.initStep, 2);
  assert.equal(turboFromParameters([param('priority', true, 'bool')]), null);
});

test('turboAt spreads the velocities evenly between the first step and the last', () => {
  const axis = { min: 0.5, max: 1 };
  assert.equal(turboAt(axis, 4, 1), 0.5);
  assert.ok(Math.abs(turboAt(axis, 4, 2) - 2 / 3) < 1e-12);
  assert.equal(turboAt(axis, 4, 4), 1);
  assert.equal(turboAt(axis, 1, 1), 0.5);
});

test('stepOfRatio finds the step of a velocity at full stick, if only one has it', () => {
  const axis = { min: 0.5, max: 1 };
  assert.equal(stepOfRatio(axis, 4, 0.5), 1);
  assert.equal(stepOfRatio(axis, 4, turboAt(axis, 4, 3)), 3);
  assert.equal(stepOfRatio(axis, 4, 0.7), null);
  // The same at every step: no telling
  assert.equal(stepOfRatio({ min: 1, max: 1 }, 4, 1), null);
  assert.equal(stepOfRatio(axis, 4, Number.NaN), null);
});

test('stepsOfCommand reads the steps from a command and the velocity published for it', () => {
  const turbo = turboFromParameters(joystickParams()) as RelayTurbo;
  const command = [0.5, 0, 0, 0, 0, -0.4];
  const at = (linear: number, angular: number) => {
    const { linear: l, angular: a } = scaled(turbo, 0.5, -0.4, linear, angular);
    return [l.x, l.y, l.z, a.x, a.y, a.z];
  };
  assert.deepEqual(stepsOfCommand(turbo, command, at(3, 1)), { linear: 3, angular: 1 });
  // Backward, its own velocities
  const back = scaled(turbo, -0.8, 0, 4, 2);
  assert.deepEqual(stepsOfCommand(turbo, [-0.8, 0, 0, 0, 0, 0], [back.linear.x, 0, 0, 0, 0, 0]), {
    linear: 4,
    angular: null,
  });
  // Lateral is the same at every step: no telling
  assert.deepEqual(stepsOfCommand(turbo, [0, 0.5, 0, 0, 0, 0], [0, 0.5, 0, 0, 0, 0]), { linear: null, angular: null });
  // The zero it publishes for an invalid command
  assert.deepEqual(stepsOfCommand(turbo, command, [0, 0, 0, 0, 0, 0]), { linear: null, angular: null });
});

test('stepsAfter steps as the relay does, stopping at the ends', () => {
  const turbo = turboFromParameters(joystickParams()) as RelayTurbo;
  const at = (linear: number, angular: number) => ({
    linear: { low: linear, high: linear },
    angular: { low: angular, high: angular },
  });
  assert.deepEqual(stepsAfter(at(2, 2), 'turbo-increase', turbo), at(3, 3));
  assert.deepEqual(stepsAfter(at(4, 3), 'turbo-increase', turbo), at(4, 4));
  assert.deepEqual(stepsAfter(at(1, 2), 'turbo-decrease', turbo), at(1, 1));
  assert.deepEqual(stepsAfter(at(2, 2), 'turbo-angular-increase', turbo), at(2, 3));
  assert.deepEqual(stepsAfter(at(2, 2), 'turbo-angular-decrease', turbo), at(2, 1));
  assert.deepEqual(stepsAfter(at(4, 1), 'turbo-reset', turbo), at(2, 2));
  // Not known: three steps up from anywhere is the last
  let steps = { linear: { low: 1, high: 4 }, angular: { low: 1, high: 4 } };
  for (let i = 0; i < 3; i++) {
    steps = stepsAfter(steps, 'turbo-increase', turbo);
  }
  assert.deepEqual(steps, at(4, 4));
});

test('pickRelay takes the relay publishing on an input of the mux, else on a lock, else the only one', () => {
  const inputs = new Set(MUX_INPUTS.values());
  const locks = new Set(MUX_LOCKS.values());
  const elsewhere = relayGraph({ node: '/a_relay', outputTopic: '/other_vel', priorityTopic: '/other_priority' });
  const ours = relayGraph();
  assert.equal(pickRelay([elsewhere, ours], inputs, locks)?.node, '/joystick_relay');
  assert.equal(
    pickRelay([elsewhere, relayGraph({ outputTopic: null })], inputs, locks)?.node,
    '/joystick_relay',
  );
  assert.equal(pickRelay([elsewhere], inputs, locks)?.node, '/a_relay');
  assert.equal(pickRelay([elsewhere, relayGraph({ node: '/b', outputTopic: null, priorityTopic: null })], inputs, locks), null);
  assert.equal(pickRelay([], inputs, locks), null);
});

test('pickRelay prefers the joystick relay to another node serving only a priority action, on the mux too', () => {
  const inputs = new Set([...MUX_INPUTS.values(), '/assisted_vel']);
  const locks = new Set([...MUX_LOCKS.values(), '/assisted_teleop_priority']);
  // A controller's assisted teleoperation: before the relay by name
  const assisted = relayGraph({
    node: '/controller_server',
    actions: new Map([['priority', '/assisted_teleop_priority_action']]),
    priorityTopic: '/assisted_teleop_priority',
    inputTopic: '/joy_vel',
    outputTopic: '/assisted_vel',
  });
  assert.equal(pickRelay([assisted, relayGraph()], inputs, locks)?.node, '/joystick_relay');
  assert.equal(pickRelay([relayGraph(), assisted], inputs, locks)?.node, '/joystick_relay');
  // Still, the one on the mux first
  assert.equal(pickRelay([assisted, relayGraph({ outputTopic: '/elsewhere' })], inputs, locks)?.node, '/controller_server');
});

test('topicOfType takes a topic of the type, one preferred if any', () => {
  const topics = [
    { name: '/cmd_vel', types: ['geometry_msgs/msg/Twist'] },
    { name: '/is_charging', types: ['std_msgs/msg/Bool'] },
    { name: '/assisted_vel', types: ['geometry_msgs/msg/Twist'] },
  ];
  assert.equal(topicOfType(topics, 'geometry_msgs/msg/Twist', new Set(['/assisted_vel'])), '/assisted_vel');
  assert.equal(topicOfType(topics, 'geometry_msgs/msg/Twist', new Set()), '/cmd_vel');
  assert.equal(topicOfType(topics, 'std_msgs/msg/Bool', new Set(['/joy_priority'])), '/is_charging');
  assert.equal(topicOfType(topics, 'std_msgs/msg/String', new Set()), null);
});

test('the tracker says the relay’s priority, its lock and input on the mux, and its turbo', () => {
  const tracker = new RelayTracker();
  assert.equal(tracker.snapshot(MUX_INPUTS, MUX_LOCKS), null);
  // Back, another relay in the graph too
  tracker.setGraph(relayGraph(), ['/joystick_relay', '/other_relay']);
  let relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.equal(relay?.manual, null);
  assert.equal(relay?.lock, 'joystick');
  assert.equal(relay?.input, 'joystick');
  assert.deepEqual(relay?.actions, [
    'priority',
    'turbo-increase',
    'turbo-decrease',
    'turbo-angular-increase',
    'turbo-angular-decrease',
    'turbo-reset',
  ]);
  assert.equal(relay?.turbo, null);
  assert.equal(relay?.linearStep, null);

  tracker.priority({ data: true });
  tracker.setParameters(joystickParams());
  relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.equal(relay?.manual, true);
  assert.equal(relay?.turbo?.steps, 4);
  // Not known yet
  assert.deepEqual(relay?.linearStep, { low: 1, high: 4 });
  assert.equal(relay?.error, '');

  tracker.priority({ data: false });
  assert.equal(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.manual, false);

  // Its parameters not read: why, until they are
  const other = new RelayTracker();
  other.setGraph(relayGraph());
  other.setParameters(null, 'No parameter services');
  assert.equal(other.snapshot(MUX_INPUTS, MUX_LOCKS)?.error, 'No parameter services');
});

test('the steps are seen in the velocities the relay publishes for the joystick’s commands', () => {
  const tracker = following();
  const turbo = turboFromParameters(joystickParams()) as RelayTurbo;
  tracker.command(twist(0.6, 0, 0.5), 1000);
  tracker.velocity(scaled(turbo, 0.6, 0.5, 3, 4), 1004);
  let relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.deepEqual(relay?.linearStep, { low: 3, high: 3 });
  assert.deepEqual(relay?.angularStep, { low: 4, high: 4 });

  // The velocity first, then its command; too far apart, not paired
  tracker.velocity(scaled(turbo, 0.6, 0, 1, 4), 2000);
  tracker.command(twist(0.6, 0, 0), 2003);
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 1, high: 1 });
  tracker.command(twist(0.6, 0, 0), 3000);
  tracker.velocity(scaled(turbo, 0.6, 0, 4, 4), 3000 + 500);
  relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.deepEqual(relay?.linearStep, { low: 1, high: 1 });
  assert.deepEqual(relay?.angularStep, { low: 4, high: 4 });
});

test('the steps follow the turbo goals that succeed, whoever sent them, not those latched', () => {
  const tracker = new RelayTracker();
  tracker.setGraph(relayGraph());
  tracker.setParameters(joystickParams());
  tracker.setSubscribed('status turbo-reset', 0);
  tracker.setSubscribed('status turbo-increase', 0);
  // Latched: done before, already in the steps, whatever they are
  tracker.goalStatuses('turbo-reset', goals(1), 50);
  tracker.goalStatuses('turbo-increase', goals(2, 3), 60);
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 1, high: 4 });

  // A reset: the initial step, then one up
  tracker.goalStatuses('turbo-reset', goals(1, 4), BASELINE_MS + 100);
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 2, high: 2 });
  tracker.goalStatuses('turbo-increase', goals(2, 3, 5), BASELINE_MS + 200);
  // The same list again: nothing new
  tracker.goalStatuses('turbo-increase', goals(2, 3, 5), BASELINE_MS + 300);
  let relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.deepEqual(relay?.linearStep, { low: 3, high: 3 });
  assert.deepEqual(relay?.angularStep, { low: 3, high: 3 });

  // Accepted, not yet succeeded: not counted until it is
  tracker.goalStatuses(
    'turbo-increase',
    { status_list: [{ goal_info: { goal_id: { uuid: new Array(16).fill(6) } }, status: 2 }] },
    BASELINE_MS + 400,
  );
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 3, high: 3 });
  tracker.goalStatuses('turbo-increase', goals(6), BASELINE_MS + 500);
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 4, high: 4 });

  // A first goal with no latched list before: counted, once the baseline is past
  const fresh = new RelayTracker();
  fresh.setGraph(relayGraph());
  fresh.setParameters(joystickParams());
  fresh.setSubscribed('status turbo-reset', 0);
  fresh.goalStatuses('turbo-reset', goals(9), BASELINE_MS * 3);
  assert.deepEqual(fresh.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 2, high: 2 });
});

test('a relay that comes once the graph is followed started then, at its initial steps', () => {
  const tracker = new RelayTracker();
  // Not yet discovered: what comes may have been there
  tracker.setGraph(null, [], false);
  tracker.setGraph(relayGraph());
  tracker.setParameters(joystickParams());
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 1, high: 4 });

  const later = new RelayTracker();
  later.setGraph(null, [], true);
  later.setGraph(relayGraph());
  later.setParameters(joystickParams());
  assert.deepEqual(later.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 2, high: 2 });

  // There, but not the mux's: picked later, it did not start then
  const unpicked = new RelayTracker();
  unpicked.setGraph(null, ['/joystick_relay'], true);
  unpicked.setGraph(relayGraph());
  unpicked.setParameters(joystickParams());
  assert.deepEqual(unpicked.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 1, high: 4 });
});

test('a relay that goes and comes back started anew, at its initial steps', () => {
  const tracker = new RelayTracker();
  // Found at the first look: started before
  tracker.setGraph(relayGraph(), ['/joystick_relay'], true);
  tracker.setParameters(joystickParams());
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 1, high: 4 });
  const turbo = turboFromParameters(joystickParams()) as RelayTurbo;
  tracker.command(twist(1, 0, 1), 1000);
  tracker.velocity(scaled(turbo, 1, 1, 4, 4), 1000);
  tracker.priority({ data: false });
  tracker.setGraph(null);
  assert.equal(tracker.snapshot(MUX_INPUTS, MUX_LOCKS), null);
  // Back, another relay in the graph too
  tracker.setGraph(relayGraph(), ['/joystick_relay', '/other_relay']);
  let relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.equal(relay?.manual, null);
  // Its parameters read again
  assert.equal(relay?.linearStep, null);
  tracker.setParameters(joystickParams());
  relay = tracker.snapshot(MUX_INPUTS, MUX_LOCKS);
  assert.deepEqual(relay?.linearStep, { low: 2, high: 2 });
  assert.deepEqual(relay?.angularStep, { low: 2, high: 2 });

  // Another relay, there before: nothing known
  tracker.setGraph(relayGraph({ node: '/other_relay' }), ['/joystick_relay', '/other_relay']);
  tracker.setParameters(joystickParams());
  assert.deepEqual(tracker.snapshot(MUX_INPUTS, MUX_LOCKS)?.linearStep, { low: 1, high: 4 });
});
