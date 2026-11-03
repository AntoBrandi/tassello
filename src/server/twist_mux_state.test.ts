import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParamInfo, ParamValue } from '../shared/parameters.ts';
import type { DiagnosticEntry } from '../shared/protocol.ts';
import {
  BOOL,
  commandOf,
  configFromParameters,
  DECIDE_MS,
  DIAGNOSTICS_WAIT_MS,
  isMuxStatus,
  MuxTracker,
  OUTPUT_READY_MS,
  outputOf,
  parseMuxStatus,
  resolveTopic,
  TWIST,
  TWIST_STAMPED,
  WARMUP_MS,
  type MuxGraph,
} from './twist_mux_state.ts';

const param = (name: string, value: ParamValue['value'], type: ParamValue['type']): ParamInfo => ({
  name,
  value: { type, value },
  descriptor: null,
});

// twist_mux's own example configuration (config/twist_mux_topics.yaml and
// twist_mux_locks.yaml), as its parameters
function exampleParams(): ParamInfo[] {
  const handle = (group: string, name: string, topic: string, timeout: number, priority: number) => [
    param(`${group}.${name}.topic`, topic, 'string'),
    param(`${group}.${name}.timeout`, timeout, 'double'),
    param(`${group}.${name}.priority`, priority, 'integer'),
  ];
  return [
    ...handle('topics', 'navigation', 'nav_vel', 0.5, 10),
    ...handle('topics', 'joystick', 'joy_vel', 0.5, 100),
    ...handle('topics', 'keyboard', 'key_vel', 0.5, 90),
    ...handle('topics', 'tablet', 'tab_vel', 0.5, 100),
    ...handle('locks', 'pause', 'pause_navigation', 0, 100),
    ...handle('locks', 'loop_closure', 'stop_closing_loop', 0, 200),
    ...handle('locks', 'joystick', 'joy_priority', 0, 100),
    param('use_sim_time', false, 'bool'),
  ];
}

// As twist_mux 4.3 published it for that configuration
function exampleStatus(fields: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
  const value = (state: string, topic: string, timeout: string, priority: number) =>
    ` ${state} (listening to ${topic} @ ${timeout}s with priority #${priority})`;
  return {
    id: 1,
    name: 'twist_mux: Twist mux status',
    level: 0,
    message: 'ok',
    hardwareId: 'none',
    values: [
      { key: 'velocity topics.joystick', value: value('masked', 'joy_vel', '0.500000', 100) },
      { key: 'velocity topics.keyboard', value: value('masked', 'key_vel', '0.500000', 90) },
      { key: 'velocity topics.navigation', value: value('masked', 'nav_vel', '0.500000', 10) },
      { key: 'velocity topics.tablet', value: value('masked', 'tab_vel', '0.500000', 100) },
      { key: 'lock locks.joystick', value: value('free', 'joy_priority', '0.000000', 100) },
      { key: 'lock locks.loop_closure', value: value('free', 'stop_closing_loop', '0.000000', 200) },
      { key: 'lock locks.pause', value: value('locked', 'pause_navigation', '0.000000', 100) },
      { key: 'current priority', value: '100' },
      { key: 'loop time in [sec]', value: '0' },
      { key: 'data age in [sec]', value: '0' },
    ],
    stale: false,
    updated: 0,
    since: 0,
    ...fields,
  };
}

const twist = (x: number, z = 0) => ({ linear: { x, y: 0, z: 0 }, angular: { x: 0, y: 0, z } });

// The example's mux, running, publishing Twist on /cmd_vel
function exampleGraph(fields: Partial<MuxGraph> = {}): MuxGraph {
  const inputs = ['/joy_vel', '/key_vel', '/nav_vel', '/tab_vel'];
  const locks = ['/joy_priority', '/pause_navigation', '/stop_closing_loop'];
  return {
    found: true,
    subscriptions: new Map([
      ...inputs.map((t): [string, string[]] => [t, [TWIST]]),
      ...locks.map((t): [string, string[]] => [t, [BOOL]]),
    ]),
    publications: new Map([
      ['/cmd_vel', [TWIST]],
      ['/diagnostics', ['diagnostic_msgs/msg/DiagnosticArray']],
    ]),
    publishers: new Map([['/cmd_vel', [{ node: '/twist_mux', type: TWIST }]]]),
    ...fields,
  };
}

function exampleMux(now = 0, startedAt = -10_000): MuxTracker {
  const mux = new MuxTracker('/twist_mux', '/tassello', startedAt);
  mux.setParameters(exampleParams());
  mux.setGraph(exampleGraph());
  mux.setSubscribed('output', '', now);
  return mux;
}

test('inputs and locks from the parameters, ordered by name as twist_mux orders them', () => {
  const config = configFromParameters(exampleParams());
  assert.deepEqual(
    config.inputs.map((h) => [h.prefix, h.name, h.topic, h.timeout, h.priority]),
    [
      ['topics.joystick', 'joystick', 'joy_vel', 0.5, 100],
      ['topics.keyboard', 'keyboard', 'key_vel', 0.5, 90],
      ['topics.navigation', 'navigation', 'nav_vel', 0.5, 10],
      ['topics.tablet', 'tablet', 'tab_vel', 0.5, 100],
    ],
  );
  assert.deepEqual(
    config.locks.map((h) => h.name),
    ['joystick', 'loop_closure', 'pause'],
  );
  assert.equal(config.useStamped, null);
  assert.deepEqual(config.problems, []);
  // Byte order, as std::string compares: capitals first
  const ordered = configFromParameters([
    param('topics.b.topic', 'b', 'string'),
    param('topics.B.topic', 'B', 'string'),
    param('topics.a.topic', 'a', 'string'),
  ]);
  assert.deepEqual(
    ordered.inputs.map((h) => h.name),
    ['B', 'a', 'b'],
  );
});

test('priorities clamped to 0-255, integer timeouts, use_stamped, missing fields', () => {
  const config = configFromParameters([
    param('topics.fast.topic', '/fast', 'string'),
    param('topics.fast.timeout', 1, 'integer'),
    param('topics.fast.priority', 300, 'integer'),
    param('topics.slow.topic', 'slow', 'string'),
    param('topics.slow.priority', -4, 'integer'),
    param('topics.none.priority', 5, 'integer'),
    param('use_stamped', true, 'bool'),
  ]);
  assert.deepEqual(
    config.inputs.map((h) => [h.name, h.timeout, h.priority]),
    [
      ['fast', 1, 255],
      ['slow', 0, 0],
    ],
  );
  assert.equal(config.useStamped, true);
  assert.deepEqual(config.problems, ['topics.none has no topic', 'topics.slow has no timeout']);
});

test('twist_mux’s status: its handles as it runs with them, its locks and priority', () => {
  assert.equal(isMuxStatus('twist_mux: Twist mux status', '/twist_mux'), true);
  assert.equal(isMuxStatus('mux: Twist mux status', '/robot1/mux'), true);
  assert.equal(isMuxStatus('Twist mux status', '/twist_mux'), true);
  assert.equal(isMuxStatus('other: Twist mux status', '/twist_mux'), false);

  const status = parseMuxStatus(exampleStatus());
  assert.deepEqual(status.config, configFromParameters(exampleParams()));
  assert.deepEqual([...status.locked], [
    ['joystick', false],
    ['loop_closure', false],
    ['pause', true],
  ]);
  assert.deepEqual(status.diagnostics, { level: 0, message: 'ok', stale: false, priority: 100 });
});

test('topics resolved in the node’s namespace, its output found among its publications', () => {
  assert.equal(resolveTopic('nav_vel', '/twist_mux'), '/nav_vel');
  assert.equal(resolveTopic('nav_vel', '/robot1/twist_mux'), '/robot1/nav_vel');
  assert.equal(resolveTopic('/nav_vel', '/robot1/twist_mux'), '/nav_vel');
  assert.equal(resolveTopic('~/in', '/robot1/twist_mux'), '/robot1/twist_mux/in');
  assert.equal(resolveTopic(' a//b/ ', '/twist_mux'), '/a/b');

  assert.deepEqual(outputOf(exampleGraph().publications), { topic: '/cmd_vel', type: TWIST });
  assert.equal(outputOf(new Map([['/diagnostics', ['diagnostic_msgs/msg/DiagnosticArray']]])), null);
});

test('commands told apart by their numbers, and a TwistStamped’s by its header too', () => {
  const plain = commandOf(twist(0.3, -0.5), TWIST);
  assert.deepEqual(plain?.twist, [0.3, 0, 0, 0, 0, -0.5]);
  assert.equal(commandOf(twist(0.3, -0.5), TWIST)?.key, plain?.key);
  assert.notEqual(commandOf(twist(0.3, 0.5), TWIST)?.key, plain?.key);
  const stamped = (sec: number) => ({ header: { stamp: { sec, nanosec: 5 }, frame_id: 'base_link' }, twist: twist(0.3) });
  assert.deepEqual(commandOf(stamped(1), TWIST_STAMPED)?.twist, [0.3, 0, 0, 0, 0, 0]);
  // The same values: told apart by their headers only
  assert.equal(commandOf(stamped(1), TWIST_STAMPED)?.key, commandOf(stamped(2), TWIST_STAMPED)?.key);
  assert.notEqual(commandOf(stamped(1), TWIST_STAMPED)?.full, commandOf(stamped(2), TWIST_STAMPED)?.full);
  // A Twist's values are a TwistStamped's
  assert.equal(commandOf(stamped(1), TWIST_STAMPED)?.key, commandOf(twist(0.3), TWIST)?.key);
  assert.equal(commandOf(twist(1), 'std_msgs/msg/Bool'), null);
});

test('the highest priority passes, the first by name among equals, until it times out', () => {
  const mux = exampleMux();
  let state = mux.snapshot(1000, true);
  assert.equal(state.selected, null);
  assert.deepEqual([state.inputType, state.outputType], [TWIST, TWIST]);
  assert.equal(state.output.topic, '/cmd_vel');
  assert.equal(state.configFrom, 'parameters');
  assert.ok(state.inputs.every((i) => i.expired && i.masked));

  mux.input('navigation', twist(0.2), 1000);
  assert.equal(mux.snapshot(1100, false).selected, 'navigation');
  // Joystick and tablet have the same priority: joystick comes first
  mux.input('tablet', twist(0.1), 1100);
  mux.input('joystick', twist(0.4), 1100);
  state = mux.snapshot(1200, false);
  assert.equal(state.selected, 'joystick');
  assert.deepEqual(
    state.inputs.filter((i) => !i.masked).map((i) => i.name),
    ['joystick', 'navigation', 'tablet'],
  );
  // 0.5 s later the joystick is masked, the tablet then too, navigation's
  // kept coming
  mux.input('navigation', twist(0.2), 1550);
  assert.equal(mux.snapshot(1601, false).selected, 'navigation');
  assert.equal(mux.snapshot(1601, false).inputs[0].expired, true);
});

test('an input without a timeout keeps the priority once it has it, silent', () => {
  const mux = new MuxTracker('/twist_mux', '/tassello', -10_000);
  mux.setParameters([
    param('topics.auto.topic', 'auto_vel', 'string'),
    param('topics.auto.timeout', 0.5, 'double'),
    param('topics.auto.priority', 10, 'integer'),
    param('topics.remote.topic', 'remote_vel', 'string'),
    param('topics.remote.timeout', 0, 'double'),
    param('topics.remote.priority', 50, 'integer'),
    param('topics.never.topic', 'never_vel', 'string'),
    param('topics.never.timeout', 0, 'double'),
    param('topics.never.priority', 0, 'integer'),
  ]);
  mux.setGraph(exampleGraph({ subscriptions: new Map() }));
  // Never published: twist_mux takes it as not expired
  const state = mux.snapshot(10_000, false);
  assert.equal(state.selected, 'remote');
  assert.equal(state.inputs.find((i) => i.name === 'never')?.masked, false);
  mux.input('auto', twist(0.2), 10_000);
  assert.equal(mux.snapshot(10_050, false).selected, 'remote');
});

test('a lock masks the lower priorities, not its own; one with a timeout locks when silent', () => {
  const mux = exampleMux();
  for (const name of ['joystick', 'keyboard', 'navigation']) {
    mux.input(name, twist(0.1), 1000);
  }
  mux.lock('pause', { data: true }, 1000);
  let state = mux.snapshot(1100, false);
  assert.equal(state.lockPriority, 100);
  assert.equal(state.lockedBy, 'pause');
  assert.equal(state.selected, 'joystick');
  assert.deepEqual(
    state.inputs.map((i) => [i.name, i.masked]),
    [
      ['joystick', false],
      ['keyboard', true],
      ['navigation', true],
      ['tablet', true],
    ],
  );
  assert.equal(state.locks.find((l) => l.name === 'pause')?.source, 'messages');
  // The loop closure's lock stops them all
  mux.lock('loop_closure', { data: true }, 1100);
  state = mux.snapshot(1200, false);
  assert.equal(state.lockPriority, 200);
  assert.equal(state.lockedBy, 'loop_closure');
  assert.equal(state.selected, null);
  mux.lock('loop_closure', { data: false }, 1200);
  mux.lock('pause', { data: false }, 1200);
  assert.equal(mux.snapshot(1300, false).lockPriority, 0);

  // A lock whose publisher must keep publishing
  const guarded = new MuxTracker('/twist_mux', '/tassello', -10_000);
  guarded.setParameters([
    param('topics.nav.topic', 'nav_vel', 'string'),
    param('topics.nav.timeout', 0, 'double'),
    param('topics.nav.priority', 10, 'integer'),
    param('locks.estop.topic', 'estop_ok', 'string'),
    param('locks.estop.timeout', 0.5, 'double'),
    param('locks.estop.priority', 255, 'integer'),
  ]);
  guarded.setGraph(exampleGraph({ subscriptions: new Map() }));
  assert.equal(guarded.snapshot(0, false).locks[0].locked, true);
  assert.equal(guarded.snapshot(0, false).locks[0].source, 'default');
  guarded.lock('estop', { data: false }, 1000);
  assert.equal(guarded.snapshot(1400, false).selected, 'nav');
  const silent = guarded.snapshot(1600, false);
  assert.deepEqual([silent.locks[0].locked, silent.locks[0].expired, silent.selected], [true, true, null]);
});

test('a lock not heard of since watched is as twist_mux’s diagnostics say', () => {
  const mux = exampleMux();
  mux.input('navigation', twist(0.1), 1000);
  assert.equal(mux.snapshot(1100, false).selected, 'navigation');
  // Published once, before: twist_mux says the pause is locked
  mux.setStatus(exampleStatus());
  let state = mux.snapshot(1100, false);
  assert.equal(state.configFrom, 'diagnostics');
  assert.equal(state.diagnostics?.priority, 100);
  assert.deepEqual(
    state.locks.map((l) => [l.name, l.locked, l.source]),
    [
      ['joystick', false, 'diagnostics'],
      ['loop_closure', false, 'diagnostics'],
      ['pause', true, 'diagnostics'],
    ],
  );
  assert.equal(state.selected, null);
  // Its messages since then are believed first
  mux.lock('pause', { data: false }, 1200);
  state = mux.snapshot(1250, false);
  assert.equal(state.locks.find((l) => l.name === 'pause')?.source, 'messages');
  assert.equal(state.selected, 'navigation');
  // Stale diagnostics say nothing of the locks
  const stale = exampleMux();
  stale.setStatus(exampleStatus({ stale: true }));
  assert.equal(stale.snapshot(0, false).locks.find((l) => l.name === 'pause')?.source, 'default');
});

test('what became of each message: passed as the output shows, stopped, dropped', () => {
  const mux = exampleMux(0);
  const t = OUTPUT_READY_MS;
  mux.input('navigation', twist(0.2), t);
  mux.outputMessage(twist(0.2), t + 1);
  // The joystick outranks it, and its message is forwarded
  mux.input('joystick', twist(0.5), t + 10);
  mux.input('navigation', twist(0.2), t + 20);
  mux.outputMessage(twist(0.5), t + 11);
  // Shown on the output: decided at once; the others once DECIDE_MS passed
  let state = mux.snapshot(t + 30, true);
  const flows = (s: typeof state) => Object.fromEntries(s.inputs.map((i) => [i.name, i.flow]));
  assert.deepEqual(flows(state).navigation, { passed: 1, outranked: 0, locked: 0, dropped: 0 });
  assert.deepEqual(flows(state).joystick, { passed: 1, outranked: 0, locked: 0, dropped: 0 });
  assert.deepEqual(state.output.flow, { inputs: { navigation: 1, joystick: 1 }, other: 0 });
  assert.equal(state.output.source, 'joystick');
  state = mux.snapshot(t + 20 + DECIDE_MS, true);
  assert.deepEqual(flows(state).navigation, { passed: 0, outranked: 1, locked: 0, dropped: 0 });
  // Taken once
  assert.deepEqual(mux.snapshot(t + 400, true).output.flow, { inputs: {}, other: 0 });

  // Locked out
  mux.lock('pause', { data: true }, t + 400);
  mux.input('navigation', twist(0.2), t + 410);
  state = mux.snapshot(t + 410 + DECIDE_MS, true);
  assert.equal(flows(state).navigation.locked, 1);

  // Should have passed, but the output never showed it
  mux.input('joystick', twist(0.6), t + 600);
  state = mux.snapshot(t + 600 + DECIDE_MS, true);
  assert.equal(flows(state).joystick.dropped, 1);
});

test('until the output is trusted, and without twist_mux, what it should do', () => {
  const mux = exampleMux(0);
  const t = WARMUP_MS;
  mux.input('navigation', twist(0.2), t + 100);
  assert.equal(mux.snapshot(t + 100 + DECIDE_MS, true).inputs[2].flow.passed, 1);
  mux.setGraph(exampleGraph({ found: false }));
  mux.input('navigation', twist(0.2), t + 200);
  const state = mux.snapshot(t + 200 + DECIDE_MS, true);
  assert.equal(state.found, false);
  assert.equal(state.selected, null);
  assert.equal(state.inputs[2].flow.dropped, 1);
  // Its output and types are still known
  assert.equal(state.output.topic, '/cmd_vel');
  assert.deepEqual([state.inputType, state.outputType], [TWIST, TWIST]);
});

test('just subscribed: an input not heard of yet outranks the one heard, as the output shows', () => {
  // Navigation's messages come first, the keyboard's (which has the priority)
  // after: the output only ever shows the keyboard's
  const mux = exampleMux(0);
  mux.input('navigation', twist(0.2), 10);
  // Not decided until the output's first message
  assert.equal(mux.warmingUp(10 + DECIDE_MS), true);
  let state = mux.snapshot(10 + DECIDE_MS, true);
  assert.equal(state.inputs[2].flow.passed, 0);
  mux.input('keyboard', twist(0.5), 200);
  mux.outputMessage(twist(0.5), 201);
  assert.equal(mux.warmingUp(202), false);
  mux.input('navigation', twist(0.2), 210);
  state = mux.snapshot(210 + DECIDE_MS, true);
  assert.equal(state.inputs[1].flow.passed, 1);
  assert.deepEqual(state.inputs[2].flow, { passed: 0, outranked: 2, locked: 0, dropped: 0 });
  // Nothing on the output for WARMUP_MS: what twist_mux should do
  const quiet = exampleMux(0);
  quiet.input('navigation', twist(0.2), 10);
  assert.equal(quiet.warmingUp(WARMUP_MS), false);
  assert.equal(quiet.snapshot(WARMUP_MS, true).inputs[2].flow.passed, 1);
  // Should have passed, no other input's on the output: dropped
  const alone = exampleMux(0);
  alone.outputMessage(twist(7), 5);
  alone.input('navigation', twist(0.2), 10);
  assert.equal(alone.snapshot(10 + DECIDE_MS, true).inputs[2].flow.dropped, 1);
});

test('just followed: twist_mux’s diagnostics waited for, while a lock is not heard of', () => {
  const mux = exampleMux(0, 0);
  mux.outputMessage(twist(1), 5);
  assert.equal(mux.warmingUp(1000), true);
  mux.setStatus(exampleStatus());
  assert.equal(mux.warmingUp(1000), false);
  // Not for ever
  const deaf = exampleMux(0, 0);
  deaf.outputMessage(twist(1), 5);
  assert.equal(deaf.warmingUp(DIAGNOSTICS_WAIT_MS), false);
  // What came meanwhile is judged by what they say: the pause was locked
  const paused = exampleMux(0, 0);
  paused.input('navigation', twist(0.2), 700);
  paused.input('keyboard', twist(0.5), 750);
  assert.equal(paused.snapshot(700 + DECIDE_MS, true).inputs[2].flow.passed, 0);
  paused.setStatus(exampleStatus());
  const state = paused.snapshot(900, true);
  assert.deepEqual(state.inputs[2].flow, { passed: 0, outranked: 0, locked: 1, dropped: 0 });
  assert.deepEqual(state.inputs[1].flow, { passed: 0, outranked: 0, locked: 1, dropped: 0 });
  // Nor without locks
  const free = new MuxTracker('/twist_mux', '/tassello', 0);
  free.setParameters(exampleParams().filter((p) => !p.name.startsWith('locks.')));
  free.setGraph(exampleGraph());
  assert.equal(free.warmingUp(1), false);
});

test('an output’s message matched with the input’s that comes after it, others from elsewhere', () => {
  const mux = exampleMux(0);
  const t = OUTPUT_READY_MS;
  mux.outputMessage(twist(0.3), t);
  mux.input('keyboard', twist(0.3), t + 5);
  // Another publisher's, on the output
  mux.outputMessage(twist(9), t + 50);
  let state = mux.snapshot(t + 60, true);
  assert.equal(state.inputs[1].flow.passed, 1);
  assert.deepEqual(state.output.flow, { inputs: { keyboard: 1 }, other: 0 });
  state = mux.snapshot(t + 50 + DECIDE_MS, true);
  assert.deepEqual(state.output.flow, { inputs: {}, other: 1 });
  assert.equal(state.output.source, null);
  assert.deepEqual(state.output.twist, [9, 0, 0, 0, 0, 0]);
});

test('the same command on two inputs: the output is the one that should pass', () => {
  const mux = exampleMux(0);
  const t = OUTPUT_READY_MS;
  mux.input('joystick', twist(0), t);
  mux.input('navigation', twist(0), t + 1);
  mux.outputMessage(twist(0), t + 2);
  const state = mux.snapshot(t + 1 + DECIDE_MS, true);
  assert.equal(state.inputs[0].flow.passed, 1);
  assert.equal(state.inputs[2].flow.outranked, 1);
});

// A mux that takes Twist and publishes TwistStamped, stamping each command
// as it forwards it (some versions do, with use_stamped)
function twistInStampedOut(): MuxTracker {
  const mux = new MuxTracker('/twist_mux', '/tassello', -10_000);
  mux.setParameters([...exampleParams(), param('use_stamped', true, 'bool')]);
  mux.setGraph(
    exampleGraph({
      publications: new Map([['/cmd_vel', [TWIST_STAMPED]]]),
      publishers: new Map([
        ['/cmd_vel', [{ node: '/twist_mux', type: TWIST_STAMPED }]],
        ['/joy_vel', [{ node: '/teleop', type: TWIST }]],
        ['/nav_vel', [{ node: '/controller_server', type: TWIST_STAMPED }]],
      ]),
    }),
  );
  mux.setSubscribed('output', '', 0);
  return mux;
}

const stampedBy = (sec: number, values: ReturnType<typeof twist>) => ({
  header: { stamp: { sec, nanosec: 0 }, frame_id: '' },
  twist: values,
});

test('Twist in, TwistStamped out: each input taken as the mux takes it, found again by its values', () => {
  const mux = twistInStampedOut();
  assert.deepEqual([mux.topics().inputs.get('joystick')?.type, mux.outputType], [TWIST, TWIST_STAMPED]);
  const t = OUTPUT_READY_MS;
  mux.input('joystick', twist(0.4, -0.5), t);
  mux.input('navigation', twist(0.2), t + 2);
  // Stamped by the mux as it forwards it
  mux.outputMessage(stampedBy(1234, twist(0.4, -0.5)), t + 1);
  const state = mux.snapshot(t + 2 + DECIDE_MS, true);
  assert.deepEqual([state.inputType, state.outputType], [TWIST, TWIST_STAMPED]);
  assert.equal(state.selected, 'joystick');
  assert.equal(state.inputs[0].flow.passed, 1);
  assert.equal(state.inputs[2].flow.outranked, 1);
  assert.deepEqual(state.output.flow, { inputs: { joystick: 1 }, other: 0 });
  assert.equal(state.output.source, 'joystick');
  assert.deepEqual(state.output.twist, [0.4, 0, 0, 0, 0, -0.5]);
  // Publishers of Twist are fine; of TwistStamped, not
  assert.equal(state.inputs[0].error, '');
  assert.match(state.inputs[2].error, /\/controller_server publishes geometry_msgs\/msg\/TwistStamped, which \/twist_mux does not take on \/nav_vel: it takes geometry_msgs\/msg\/Twist/);
});

test('TwistStamped in and out: the output’s header tells which of equal commands passed', () => {
  const mux = new MuxTracker('/twist_mux', '/tassello', -10_000);
  mux.setParameters(exampleParams());
  const stamped = (t: string): [string, string[]] => [t, [TWIST_STAMPED]];
  mux.setGraph(
    exampleGraph({
      subscriptions: new Map([stamped('/joy_vel'), stamped('/key_vel'), stamped('/nav_vel'), stamped('/tab_vel')]),
      publications: new Map([stamped('/cmd_vel')]),
    }),
  );
  mux.setSubscribed('output', '', 0);
  const t = OUTPUT_READY_MS;
  // Both stopping, at once: the navigation's is the one forwarded
  mux.input('joystick', stampedBy(1, twist(0)), t);
  mux.input('navigation', stampedBy(2, twist(0)), t + 1);
  mux.outputMessage(stampedBy(2, twist(0)), t + 2);
  const state = mux.snapshot(t + 1 + DECIDE_MS, true);
  assert.equal(state.inputs[2].flow.passed, 1);
  // The output says navigation had the priority
  assert.equal(state.inputs[0].flow.outranked, 1);
  assert.equal(state.output.source, 'navigation');
});

test('rates, publishers, what does not reach the mux', () => {
  const mux = exampleMux();
  for (let i = 0; i <= 20; i++) {
    mux.input('navigation', twist(0.1), 1000 + i * 50);
  }
  mux.setGraph(
    exampleGraph({
      subscriptions: new Map([
        ['/joy_vel', [TWIST]],
        ['/nav_vel', [TWIST]],
        ['/tab_vel', [TWIST]],
      ]),
      publishers: new Map([
        ['/cmd_vel', [{ node: '/rogue', type: TWIST }, { node: '/twist_mux', type: TWIST }]],
        ['/nav_vel', [{ node: '/controller_server', type: TWIST }]],
        ['/joy_vel', [{ node: '/teleop', type: TWIST_STAMPED }]],
      ]),
    }),
  );
  const state = mux.snapshot(2000, false);
  const navigation = state.inputs.find((i) => i.name === 'navigation');
  assert.equal(navigation?.rate, 20);
  assert.deepEqual(navigation?.publishers, ['/controller_server']);
  assert.equal(navigation?.error, '');
  assert.match(state.inputs.find((i) => i.name === 'keyboard')?.error ?? '', /does not subscribe to \/key_vel/);
  assert.match(
    state.inputs.find((i) => i.name === 'joystick')?.error ?? '',
    /\/teleop publishes geometry_msgs\/msg\/TwistStamped, which \/twist_mux does not take on \/joy_vel: it takes geometry_msgs\/msg\/Twist/,
  );
  assert.deepEqual(state.output.publishers, ['/rogue']);
  // Gone quiet: no rate after its window
  assert.equal(mux.snapshot(5000, false).inputs[2].rate, 0);
});
