// What a Twist Mux inspector draws of a twist_mux (src/shared/twist_mux.ts):
// its diagram's layout, the inputs in order of priority, what each input and
// lock is doing, in words, and the paths the messages take. Kept apart from
// the widget to be tested without a page.

import type { MuxFate, MuxInput, MuxLock, TwistMuxState } from '../../../shared/twist_mux.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// In the diagram's pixels. The locks above, gating the mux from its top; the
// inputs in a column, their wires to its pins; its output beside it, or under
// the inputs when narrow.
export interface MuxLayout {
  width: number;
  // More than the widget's when it does not fit: it scrolls
  height: number;
  // Cards of one line, to fit: the inputs', and the locks' and output's
  // (which go first)
  compact: boolean;
  compactSides: boolean;
  // Narrow: the output under the inputs
  narrow: boolean;
  // In display order
  inputs: Rect[];
  // Each input's wire, from its card to its pin on the mux
  inputWires: [Point, Point][];
  // The mux: its left edge from top to bottom at x0, its right edge slant
  // shorter at both ends, at x1
  mux: { x0: number; x1: number; top: number; bottom: number; slant: number };
  // Where the output leaves the mux
  outPin: Point;
  output: Rect;
  // From outPin to the output's card
  outputPath: Point[];
  locks: Rect[];
  // From each lock's card to its pin on the mux's top
  lockPaths: Point[][];
}

export const PAD = 12;
const GAP = 8;
const CARD_H = 52;
const CARD_H_COMPACT = 32;
const LOCK_H = 44;
const LOCK_H_COMPACT = 30;
const LOCK_GAP = 8;
const LOCK_MAX_W = 200;
const OUTPUT_H = 88;
const OUTPUT_H_COMPACT = 52;
// Between the inputs and the output under them
const OUTPUT_GAP = 26;
const MUX_W = 56;
const MUX_W_NARROW = 44;
// Narrower, the output goes under the inputs
export const WIDE_PX = 540;
const MAX_WIRE = 170;
// Of the mux's left edge, above its first card and below its last
const MUX_MARGIN = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function muxLayout(width: number, height: number, inputCount: number, lockCount: number): MuxLayout {
  const w = Math.max(width, 240);
  const narrow = w < WIDE_PX;
  const muxW = narrow ? MUX_W_NARROW : MUX_W;
  const n = Math.max(1, inputCount);
  // Room for the locks' wires to turn towards the mux, one level each
  const busH = lockCount > 0 ? 14 + 7 * lockCount : 0;
  const sizes = (compact: boolean, compactSides: boolean) => {
    const cardH = compact ? CARD_H_COMPACT : CARD_H;
    const lockH = compactSides ? LOCK_H_COMPACT : LOCK_H;
    const outputH = compactSides ? OUTPUT_H_COMPACT : OUTPUT_H;
    const inputsH = n * cardH + (n - 1) * GAP + 2 * MUX_MARGIN;
    const middleH = narrow ? inputsH : Math.max(inputsH, outputH);
    const total = PAD * 2 + (lockCount > 0 ? lockH + busH : 0) + middleH + (narrow ? OUTPUT_GAP + outputH : 0);
    return { cardH, lockH, outputH, inputsH, middleH, total };
  };
  // The inputs' topics and rates are kept the longest
  const compactSides = sizes(false, false).total > height;
  const compact = compactSides && sizes(false, true).total > height;
  const { cardH, lockH, outputH, inputsH, middleH, total } = sizes(compact, compactSides);

  // Across: the inputs, their wires, the mux, then the output's wire and card
  // (narrow: a short stub down to it)
  let inputX: number;
  let inputW: number;
  let x0: number;
  let outputRect: Rect;
  const stub = 14;
  if (narrow) {
    const wire = clamp(w * 0.1, 22, 48);
    inputX = PAD;
    inputW = w - 2 * PAD - wire - muxW - stub;
    x0 = inputX + inputW + wire;
    outputRect = { x: PAD, y: 0, w: w - 2 * PAD, h: outputH };
  } else {
    const outW = clamp(w * 0.26, 150, 230);
    const free = w - 2 * PAD - muxW - outW;
    inputW = clamp(free * 0.62, 130, 320);
    const wire = Math.min(MAX_WIRE, (free - inputW) / 2);
    const content = inputW + 2 * wire + muxW + outW;
    inputX = PAD + Math.max(0, (w - 2 * PAD - content) / 2);
    x0 = inputX + inputW + wire;
    outputRect = { x: x0 + muxW + wire, y: 0, w: outW, h: outputH };
  }
  const x1 = x0 + muxW;

  // Down: centred when there is room
  let y = PAD + Math.max(0, (height - total) / 2);
  const lockTop = y;
  if (lockCount > 0) {
    y += lockH + busH;
  }
  const middleTop = y;
  const top = middleTop + (middleH - inputsH) / 2;
  const bottom = top + inputsH;
  const inputs: Rect[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputs.push({ x: inputX, y: top + MUX_MARGIN + i * (cardH + GAP), w: inputW, h: cardH });
  }
  const inputWires = inputs.map((r): [Point, Point] => [
    { x: r.x + r.w, y: r.y + r.h / 2 },
    { x: x0, y: r.y + r.h / 2 },
  ]);
  const slant = Math.min(26, (bottom - top) * 0.2);
  const outPin = { x: x1, y: (top + bottom) / 2 };
  let outputPath: Point[];
  if (narrow) {
    outputRect.y = middleTop + middleH + OUTPUT_GAP;
    const turn = x1 + stub * 0.6;
    outputPath = [outPin, { x: turn, y: outPin.y }, { x: turn, y: outputRect.y }];
  } else {
    outputRect.y = middleTop + (middleH - outputH) / 2;
    outputPath = [outPin, { x: outputRect.x, y: outPin.y }];
  }

  // The locks in a row above the mux, their wires down into its top: the
  // farther a lock from its pin, the nearer the mux its wire turns, so that
  // none crosses another
  const locks: Rect[] = [];
  const lockPaths: Point[][] = [];
  if (lockCount > 0) {
    const lockW = Math.min(LOCK_MAX_W, (w - 2 * PAD - (lockCount - 1) * LOCK_GAP) / lockCount);
    const rowW = lockCount * lockW + (lockCount - 1) * LOCK_GAP;
    const rowX = clamp((x0 + x1) / 2 - rowW / 2, PAD, w - PAD - rowW);
    for (let i = 0; i < lockCount; i++) {
      locks.push({ x: rowX + i * (lockW + LOCK_GAP), y: lockTop, w: lockW, h: lockH });
    }
    const pins = locks.map((_, i) => x0 + ((x1 - x0) * (i + 1)) / (lockCount + 1));
    const ends = locks.map((r) => r.x + r.w / 2);
    const byDistance = locks.map((_, i) => i).sort((a, b) => Math.abs(ends[a] - pins[a]) - Math.abs(ends[b] - pins[b]));
    const busTop = lockTop + lockH + 7;
    const step = lockCount > 1 ? (busH - 14) / (lockCount - 1) : 0;
    const level = new Map(byDistance.map((lock, rank) => [lock, busTop + rank * step]));
    for (let i = 0; i < lockCount; i++) {
      const turn = level.get(i) ?? busTop;
      const pinY = top + (slant * (pins[i] - x0)) / (x1 - x0);
      lockPaths.push([
        { x: ends[i], y: lockTop + lockH },
        { x: ends[i], y: turn },
        { x: pins[i], y: turn },
        { x: pins[i], y: pinY },
      ]);
    }
  }

  return {
    width: w,
    height: Math.max(height, total),
    compact,
    compactSides,
    narrow,
    inputs,
    inputWires,
    mux: { x0, x1, top, bottom, slant },
    outPin,
    output: outputRect,
    outputPath,
    locks,
    lockPaths,
  };
}

// The inputs' indices, the highest priority first; equals as twist_mux takes
// them, the first by name first
export function displayOrder(inputs: MuxInput[]): number[] {
  return inputs.map((_, i) => i).sort((a, b) => inputs[b].priority - inputs[a].priority || a - b);
}

// How many of the inputs, in display order, the lock priority leaves
// unmasked: the line between them and the others is drawn there. null: no
// line, nothing locked or nothing below it.
export function lockLine(ordered: MuxInput[], lockPriority: number): number | null {
  if (lockPriority <= 0) {
    return null;
  }
  const above = ordered.filter((input) => input.priority >= lockPriority).length;
  return above < ordered.length ? above : null;
}

// ── Words ────────────────────────────────────────────────────────────────────

export function formatAge(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)} s`;
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m} min`;
  }
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

export function formatRate(hz: number): string {
  return hz >= 100 ? `${Math.round(hz)} Hz` : hz >= 10 ? `${hz.toFixed(0)} Hz` : `${hz.toFixed(1)} Hz`;
}

export function formatTimeout(seconds: number): string {
  return seconds > 0 ? `${Number(seconds.toFixed(3))} s` : 'none';
}

// A command's numbers, as signed decimals: no "-0.00"
export function formatSpeed(value: number): string {
  const text = Math.abs(value).toFixed(2);
  return value < 0 && Number(text) !== 0 ? `−${text}` : text;
}

// geometry_msgs/msg/TwistStamped: TwistStamped
export function shortType(type: string | null): string {
  return type ? type.slice(type.lastIndexOf('/') + 1) : '';
}

// What the mux takes and publishes: "Twist", or "Twist → TwistStamped"
export function typesText(input: string | null, output: string | null): string {
  return input && output && input !== output ? `${shortType(input)} → ${shortType(output)}` : shortType(input ?? output);
}

export function typesTitle(input: string | null, output: string | null): string {
  return `Takes ${input ?? 'an unknown type'}, publishes ${output ?? 'an unknown type'}`;
}

// Messages a second, or how long ago the latest came
export function activity(lastAt: number | null, rate: number, now: number): string {
  if (lastAt === null) {
    return 'no message';
  }
  const age = now - lastAt;
  return rate > 0 && age < 1500 ? formatRate(rate) : `${formatAge(age)} ago`;
}

// Its latest message is recent: it publishes
function live(input: MuxInput, now: number): boolean {
  return input.lastAt !== null && now - input.lastAt < Math.max(1000, input.timeout * 1000);
}

export type InputKind = 'passing' | 'holding' | 'blocked' | 'standby' | 'locked' | 'idle' | 'never';

export interface InputStatus {
  kind: InputKind;
  // Its tag on the card
  tag: string;
  // Why, in a sentence
  text: string;
}

export function inputStatus(input: MuxInput, state: TwistMuxState, now: number): InputStatus {
  if (!state.found) {
    return live(input, now)
      ? { kind: 'blocked', tag: 'Lost', text: `${state.node} is not running: its messages go nowhere` }
      : { kind: 'idle', tag: 'Idle', text: `${state.node} is not running` };
  }
  const winner = state.inputs.find((i) => i.selected);
  if (input.selected) {
    return live(input, now)
      ? { kind: 'passing', tag: 'Passes', text: `Has the priority: its messages go to ${state.output.topic ?? 'the output'}` }
      : {
          kind: 'holding',
          tag: 'Holds',
          text:
            input.timeout > 0
              ? 'Has the priority, until its timeout'
              : 'Has the priority though silent: without a timeout it never expires, and keeps the lower priorities out',
        };
  }
  if (input.priority === 0) {
    return { kind: 'never', tag: 'Never', text: 'Priority 0: twist_mux never selects it' };
  }
  if (state.lockPriority > input.priority) {
    return {
      kind: 'locked',
      tag: 'Locked',
      text: `Locked out by ${state.lockedBy ?? 'a lock'} (${state.lockPriority}): its priority ${input.priority} is lower`,
    };
  }
  if (input.expired) {
    return {
      kind: 'idle',
      tag: 'Idle',
      text: input.lastAt === null ? 'No message: masked until one comes' : `No message within its ${formatTimeout(input.timeout)} timeout: masked`,
    };
  }
  const by = winner ? `${winner.name} (${winner.priority})` : 'a higher priority';
  return live(input, now)
    ? { kind: 'blocked', tag: 'Blocked', text: `Outranked by ${by}: its messages are dropped` }
    : { kind: 'standby', tag: 'Standby', text: `Outranked by ${by}; without a timeout, ready whenever it publishes` };
}

export function lockStatus(lock: MuxLock, now: number): { tag: string; text: string } {
  if (!lock.locked) {
    const source =
      lock.source === 'diagnostics'
        ? ', as twist_mux says'
        : lock.source === 'default'
          ? ': no message yet, free until a true one'
          : '';
    return { tag: 'Free', text: `Free${source}` };
  }
  if (lock.expired) {
    const since = lock.lastAt === null ? 'no message' : `silent for ${formatAge(now - lock.lastAt)}`;
    return {
      tag: 'Locked',
      text: `Locked: ${since}, past its ${formatTimeout(lock.timeout)} timeout (its publisher must keep publishing false)`,
    };
  }
  const source = lock.source === 'diagnostics' ? ', as twist_mux says (published before the dashboard watched)' : ': its latest message is true';
  return { tag: 'Locked', text: `Locked${source}. It masks the inputs below priority ${lock.priority}` };
}

export type Tone = 'ok' | 'idle' | 'warn' | 'error';

// The status line: what passes, or why nothing does
export function summary(state: TwistMuxState, now: number): { tone: Tone; text: string } {
  if (!state.found) {
    return {
      tone: 'error',
      text: `${state.node} is not in the ROS graph: is twist_mux running? Its node is chosen in edit mode`,
    };
  }
  if (state.problems.length > 0) {
    return { tone: 'warn', text: state.problems[0] };
  }
  if (!state.configFrom) {
    return { tone: 'idle', text: `Reading the configuration of ${state.node}…` };
  }
  const lock = state.lockPriority > 0 ? ` · ${state.lockedBy} locks below ${state.lockPriority}` : '';
  const bypass =
    state.output.publishers.length > 0
      ? ` · ${state.output.publishers.join(', ')} also publish${state.output.publishers.length === 1 ? 'es' : ''} on ${state.output.topic}, bypassing the mux`
      : '';
  const selected = state.inputs.find((i) => i.selected);
  if (selected) {
    const status = inputStatus(selected, state, now);
    const text =
      status.kind === 'passing'
        ? `${selected.name} passes to ${state.output.topic ?? 'the output'}${selected.rate > 0 ? ` at ${formatRate(selected.rate)}` : ''}`
        : `${selected.name} holds the mux, silent${selected.timeout > 0 ? '' : ': it has no timeout'}`;
    return { tone: bypass ? 'warn' : status.kind === 'passing' ? 'ok' : 'idle', text: text + lock + bypass };
  }
  if (state.lockPriority > 0 && state.inputs.every((i) => i.priority < state.lockPriority)) {
    return { tone: 'error', text: `Locked by ${state.lockedBy} (${state.lockPriority}): nothing passes${bypass}` };
  }
  // Those publishing are locked out, the others silent
  const lockedOut = state.inputs.filter((i) => i.priority < state.lockPriority && !i.expired && i.lastAt !== null);
  if (lockedOut.length > 0) {
    const names = lockedOut.map((i) => i.name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return {
      tone: 'error',
      text: `Nothing passes: ${state.lockedBy} (${state.lockPriority}) locks out ${list}, the others are silent${bypass}`,
    };
  }
  return { tone: bypass ? 'warn' : 'idle', text: `Nothing passes: no input has a message within its timeout${lock}${bypass}` };
}

// ── The messages' paths ──────────────────────────────────────────────────────

export interface Polyline {
  points: Point[];
  // From the start, at each point
  lengths: number[];
  total: number;
}

export function polyline(points: Point[]): Polyline {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return { points, lengths, total: lengths[lengths.length - 1] ?? 0 };
}

// The point this far along it, clamped to its ends
export function pointAt(line: Polyline, distance: number): Point {
  const { points, lengths } = line;
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  if (distance <= 0 || points.length === 1) {
    return points[0];
  }
  for (let i = 1; i < points.length; i++) {
    if (distance <= lengths[i]) {
      const span = lengths[i] - lengths[i - 1];
      const t = span > 0 ? (distance - lengths[i - 1]) / span : 1;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
  }
  return points[points.length - 1];
}

// Of n messages, by fate, the k to draw: spread as they came, each fate in
// proportion
export function sampleFates(flow: Record<MuxFate, number>, k: number): MuxFate[] {
  const all: MuxFate[] = [];
  for (const fate of ['passed', 'outranked', 'locked', 'dropped'] as const) {
    for (let i = 0; i < flow[fate]; i++) {
      all.push(fate);
    }
  }
  if (all.length <= k) {
    return all;
  }
  return Array.from({ length: k }, (_, i) => all[Math.floor(((i + 0.5) * all.length) / k)]);
}

// ── Its node ─────────────────────────────────────────────────────────────────

// The nodes of the graph that may be twist_muxes, the likeliest first: named
// twist_mux, then *mux*
export function muxCandidates(nodes: string[]): string[] {
  const base = (node: string) => node.slice(node.lastIndexOf('/') + 1).toLowerCase();
  const rank = (node: string) => (base(node) === 'twist_mux' ? 0 : base(node).includes('twist_mux') ? 1 : 2);
  return nodes.filter((node) => base(node).includes('mux')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
