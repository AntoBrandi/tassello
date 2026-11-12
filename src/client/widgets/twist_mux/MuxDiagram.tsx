// A twist_mux as a multiplexer: its locks above, gating it from its top; its
// inputs in order of priority, each wired to its pin on the mux, a dashed line
// under those the locks leave; the mux, its arm joining the input that has the
// priority to its output; the output. Each message moves along its wire as it
// came: those that pass go on through the arm to the output, the others stop
// at the mux, red if a lock stopped them. In the widget's own pixels: the
// cards are HTML, over an SVG of the wires; the messages are drawn frame by
// frame, outside React.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { MuxFate, MuxInput, MuxLock, MuxRelay, TwistMuxState } from '../../../shared/twist_mux.ts';
import { LockIcon, UnlockIcon, WarningIcon } from '../../icons.tsx';
import { useConfirm, type MuxControls } from './MuxControls.tsx';
import {
  activity,
  displayOrder,
  formatSpeed,
  formatTimeout,
  inputStatus,
  lockControl,
  lockLine,
  lockStatus,
  muxLayout,
  PAD,
  pointAt,
  polyline,
  sampleFates,
  shortType,
  type MuxLayout,
  type Point,
  type Polyline,
} from './model.ts';

const SVG = 'http://www.w3.org/2000/svg';
// Of the messages drawn
const SPEED_PX_S = 210;
const MIN_TRAVEL_MS = 380;
// Of a message stopped at the mux: it bursts
const STOP_MS = 420;
// Messages drawn a second at most, per wire, and at once: a 50 Hz topic is
// shown as a steady stream, not a line
const DOTS_PER_S = 9;
const DOTS_BURST = 3;
const MAX_DOTS = 260;
// Spread over the update's interval, as they came
const SPREAD_MS = 100;
const DOT_R = 3.6;
// Narrower, a lock of one line shows its name only
const NARROW_LOCK_PX = 140;
// A dot due longer ago than this is not drawn
const STALE_MS = 400;

type DotKind = MuxFate | 'lock-on' | 'lock-off' | 'other';

interface Dot {
  el: SVGCircleElement;
  line: Polyline;
  start: number;
  travel: number;
  // Stops at the end of its line, at the mux
  stops: boolean;
}

interface Pending {
  at: number;
  line: Polyline;
  kind: DotKind;
  stops: boolean;
}

function twistText(twist: number[] | null): string {
  if (!twist) {
    return '';
  }
  const [x, y, , , , z] = twist;
  return `vx ${formatSpeed(x)} · vy ${formatSpeed(y)} · ωz ${formatSpeed(z)}`;
}

function publishersText(publishers: string[], self: string): string {
  return publishers.map((node) => (node === self ? `${node} (this dashboard)` : node)).join(', ');
}

function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function points(list: Point[]): string {
  return list.map((p) => `${p.x},${p.y}`).join(' ');
}

function InputCard({
  input,
  state,
  now,
  rect,
  compact,
}: {
  input: MuxInput;
  state: TwistMuxState;
  now: number;
  rect: MuxLayout['inputs'][number];
  compact: boolean;
}) {
  const status = inputStatus(input, state, now);
  const latest = input.lastAt === null ? '' : `Latest: ${twistText(input.twist)}, ${activity(input.lastAt, 0, now)}`;
  const title = [
    `${input.name}: priority ${input.priority}, timeout ${formatTimeout(input.timeout)}`,
    `${input.topic}${input.publishers.length > 0 ? `, published by ${publishersText(input.publishers, state.self)}` : ', no publisher'}`,
    `${status.tag}. ${status.text}`,
    latest,
    input.error,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      className={`mux-card mux-input ${status.kind}${compact ? ' compact' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      title={title}
    >
      <span className="mux-priority" aria-label={`Priority ${input.priority}`}>
        {input.priority}
      </span>
      <span className="mux-name">{input.name}</span>
      {input.error && <WarningIcon className="mux-warning" width={13} height={13} />}
      <span className="mux-tag">{status.tag}</span>
      {!compact && (
        <span className="mux-sub">
          <code>{input.topic}</code>
          <span className="mux-dim"> · {activity(input.lastAt, input.rate, now)}</span>
          {input.timeout > 0 && <span className="mux-dim"> · ⏱ {formatTimeout(input.timeout)}</span>}
        </span>
      )}
    </div>
  );
}

// Locks it, or releases it: its icon, what it will be. A release asks twice
// (but the relay's priority, toggled as a joystick's button does), saying so.
function LockButton({ lock, relay, controls }: { lock: MuxLock; relay: MuxRelay | null; controls: MuxControls }) {
  const control = lockControl(lock, relay);
  const { armed, arm, disarm } = useConfirm();
  const key = `lock ${lock.name}`;
  const why = controls.allowed ? control.disabled : 'Takes an operator';
  const confirm = !control.locked && !control.viaRelay;
  const Icon = control.locked ? LockIcon : UnlockIcon;
  return (
    <button
      type="button"
      className={`mux-lock-button${armed ? ' armed' : ''}${controls.pending === key ? ' pending' : ''}`}
      disabled={controls.pending !== null || why !== ''}
      title={why || (armed ? `Click again to release ${lock.name}` : control.title)}
      aria-label={armed ? `Confirm: ${control.label} ${lock.name}` : `${control.label} ${lock.name}`}
      onClick={(e) => {
        e.stopPropagation();
        if (confirm && !armed) {
          arm();
          return;
        }
        disarm();
        controls.send(key, { kind: 'lock', lock: lock.name, locked: control.locked });
      }}
    >
      <Icon width={12} height={12} />
      {armed && <span>{control.label}?</span>}
    </button>
  );
}

function LockCard({
  lock,
  state,
  now,
  rect,
  compact,
  controls,
}: {
  lock: MuxLock;
  state: TwistMuxState;
  now: number;
  rect: MuxLayout['locks'][number];
  compact: boolean;
  controls: MuxControls | null;
}) {
  const status = lockStatus(lock, now);
  const title = [
    `Lock ${lock.name}: priority ${lock.priority}, timeout ${formatTimeout(lock.timeout)}`,
    `${lock.topic} (std_msgs/Bool)${lock.publishers.length > 0 ? `, published by ${publishersText(lock.publishers, state.self)}` : ', no publisher'}`,
    status.text,
    lock.lastAt === null ? '' : `Latest: ${String(lock.value)}, ${activity(lock.lastAt, 0, now)}`,
    lock.error,
  ]
    .filter(Boolean)
    .join('\n');
  const Icon = lock.locked ? LockIcon : UnlockIcon;
  return (
    <div
      className={`mux-card mux-lock ${lock.locked ? 'locked' : 'free'}${compact ? ' compact' : ''}${controls ? ' controlled' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      title={title}
    >
      <Icon className="mux-lock-icon" width={14} height={14} />
      <span className="mux-name">{lock.name}</span>
      {lock.error && <WarningIcon className="mux-warning" width={13} height={13} />}
      {compact ? (
        // Narrow, its name first
        rect.w >= NARROW_LOCK_PX && (
          <span className="mux-priority" aria-label={`Priority ${lock.priority}`}>
            {lock.priority}
          </span>
        )
      ) : (
        <span className="mux-sub">
          <span className="mux-state">{status.tag}</span>{' '}
          <span className="mux-priority inline" aria-label={`Priority ${lock.priority}`}>
            {lock.priority}
          </span>
          <code className="mux-dim"> {lock.topic}</code>
        </span>
      )}
      {controls && (
        <LockButton lock={lock} relay={state.relay} controls={controls} />
      )}
    </div>
  );
}

function OutputCard({ state, now, rect, compact }: { state: TwistMuxState; now: number; rect: MuxLayout['output']; compact: boolean }) {
  const { output } = state;
  const from = output.lastAt === null ? '' : output.source ? `from ${output.source}` : 'from another publisher';
  const title = [
    `Output ${output.topic ?? '(not found)'}${state.outputType ? `: ${state.outputType}` : ''}`,
    output.lastAt === null ? 'No message since watched' : `Latest: ${twistText(output.twist)}, ${activity(output.lastAt, 0, now)}, ${from}`,
    output.publishers.length > 0 ? `Also published by ${publishersText(output.publishers, state.self)}, bypassing the mux` : '',
    output.error,
  ]
    .filter(Boolean)
    .join('\n');
  const recent = output.lastAt !== null && now - output.lastAt < 1500;
  return (
    <div
      className={`mux-card mux-output${recent ? ' flowing' : ''}${compact ? ' compact' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      title={title}
    >
      <code className="mux-name">{output.topic ?? 'output'}</code>
      <span className="mux-rate">{activity(output.lastAt, output.rate, now)}</span>
      {!compact && (
        <>
          <span className="mux-sub mux-dim">
            {shortType(state.outputType)}
            {from && ` · ${from}`}
          </span>
          <span className="mux-sub mux-twist">{output.twist ? twistText(output.twist) : '–'}</span>
        </>
      )}
      {(output.publishers.length > 0 || output.error) && (
        <span className="mux-sub mux-bypass">
          <WarningIcon width={12} height={12} />
          {output.error || `also ${publishersText(output.publishers, state.self)}`}
        </span>
      )}
    </div>
  );
}

export function MuxDiagram({
  state,
  now,
  animate,
  controls,
}: {
  state: TwistMuxState;
  now: number;
  animate: boolean;
  // Its locks' buttons; null: none
  controls: MuxControls | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(scrollRef);
  const order = useMemo(() => displayOrder(state.inputs), [state.inputs]);
  const ordered = order.map((i) => state.inputs[i]);
  const layout = useMemo(
    () => muxLayout(width, height, state.inputs.length, state.locks.length),
    [width, height, state.inputs.length, state.locks.length],
  );
  const lane = new Map(ordered.map((input, i) => [input.name, i]));
  const selectedLane = state.selected === null ? -1 : (lane.get(state.selected) ?? -1);
  const { mux, outPin } = layout;

  // Where the arm points: the selected input's pin, else open
  const armEnd: Point =
    selectedLane >= 0
      ? layout.inputWires[selectedLane][1]
      : { x: mux.x1 - (mux.x1 - mux.x0) * 0.5, y: outPin.y - Math.min(18, (mux.bottom - mux.top) / 4) };

  // Other publishers' messages reach the output's wire from above it
  const outputLine = polyline(layout.outputPath);
  const bypassAt = pointAt(outputLine, outputLine.total / 2);
  const bypassFrom = layout.narrow
    ? { x: layout.output.x + layout.output.w / 2, y: layout.output.y - 18 }
    : { x: bypassAt.x, y: bypassAt.y - 34 };
  const bypassTo = layout.narrow ? { x: bypassFrom.x, y: layout.output.y } : bypassAt;
  const bypass = state.output.publishers.length > 0;

  const line = lockLine(ordered, state.lockPriority);
  const lineY =
    line === null ? null : line === 0 ? layout.inputs[0].y - 4 : (layout.inputs[line - 1].y + layout.inputs[line - 1].h + layout.inputs[line].y) / 2;

  // ── The messages, frame by frame ──
  const dotsRef = useRef<SVGGElement>(null);
  const armRef = useRef<SVGLineElement>(null);
  const live = useRef({ layout, armEnd, outPin });
  live.current = { layout, armEnd, outPin };
  const pending = useRef<Pending[]>([]);
  const budgets = useRef(new Map<string, { tokens: number; at: number }>());

  // A wire's share of the dots to draw: DOTS_PER_S, in bursts of DOTS_BURST
  const take = (wire: string, wanted: number, at: number): number => {
    const budget = budgets.current.get(wire) ?? { tokens: DOTS_BURST, at };
    budget.tokens = Math.min(DOTS_BURST, budget.tokens + ((at - budget.at) / 1000) * DOTS_PER_S);
    budget.at = at;
    const granted = Math.min(wanted, Math.floor(budget.tokens));
    budget.tokens -= granted;
    budgets.current.set(wire, budget);
    return granted;
  };

  // Each update's messages, queued to be drawn over its interval
  useEffect(() => {
    // Not drawn while hidden: not queued either
    if (!animate || document.hidden) {
      return;
    }
    const at = performance.now();
    const queue = (kinds: DotKind[], paths: (kind: DotKind) => { line: Polyline; stops: boolean }) => {
      kinds.forEach((kind, i) => {
        pending.current.push({ at: at + (i * SPREAD_MS) / kinds.length, kind, ...paths(kind) });
      });
    };
    const { layout: current, outPin: out } = live.current;
    ordered.forEach((input, i) => {
      const count = input.flow.passed + input.flow.outranked + input.flow.locked + input.flow.dropped;
      if (count === 0) {
        return;
      }
      const fates = sampleFates(input.flow, take(`input ${input.name}`, count, at));
      const [from, pin] = current.inputWires[i];
      queue(fates, (kind) =>
        kind === 'passed'
          ? { line: polyline([from, pin, out, ...current.outputPath.slice(1)]), stops: false }
          : { line: polyline([from, pin]), stops: true },
      );
    });
    state.locks.forEach((lock, i) => {
      const count = lock.flow.on + lock.flow.off;
      if (count === 0 || !current.lockPaths[i]) {
        return;
      }
      const n = take(`lock ${lock.name}`, count, at);
      const kinds: DotKind[] = Array.from({ length: n }, (_, k) =>
        Math.floor(((k + 0.5) * count) / n) < lock.flow.on ? 'lock-on' : 'lock-off',
      );
      queue(kinds, () => ({ line: polyline(current.lockPaths[i]), stops: true }));
    });
    if (state.output.flow.other > 0 && state.output.publishers.length > 0) {
      const n = take('other', state.output.flow.other, at);
      const rest = current.narrow ? [] : current.outputPath.slice(1);
      queue(Array<DotKind>(n).fill('other'), () => ({ line: polyline([bypassFrom, bypassTo, ...rest]), stops: false }));
    }
    // Once per update: not again when the widget renders for other reasons
  }, [state, animate]);

  // The arm and the dots, frame by frame. Their SVG is drawn once the widget
  // is measured, after this first runs: looked for at each frame.
  useEffect(() => {
    if (!animate) {
      return;
    }
    const dots: Dot[] = [];
    let arm: Point | null = null;
    let last = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const dt = Math.min(100, t - last);
      last = t;
      // The arm swings to its input
      const target = live.current.armEnd;
      arm = arm ? { x: arm.x + (target.x - arm.x) * (1 - Math.exp(-dt / 70)), y: arm.y + (target.y - arm.y) * (1 - Math.exp(-dt / 70)) } : target;
      const armLine = armRef.current;
      if (armLine) {
        const { outPin: pivot } = live.current;
        armLine.setAttribute('x1', String(pivot.x));
        armLine.setAttribute('y1', String(pivot.y));
        armLine.setAttribute('x2', String(arm.x));
        armLine.setAttribute('y2', String(arm.y));
      }
      // New dots, as their time comes
      const group = dotsRef.current;
      const due = pending.current.filter((p) => p.at <= t);
      if (due.length > 0 && group) {
        pending.current = pending.current.filter((p) => p.at > t);
        for (const p of due) {
          // Late (the page was busy, or hidden): skipped, not bunched
          if (dots.length >= MAX_DOTS || t - p.at > STALE_MS) {
            continue;
          }
          const el = document.createElementNS(SVG, 'circle');
          el.setAttribute('r', String(DOT_R));
          el.setAttribute('class', `mux-dot ${p.kind}`);
          group.appendChild(el);
          dots.push({ el, line: p.line, start: p.at, travel: Math.max(MIN_TRAVEL_MS, (p.line.total / SPEED_PX_S) * 1000), stops: p.stops });
        }
      }
      // Each along its line; those stopped burst at the mux, the others
      // vanish at the output
      for (let i = dots.length - 1; i >= 0; i--) {
        const dot = dots[i];
        const elapsed = t - dot.start;
        const point = pointAt(dot.line, (Math.min(elapsed, dot.travel) / dot.travel) * dot.line.total);
        let opacity = 1;
        let r = DOT_R;
        if (elapsed > dot.travel) {
          const after = (elapsed - dot.travel) / (dot.stops ? STOP_MS : 160);
          if (after >= 1) {
            dot.el.remove();
            dots.splice(i, 1);
            continue;
          }
          opacity = 1 - after;
          r = dot.stops ? DOT_R * (1 + after * 1.6) : DOT_R * (1 - after * 0.5);
          if (dot.stops && !dot.el.classList.contains('stopped')) {
            dot.el.classList.add('stopped');
          }
        } else if (elapsed < 80) {
          opacity = elapsed / 80;
        }
        dot.el.setAttribute('cx', point.x.toFixed(1));
        dot.el.setAttribute('cy', point.y.toFixed(1));
        dot.el.setAttribute('r', r.toFixed(2));
        dot.el.setAttribute('opacity', opacity.toFixed(2));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      for (const dot of dots) {
        dot.el.remove();
      }
      pending.current = [];
    };
  }, [animate]);

  const muxPath = `M${mux.x0} ${mux.top}L${mux.x1} ${mux.top + mux.slant}L${mux.x1} ${mux.bottom - mux.slant}L${mux.x0} ${mux.bottom}Z`;
  const statuses = ordered.map((input) => inputStatus(input, state, now));
  const passing = selectedLane >= 0 && statuses[selectedLane].kind === 'passing';
  const muxMiddle = (mux.top + mux.bottom) / 2;

  let overlay: ReactNode = null;
  if (lineY !== null) {
    overlay = (
      <div className="mux-lockline-label" style={{ left: PAD + 4, top: lineY }} title={`Below priority ${state.lockPriority}, the inputs are masked while ${state.lockedBy} is locked`}>
        <LockIcon width={11} height={11} />
        {state.lockedBy} · {state.lockPriority}
      </div>
    );
  }

  return (
    <div className="mux-scroll" ref={scrollRef}>
      {width > 0 && (
        <div className="mux-diagram" style={{ width: layout.width, height: layout.height }}>
          <svg className="mux-svg" width={layout.width} height={layout.height} aria-hidden="true">
            {state.locks.map((lock, i) =>
              layout.lockPaths[i] ? (
                <polyline key={lock.name} className={`mux-wire lock${lock.locked ? ' locked' : ''}`} points={points(layout.lockPaths[i])} />
              ) : null,
            )}
            {ordered.map((input, i) => {
              const [from, pin] = layout.inputWires[i];
              return (
                <line
                  key={input.name}
                  className={`mux-wire input ${statuses[i].kind}`}
                  x1={from.x}
                  y1={from.y}
                  x2={pin.x}
                  y2={pin.y}
                />
              );
            })}
            {lineY !== null && <line className="mux-lockline" x1={PAD} y1={lineY} x2={mux.x0} y2={lineY} />}
            <polyline className={`mux-wire output${passing ? ' passing' : ''}`} points={points(layout.outputPath)} />
            {bypass && <line className="mux-wire bypass" x1={bypassFrom.x} y1={bypassFrom.y} x2={bypassTo.x} y2={bypassTo.y} />}
            <path className={`mux-shape${state.lockPriority > 0 ? ' locked' : ''}${state.found ? '' : ' gone'}`} d={muxPath} />
            {ordered.map((input, i) => (
              <circle
                key={input.name}
                className={`mux-pin${i === selectedLane ? ' selected' : ''}`}
                cx={layout.inputWires[i][1].x}
                cy={layout.inputWires[i][1].y}
                r={3.2}
              />
            ))}
            {animate ? (
              <line ref={armRef} className={`mux-arm${passing ? ' passing' : selectedLane >= 0 ? ' holding' : ' open'}`} />
            ) : (
              <line
                className={`mux-arm${passing ? ' passing' : selectedLane >= 0 ? ' holding' : ' open'}`}
                x1={outPin.x}
                y1={outPin.y}
                x2={armEnd.x}
                y2={armEnd.y}
              />
            )}
            <circle className={`mux-pin out${passing ? ' selected' : ''}`} cx={outPin.x} cy={outPin.y} r={4} />
            <text className="mux-label" x={(mux.x0 + mux.x1) / 2} y={mux.bottom - Math.max(8, mux.slant * 0.6)}>
              MUX
            </text>
            {!state.found && (
              <text className="mux-label gone" x={(mux.x0 + mux.x1) / 2} y={muxMiddle}>
                off
              </text>
            )}
            <g ref={dotsRef} className="mux-dots" />
          </svg>
          {state.locks.map((lock, i) =>
            layout.locks[i] ? (
              <LockCard
                key={lock.name}
                lock={lock}
                state={state}
                now={now}
                rect={layout.locks[i]}
                compact={layout.compactSides}
                controls={controls}
              />
            ) : null,
          )}
          {ordered.map((input, i) => (
            <InputCard key={input.name} input={input} state={state} now={now} rect={layout.inputs[i]} compact={layout.compact} />
          ))}
          <OutputCard state={state} now={now} rect={layout.output} compact={layout.compactSides} />
          {overlay}
        </div>
      )}
    </div>
  );
}
