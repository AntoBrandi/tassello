// The plot's chart, on a canvas: its series' lines on one value axis, over
// the span of time of its view, redrawn on every frame while live. Dragged
// across, it zooms into what was dragged over; the wheel zooms around the
// pointer (live: a shorter or longer span to now), Shift+wheel or a
// sideways swipe scrolls through time; two fingers pinch; a double click goes
// back live. The pointer shows the series' values at its time.

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { connection } from '../../connection.ts';
import {
  clockTime,
  MIN_SPAN_MS,
  panView,
  pointsIn,
  relativeTime,
  tickText,
  timeTicks,
  valueText,
  valueTicks,
  viewSpan,
  zoomView,
  type SeriesBuffer,
  type View,
} from './model.ts';

export interface ChartSeries {
  key: string;
  name: string;
  // Its colour's custom property: --plot-1
  color: string;
  buffer: SeriesBuffer;
}

// Live, the right edge is this much before now: the latest samples, sent
// every SAMPLES_PERIOD_MS, reach it
const LAG_MS = 150;
const PAD = { top: 8, right: 10, bottom: 20 };
// A drag shorter than this is a click
const DRAG_PX = 4;

export function chartNow(): number {
  return connection.serverNow() - LAG_MS;
}

interface Colors {
  series: Map<string, string>;
  text: string;
  grid: string;
  axis: string;
  crosshair: string;
  selection: string;
  surface: string;
  font: string;
}

function readColors(element: HTMLElement): Colors {
  const style = getComputedStyle(element);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    series: new Map(Array.from({ length: 8 }, (_, n) => [`--plot-${n + 1}`, get(`--plot-${n + 1}`)])),
    text: get('--text-muted'),
    grid: get('--border'),
    axis: get('--border-strong'),
    crosshair: get('--text-muted'),
    selection: get('--accent-soft'),
    surface: get('--surface'),
    font: `11px ${get('--font')}`,
  };
}

// Where the last frame put things: the pointer's times are read from it
interface Frame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  from: number;
  to: number;
}

export function PlotChart({
  series,
  view,
  onView,
  defaultSpan,
  range,
  disabled,
  label,
  message,
}: {
  // Those shown
  series: ChartSeries[];
  view: View;
  onView: (view: View) => void;
  // Of the view live, on a double click
  defaultSpan: number;
  // Of the value axis, fixed; null: fitted to what is shown
  range: { min: number; max: number } | null;
  disabled: boolean;
  label: string;
  // Instead of the lines: waiting for messages
  message: string | null;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const frame = useRef<Frame>({ left: 0, right: 1, top: 0, bottom: 1, from: 0, to: 1 });
  // What the frame shows, read by the drawing loop and the handlers
  const props = useRef({ series, view, range, onView, defaultSpan, disabled });
  props.current = { series, view, range, onView, defaultSpan, disabled };
  // In the area's pixels
  const hover = useRef<number | null>(null);
  const selection = useRef<{ from: number; to: number } | null>(null);
  const pointers = useRef(new Map<number, number>());
  const drag = useRef<{ start: number; moved: boolean; pinch: number | null } | null>(null);
  const dirty = useRef(true);
  dirty.current = true;

  // At once: the next wheel or pinch event, before the next render, goes
  // on from it
  const change = (next: View) => {
    props.current.view = next;
    dirty.current = true;
    props.current.onView(next);
  };

  useEffect(() => {
    const area = areaRef.current!;
    const canvas = canvasRef.current!;
    const context = canvas.getContext('2d')!;
    let colors = readColors(area);
    const scheme = matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => {
      colors = readColors(area);
      dirty.current = true;
    };
    scheme.addEventListener('change', onScheme);
    const observer = new ResizeObserver(() => {
      dirty.current = true;
    });
    observer.observe(area);

    const paint = () => {
      const { series, view, range } = props.current;
      const [width, height] = [area.clientWidth, area.clientHeight];
      const ratio = devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (width < 40 || height < 40) {
        return;
      }
      context.font = colors.font;
      const { from, to } = viewSpan(view, chartNow());
      const [top, bottom] = [PAD.top, height - PAD.bottom];
      // The columns are about the plot's width, before the axis' labels are
      // measured
      const drawn = series.map((s) => ({ s, points: pointsIn(s.buffer, from, to, Math.max(1, Math.round(width))) }));
      let [low, high] = [Infinity, -Infinity];
      if (range) {
        [low, high] = [range.min, range.max];
      } else {
        for (const { points } of drawn) {
          for (const value of points.values) {
            if (!Number.isNaN(value)) {
              low = Math.min(low, value);
              high = Math.max(high, value);
            }
          }
        }
      }
      // Fixed, from and to its own values
      const fitted = valueTicks(low, high, Math.max(2, Math.floor((bottom - top) / 36)));
      const axis = range ? { ...fitted, min: low, max: high } : fitted;
      const ticks = axis.ticks.filter((tick) => tick >= axis.min - 1e-9 && tick <= axis.max + 1e-9);
      const left = Math.ceil(Math.max(...ticks.map((tick) => context.measureText(tickText(tick, axis.step)).width), 0)) + 12;
      const right = width - PAD.right;
      frame.current = { left, right, top, bottom, from, to };
      const x = (at: number) => left + ((at - from) / (to - from)) * (right - left);
      const y = (value: number) => bottom - ((value - axis.min) / (axis.max - axis.min)) * (bottom - top);

      // The grid, hairlines; the axes' labels
      context.lineWidth = 1;
      context.fillStyle = colors.text;
      context.textBaseline = 'middle';
      context.textAlign = 'right';
      for (const tick of ticks) {
        const at = Math.round(y(tick)) + 0.5;
        context.strokeStyle = colors.grid;
        context.beginPath();
        context.moveTo(left, at);
        context.lineTo(right, at);
        context.stroke();
        context.fillText(tickText(tick, axis.step), left - 6, at);
      }
      const times = timeTicks(from, to, Math.max(2, Math.floor((right - left) / 80)), view.live);
      context.textBaseline = 'top';
      for (const tick of times.ticks) {
        const at = Math.round(x(tick)) + 0.5;
        context.strokeStyle = colors.grid;
        context.beginPath();
        context.moveTo(at, top);
        context.lineTo(at, bottom);
        context.stroke();
        const text = view.live ? relativeTime(to - tick, times.step) : clockTime(tick, times.step);
        const textWidth = context.measureText(text).width;
        context.textAlign = 'left';
        context.fillText(text, Math.min(width - textWidth - 2, Math.max(left, at - textWidth / 2)), bottom + 5);
      }
      context.strokeStyle = colors.axis;
      context.beginPath();
      context.moveTo(left, bottom + 0.5);
      context.lineTo(right, bottom + 0.5);
      context.stroke();

      // The lines, broken where there is no value; a lone sample a dot
      context.save();
      context.beginPath();
      context.rect(left, top - 2, right - left, bottom - top + 4);
      context.clip();
      context.lineWidth = 2;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      for (const { s, points } of drawn) {
        const color = colors.series.get(s.color) ?? colors.text;
        context.strokeStyle = color;
        context.fillStyle = color;
        context.beginPath();
        const dots: number[] = [];
        let run = 0;
        const dot = (index: number) => {
          if (run === 1) {
            dots.push(index);
          }
        };
        for (let index = 0; index < points.times.length; index++) {
          const value = points.values[index];
          if (Number.isNaN(value)) {
            dot(index - 1);
            run = 0;
            continue;
          }
          const [px, py] = [x(points.times[index]), y(value)];
          if (run === 0) {
            context.moveTo(px, py);
          } else {
            context.lineTo(px, py);
          }
          run++;
        }
        dot(points.times.length - 1);
        context.stroke();
        context.beginPath();
        for (const index of dots) {
          context.moveTo(x(points.times[index]) + 2, y(points.values[index]));
          context.arc(x(points.times[index]), y(points.values[index]), 2, 0, 2 * Math.PI);
        }
        context.fill();
      }
      context.restore();

      // What is being dragged over
      const chosen = selection.current;
      if (chosen) {
        context.fillStyle = colors.selection;
        context.fillRect(Math.min(chosen.from, chosen.to), top, Math.abs(chosen.to - chosen.from), bottom - top);
      }

      // The values at the pointer: a crosshair, markers and the tooltip
      const tooltip = tooltipRef.current;
      const pointer = hover.current;
      if (!tooltip) {
        return;
      }
      if (pointer === null || pointer < left || pointer > right || chosen || series.length === 0) {
        tooltip.hidden = true;
        return;
      }
      const at = from + ((pointer - left) / (right - left)) * (to - from);
      context.strokeStyle = colors.crosshair;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(Math.round(pointer) + 0.5, top);
      context.lineTo(Math.round(pointer) + 0.5, bottom);
      context.stroke();
      const values = series.map((s) => s.buffer.valueAt(at));
      values.forEach((value, index) => {
        if (value !== null && value >= axis.min && value <= axis.max) {
          context.beginPath();
          context.arc(pointer, y(value), 4, 0, 2 * Math.PI);
          context.fillStyle = colors.series.get(series[index].color) ?? colors.text;
          context.strokeStyle = colors.surface;
          context.lineWidth = 2;
          context.stroke();
          context.fill();
        }
      });
      tooltip.hidden = false;
      tooltip.style.left = pointer > width / 2 ? '' : `${pointer + 12}px`;
      tooltip.style.right = pointer > width / 2 ? `${width - pointer + 12}px` : '';
      const span = to - from;
      const step = span < 2000 ? 1 : span < 20_000 ? 10 : span < 200_000 ? 100 : 1000;
      tooltip.querySelector('.plot-tooltip-time')!.textContent = view.live
        ? relativeTime(to - at, step).replace('now', 'Now')
        : clockTime(at, step);
      tooltip.querySelectorAll('strong').forEach((cell, index) => {
        cell.textContent = valueText(values[index] ?? null);
      });
    };

    let request = 0;
    const loop = () => {
      request = requestAnimationFrame(loop);
      if (dirty.current || props.current.view.live) {
        dirty.current = false;
        paint();
      }
    };
    request = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      scheme.removeEventListener('change', onScheme);
    };
  }, []);

  // In the area's pixels, and as a share of the plot's width
  const local = (clientX: number) => clientX - areaRef.current!.getBoundingClientRect().left;
  const share = (x: number) => {
    const { left, right } = frame.current;
    return Math.min(1, Math.max(0, (x - left) / (right - left)));
  };
  const timeAt = (x: number) => frame.current.from + share(x) * (frame.current.to - frame.current.from);

  // Not React's onWheel, which is passive: the page would scroll
  useEffect(() => {
    const area = areaRef.current!;
    const onWheel = (event: WheelEvent) => {
      const { view, disabled } = props.current;
      if (disabled) {
        return;
      }
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
      const [dx, dy] = [event.deltaX * scale, event.deltaY * scale];
      const { left, right } = frame.current;
      if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        change(panView(view, chartNow(), (Math.abs(dx) > Math.abs(dy) ? dx : dy) / Math.max(1, right - left)));
      } else {
        change(zoomView(view, chartNow(), Math.exp(dy * 0.0015), share(local(event.clientX))));
      }
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, []);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event.clientX));
    const xs = [...pointers.current.values()];
    if (xs.length === 2) {
      drag.current = { start: 0, moved: true, pinch: Math.abs(xs[0] - xs[1]) };
      selection.current = null;
    } else if (xs.length === 1) {
      drag.current = { start: xs[0], moved: false, pinch: null };
      hover.current = xs[0];
    }
    dirty.current = true;
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const x = local(event.clientX);
    const current = drag.current;
    if (!pointers.current.has(event.pointerId) || !current) {
      if (event.pointerType === 'mouse') {
        hover.current = x;
        dirty.current = true;
      }
      return;
    }
    pointers.current.set(event.pointerId, x);
    if (current.pinch !== null) {
      const xs = [...pointers.current.values()];
      if (xs.length === 2) {
        const distance = Math.max(10, Math.abs(xs[0] - xs[1]));
        change(zoomView(props.current.view, chartNow(), current.pinch / distance, share((xs[0] + xs[1]) / 2)));
        current.pinch = distance;
      }
      return;
    }
    if (Math.abs(x - current.start) > DRAG_PX) {
      current.moved = true;
    }
    if (current.moved) {
      selection.current = { from: current.start, to: x };
      hover.current = null;
    } else {
      hover.current = x;
    }
    dirty.current = true;
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    const current = drag.current;
    const chosen = selection.current;
    if (pointers.current.size > 0 || !current) {
      return;
    }
    drag.current = null;
    selection.current = null;
    dirty.current = true;
    if (current.pinch === null && chosen && Math.abs(chosen.to - chosen.from) > DRAG_PX) {
      const [from, to] = [timeAt(Math.min(chosen.from, chosen.to)), timeAt(Math.max(chosen.from, chosen.to))];
      const middle = (from + to) / 2;
      const span = Math.max(MIN_SPAN_MS, to - from);
      change({ live: false, from: middle - span / 2, to: middle + span / 2 });
    }
  };

  const leave = (event: PointerEvent<HTMLDivElement>) => {
    // A finger's tap leaves its values shown
    if (event.pointerType === 'mouse' && !drag.current) {
      hover.current = null;
      dirty.current = true;
    }
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    // Held, a key repeats before the next render
    const view = props.current.view;
    const now = chartNow();
    const changes: Record<string, () => View | null> = {
      ' ': () => (view.live ? { live: false, ...viewSpan(view, now) } : { live: true, span: viewSpan(view, now).to - viewSpan(view, now).from }),
      ArrowLeft: () => panView(view, now, -0.1),
      ArrowRight: () => panView(view, now, 0.1),
      '+': () => zoomView(view, now, 0.5, 0.5),
      '=': () => zoomView(view, now, 0.5, 0.5),
      '-': () => zoomView(view, now, 2, 0.5),
      Escape: () => (view.live && view.span === defaultSpan ? null : { live: true, span: defaultSpan }),
    };
    const next = changes[event.key]?.();
    if (next) {
      event.preventDefault();
      event.stopPropagation();
      change(next);
    }
  };

  return (
    <div
      ref={areaRef}
      className={`plot-area${disabled ? ' disabled' : ''}`}
      role="img"
      aria-label={label}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={leave}
      onBlur={() => {
        hover.current = null;
        dirty.current = true;
      }}
      onDoubleClick={() => !disabled && change({ live: true, span: defaultSpan })}
      onKeyDown={key}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {message && <div className="plot-message">{message}</div>}
      <div ref={tooltipRef} className="plot-tooltip" hidden>
        <div className="plot-tooltip-time" />
        {series.map((s) => (
          <div key={s.key} className="plot-tooltip-row">
            <span className="plot-key" style={{ background: `var(${s.color})` }} aria-hidden="true" />
            <strong />
            <span>{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
