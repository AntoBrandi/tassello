import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MuxInput, MuxLock, MuxRelay, TwistMuxState } from '../../../shared/twist_mux.ts';
import {
  activity,
  displayOrder,
  formatAge,
  formatRate,
  formatSpeed,
  inputStatus,
  lockControl,
  lockLine,
  lockStatus,
  muxCandidates,
  muxLayout,
  pointAt,
  polyline,
  sampleFates,
  stepText,
  summary,
  turboSpeeds,
  typesText,
  WIDE_PX,
  type Point,
  type Rect,
} from './model.ts';

const input = (name: string, priority: number, fields: Partial<MuxInput> = {}): MuxInput => ({
  name,
  topic: `/${name}_vel`,
  timeout: 0.5,
  priority,
  publishers: [],
  lastAt: null,
  rate: 0,
  twist: null,
  expired: true,
  masked: true,
  selected: false,
  flow: { passed: 0, outranked: 0, locked: 0, dropped: 0 },
  error: '',
  ...fields,
});

const lock = (name: string, priority: number, fields: Partial<MuxLock> = {}): MuxLock => ({
  name,
  topic: `/${name}`,
  timeout: 0,
  priority,
  publishers: [],
  lastAt: null,
  value: null,
  expired: false,
  locked: false,
  source: 'default',
  flow: { on: 0, off: 0 },
  error: '',
  ...fields,
});

const muxState = (fields: Partial<TwistMuxState> = {}): TwistMuxState => ({
  node: '/twist_mux',
  self: '/tassello',
  found: true,
  inputType: 'geometry_msgs/msg/Twist',
  outputType: 'geometry_msgs/msg/Twist',
  configFrom: 'diagnostics',
  inputs: [],
  locks: [],
  output: { topic: '/cmd_vel', publishers: [], lastAt: null, rate: 0, twist: null, source: null, flow: { inputs: {}, other: 0 }, error: '' },
  lockPriority: 0,
  lockedBy: null,
  selected: null,
  diagnostics: null,
  problems: [],
  relay: null,
  time: 0,
  ...fields,
});

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Of axis-aligned segments
function crosses(a: [Point, Point], b: [Point, Point]): boolean {
  const [ax0, ax1] = [Math.min(a[0].x, a[1].x), Math.max(a[0].x, a[1].x)];
  const [ay0, ay1] = [Math.min(a[0].y, a[1].y), Math.max(a[0].y, a[1].y)];
  const [bx0, bx1] = [Math.min(b[0].x, b[1].x), Math.max(b[0].x, b[1].x)];
  const [by0, by1] = [Math.min(b[0].y, b[1].y), Math.max(b[0].y, b[1].y)];
  return ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1;
}

const segments = (path: Point[]) => path.slice(1).map((p, i): [Point, Point] => [path[i], p]);

test('wide: the inputs, the mux, then the output, the locks above', () => {
  const layout = muxLayout(800, 500, 4, 3);
  assert.equal(layout.narrow, false);
  assert.equal(layout.compact, false);
  assert.equal(layout.compactSides, false);
  const { mux } = layout;
  for (const [i, rect] of layout.inputs.entries()) {
    assert.ok(rect.x + rect.w < mux.x0, 'inputs left of the mux');
    const [from, pin] = layout.inputWires[i];
    assert.equal(from.x, rect.x + rect.w);
    assert.equal(pin.x, mux.x0);
    assert.ok(pin.y > mux.top && pin.y < mux.bottom, 'pins on its left edge');
  }
  assert.ok(layout.output.x > mux.x1);
  assert.equal(layout.outPin.y, layout.outputPath[1].y);
  for (const rect of layout.locks) {
    assert.ok(rect.y + rect.h < mux.top, 'locks above the mux');
  }
  const cards = [...layout.inputs, ...layout.locks, layout.output];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      assert.equal(overlap(cards[i], cards[j]), false, `cards ${i} and ${j} overlap`);
    }
  }
  assert.ok(layout.height <= 500 && layout.width === 800);
});

test('the locks’ wires end on the mux’s top and never cross', () => {
  for (const [width, locks] of [
    [800, 3],
    [1200, 5],
    [400, 2],
    [600, 1],
  ]) {
    const layout = muxLayout(width, 600, 3, locks);
    const { mux } = layout;
    for (const path of layout.lockPaths) {
      const end = path[path.length - 1];
      assert.ok(end.x > mux.x0 && end.x < mux.x1);
      const topAt = mux.top + (mux.slant * (end.x - mux.x0)) / (mux.x1 - mux.x0);
      assert.ok(Math.abs(end.y - topAt) < 1e-9);
    }
    for (let i = 0; i < locks; i++) {
      for (let j = i + 1; j < locks; j++) {
        for (const a of segments(layout.lockPaths[i])) {
          for (const b of segments(layout.lockPaths[j])) {
            assert.equal(crosses(a, b), false, `${width}px, ${locks} locks: ${i} and ${j} cross`);
          }
        }
      }
    }
  }
});

test('narrow: the output under the inputs; short: cards of one line, then scrolled', () => {
  const narrow = muxLayout(WIDE_PX - 1, 600, 4, 0);
  assert.equal(narrow.narrow, true);
  const lastInput = narrow.inputs[3];
  assert.ok(narrow.output.y > lastInput.y + lastInput.h);
  const end = narrow.outputPath[narrow.outputPath.length - 1];
  assert.equal(end.y, narrow.output.y);
  assert.ok(end.x > narrow.output.x && end.x < narrow.output.x + narrow.output.w);
  assert.ok(narrow.inputs.every((r) => r.x + r.w < narrow.mux.x0 && r.w > 100));

  // The locks and the output to one line first, then the inputs
  const fullHeight = muxLayout(800, 2000, 4, 3);
  assert.equal(fullHeight.compactSides, false);
  const sides = muxLayout(800, 330, 4, 3);
  assert.deepEqual([sides.compactSides, sides.compact], [true, false]);
  const short = muxLayout(800, 260, 4, 3);
  assert.deepEqual([short.compactSides, short.compact], [true, true]);
  const tiny = muxLayout(800, 120, 8, 3);
  assert.equal(tiny.compact, true);
  assert.ok(tiny.height > 120, 'taller than the widget: it scrolls');
});

test('inputs shown by priority, equals as twist_mux takes them; the lock’s line under those it leaves', () => {
  const inputs = [input('joystick', 100), input('keyboard', 90), input('navigation', 10), input('tablet', 100)];
  const order = displayOrder(inputs);
  assert.deepEqual(
    order.map((i) => inputs[i].name),
    ['joystick', 'tablet', 'keyboard', 'navigation'],
  );
  const ordered = order.map((i) => inputs[i]);
  assert.equal(lockLine(ordered, 0), null);
  assert.equal(lockLine(ordered, 100), 2);
  assert.equal(lockLine(ordered, 91), 2);
  assert.equal(lockLine(ordered, 200), 0);
  assert.equal(lockLine(ordered, 5), null);
});

test('what each input is doing, and why', () => {
  const now = 10_000;
  const joystick = input('joystick', 100, { selected: true, masked: false, expired: false, lastAt: now - 50, rate: 20 });
  const keyboard = input('keyboard', 90, { masked: false, expired: false, lastAt: now - 30, rate: 10 });
  const navigation = input('navigation', 10, { masked: true, expired: false, lastAt: now - 40 });
  const tablet = input('tablet', 100);
  const remote = input('remote', 50, { timeout: 0, masked: false, expired: false });
  const zero = input('zero', 0, { masked: false, expired: false, timeout: 0 });
  const state = muxState({
    inputs: [joystick, keyboard, navigation, tablet, remote, zero],
    selected: 'joystick',
    lockPriority: 50,
    lockedBy: 'pause',
  });
  const kind = (i: MuxInput) => inputStatus(i, state, now).kind;
  assert.equal(kind(joystick), 'passing');
  assert.equal(kind(keyboard), 'blocked');
  assert.match(inputStatus(keyboard, state, now).text, /Outranked by joystick \(100\)/);
  assert.equal(kind(navigation), 'locked');
  assert.match(inputStatus(navigation, state, now).text, /pause \(50\)/);
  assert.equal(kind(tablet), 'idle');
  assert.equal(kind(remote), 'standby');
  assert.equal(kind(zero), 'never');
  // Selected, silent: holding the mux
  const silent = { ...joystick, lastAt: now - 5000 };
  assert.equal(inputStatus(silent, state, now).kind, 'holding');
  // Without twist_mux
  const gone = { ...state, found: false, selected: null };
  assert.deepEqual(
    [inputStatus(keyboard, gone, now).tag, inputStatus(tablet, gone, now).tag],
    ['Lost', 'Idle'],
  );
});

test('locks in words', () => {
  assert.equal(lockStatus(lock('pause', 100), 0).tag, 'Free');
  assert.match(lockStatus(lock('pause', 100, { locked: true, value: true, source: 'messages' }), 0).text, /true/);
  assert.match(lockStatus(lock('pause', 100, { locked: true, source: 'diagnostics' }), 0).text, /as twist_mux says/);
  const silent = lock('estop', 255, { locked: true, expired: true, timeout: 0.5, lastAt: 0, value: false, source: 'messages' });
  assert.match(lockStatus(silent, 3000).text, /silent for 3 s, past its 0.5 s timeout/);
});

test('the status line: what passes, or why nothing does', () => {
  const now = 1000;
  const passing = input('joystick', 100, { selected: true, masked: false, expired: false, lastAt: 990, rate: 20 });
  assert.deepEqual(summary(muxState({ inputs: [passing], selected: 'joystick' }), now), {
    tone: 'ok',
    text: 'joystick passes to /cmd_vel at 20 Hz',
  });
  const locked = muxState({
    inputs: [input('navigation', 10)],
    locks: [lock('pause', 100, { locked: true })],
    lockPriority: 100,
    lockedBy: 'pause',
  });
  assert.deepEqual(summary(locked, now), { tone: 'error', text: 'Locked by pause (100): nothing passes' });
  assert.equal(summary(muxState({ inputs: [input('navigation', 10)] }), now).tone, 'idle');
  const lockedOut = muxState({
    inputs: [
      input('joystick', 100),
      input('keyboard', 90, { expired: false, lastAt: 950 }),
      input('navigation', 10, { expired: false, lastAt: 990 }),
    ],
    lockPriority: 100,
    lockedBy: 'pause',
  });
  assert.deepEqual(summary(lockedOut, now), {
    tone: 'error',
    text: 'Nothing passes: pause (100) locks out keyboard and navigation, the others are silent',
  });
  assert.match(summary(muxState({ found: false }), now).text, /not in the ROS graph/);
  const bypassed = muxState({
    inputs: [passing],
    selected: 'joystick',
    output: { ...muxState().output, publishers: ['/rogue'] },
  });
  assert.deepEqual(summary(bypassed, now), {
    tone: 'warn',
    text: 'joystick passes to /cmd_vel at 20 Hz · /rogue also publishes on /cmd_vel, bypassing the mux',
  });
});

test('points along a path, and the messages drawn of many', () => {
  const line = polyline([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
  assert.equal(line.total, 20);
  assert.deepEqual(pointAt(line, 5), { x: 5, y: 0 });
  assert.deepEqual(pointAt(line, 15), { x: 10, y: 5 });
  assert.deepEqual(pointAt(line, 99), { x: 10, y: 10 });
  assert.deepEqual(pointAt(line, -1), { x: 0, y: 0 });

  assert.deepEqual(sampleFates({ passed: 2, outranked: 0, locked: 1, dropped: 0 }, 5), ['passed', 'passed', 'locked']);
  const many = sampleFates({ passed: 30, outranked: 10, locked: 0, dropped: 0 }, 4);
  assert.deepEqual(many, ['passed', 'passed', 'passed', 'outranked']);
});

test('the likeliest twist_mux of the graph first', () => {
  assert.deepEqual(muxCandidates(['/amcl', '/robot2/twist_mux', '/cmd_vel_mux', '/twist_mux', '/my_twist_mux']), [
    '/robot2/twist_mux',
    '/twist_mux',
    '/my_twist_mux',
    '/cmd_vel_mux',
  ]);
  assert.deepEqual(muxCandidates(['/amcl']), []);
});

test('what the mux takes and publishes', () => {
  const twist = 'geometry_msgs/msg/Twist';
  const stamped = 'geometry_msgs/msg/TwistStamped';
  assert.equal(typesText(twist, twist), 'Twist');
  assert.equal(typesText(stamped, stamped), 'TwistStamped');
  assert.equal(typesText(twist, stamped), 'Twist → TwistStamped');
  assert.equal(typesText(null, stamped), 'TwistStamped');
});

test('numbers in words', () => {
  assert.equal(formatAge(450), '0.5 s');
  assert.equal(formatAge(12_400), '12 s');
  assert.equal(formatAge(125_000), '2 min');
  assert.equal(formatRate(20.04), '20 Hz');
  assert.equal(formatRate(2.5), '2.5 Hz');
  assert.equal(formatSpeed(-0.001), '0.00');
  assert.equal(formatSpeed(-0.25), '−0.25');
  assert.equal(activity(null, 0, 0), 'no message');
  assert.equal(activity(900, 20, 1000), '20 Hz');
  assert.equal(activity(0, 20, 3000), '3 s ago');
});

const relay = (fields: Partial<MuxRelay> = {}): MuxRelay => ({
  node: '/joystick_relay',
  actions: ['priority', 'turbo-increase', 'turbo-decrease', 'turbo-reset'],
  priorityTopic: '/joy_priority',
  manual: true,
  lock: 'joystick',
  input: 'joystick',
  inputTopic: '/input_joy/cmd_vel',
  outputTopic: '/joy_vel',
  turbo: {
    steps: 4,
    initStep: 2,
    forward: { min: 0.5, max: 1 },
    backward: { min: 0.25, max: 0.5 },
    lateral: { min: 1, max: 1 },
    angular: { min: 0.7, max: 1.2 },
  },
  linearStep: { low: 3, high: 3 },
  angularStep: { low: 1, high: 1 },
  error: '',
  ...fields,
});

test('stepText says a step, a range of them, or that it is not known', () => {
  assert.equal(stepText({ low: 2, high: 2 }, 4), '2/4');
  assert.equal(stepText({ low: 3, high: 4 }, 4), '3–4/4');
  assert.equal(stepText({ low: 1, high: 4 }, 4), '?/4');
  assert.equal(stepText(null, 4), '?/4');
  assert.equal(stepText({ low: 1, high: 1 }, 1), '1/1');
});

test('turboSpeeds says the velocities at full stick at the steps, a range while not known', () => {
  assert.equal(turboSpeeds(relay())?.text, '0.83 m/s · 0.70 rad/s');
  const unknown = turboSpeeds(relay({ linearStep: { low: 1, high: 4 } }));
  assert.equal(unknown?.text, '0.50–1.00 m/s · 0.70 rad/s');
  assert.match(unknown?.title ?? '', /does not publish its steps/);
  assert.match(turboSpeeds(relay())?.title ?? '', /backward 0\.42 m\/s, sideways 1\.00 m\/s/);
  assert.equal(turboSpeeds(relay({ turbo: null })), null);
});

test('lockControl: the relay’s lock through its priority, the others by their topic', () => {
  const joystick = lock('joystick', 100, { topic: '/joy_priority', locked: true });
  let control = lockControl(joystick, relay());
  assert.deepEqual([control.locked, control.viaRelay, control.label, control.disabled], [false, true, 'Autonomous', '']);
  control = lockControl({ ...joystick, locked: false }, relay({ manual: false }));
  assert.deepEqual([control.locked, control.label], [true, 'Manual']);
  // Its priority not heard of
  assert.notEqual(lockControl(joystick, relay({ manual: null })).disabled, '');
  // A relay without the action: as any lock
  assert.equal(lockControl(joystick, relay({ actions: ['turbo-reset'] })).viaRelay, false);

  const pause = lock('pause', 100);
  control = lockControl(pause, relay());
  assert.deepEqual([control.locked, control.viaRelay, control.label, control.disabled], [true, false, 'Lock', '']);
  control = lockControl({ ...pause, locked: true }, null);
  assert.deepEqual([control.locked, control.label, control.disabled], [false, 'Release', '']);
  // Its timeout would lock it again
  assert.match(lockControl({ ...pause, locked: true, timeout: 0.5 }, null).disabled, /0\.5 s timeout/);
  // Locking one with a timeout is fine
  assert.equal(lockControl({ ...pause, timeout: 0.5 }, null).disabled, '');
});
