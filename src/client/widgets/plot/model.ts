// The plot's series and what is drawn of them: the series as the panel keeps
// them (one a line: /topic.field, then a label), the samples of each, the
// points of a span of time that a pixel column keeps, the axes' ticks, the
// view's zoom and pan, the CSV of a span, and the numeric fields of a message
// to choose from.

import type { TopicSamples } from '../../../shared/monitor.ts';
import { isTruncated } from '../monitor/model.ts';

// Series of a chart, at most: the palette's colours
export const MAX_SERIES = 8;
// Samples kept of each series: the latest BUFFER_MS, at most MAX_POINTS
// (200 s of a 1 kHz topic)
export const BUFFER_MS = 10 * 60_000;
export const MAX_POINTS = 200_000;
export const MIN_SPAN_MS = 100;
// Samples further apart than this, and than GAP_FACTOR times the interval
// before, are not joined: the topic stopped
const GAP_MS = 1000;
const GAP_FACTOR = 4;

export interface Series {
  // /odom.twist.twist.linear.x
  path: string;
  topic: string;
  // twist.twist.linear.x, effort[2]
  field: string;
  // Chosen, else empty: the path is shown
  label: string;
}

// /odom.twist.twist.linear.x, /values[2]
export function seriesPath(topic: string, field: string): string {
  return `${topic}${field.startsWith('[') ? '' : '.'}${field}`;
}

// The series of the panel's text, one a line: a topic, a dot and the field
// (/odom.twist.twist.linear.x), then a label after a space if any; each once,
// MAX_SERIES at most. The lines that are not series are returned too.
export function parseSeries(text: string): { series: Series[]; invalid: string[] } {
  const series: Series[] = [];
  const invalid: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (!line) {
      continue;
    }
    const [path, ...words] = line.split(/\s+/);
    // Topics' names have neither dots nor brackets
    const split = path.search(/[.[]/);
    const topic = split > 0 ? path.slice(0, split).replace(/^\/?/, '/') : '';
    const field = split > 0 ? path.slice(split).replace(/^\./, '') : '';
    if (!topic || topic === '/' || !field || series.length >= MAX_SERIES) {
      invalid.push(line);
      continue;
    }
    const normal = seriesPath(topic, field);
    if (!series.some((s) => s.path === normal)) {
      series.push({ path: normal, topic, field, label: words.join(' ') });
    }
  }
  return { series, invalid };
}

export function seriesText(series: Series[]): string {
  return series.map((s) => (s.label ? `${s.path} ${s.label}` : s.path)).join('\n');
}

export function seriesName(series: Series): string {
  return series.label || series.path;
}

// The fields sampled of each topic, in the series' order
export function topicFields(series: Series[]): Map<string, string[]> {
  const topics = new Map<string, string[]>();
  for (const s of series) {
    topics.set(s.topic, [...(topics.get(s.topic) ?? []), s.field]);
  }
  return topics;
}

// A series' samples, oldest first: their times on the server's clock (ms)
// and values, NaN where a message had no number there and where the line
// breaks. The latest are kept, as the plot trims them.
export class SeriesBuffer {
  times = new Float64Array(1024);
  values = new Float64Array(1024);
  // The samples are those from start to end
  start = 0;
  end = 0;
  // Of the latest two samples; 0 if unknown
  private interval = 0;
  // A number came
  numbers = false;

  get length(): number {
    return this.end - this.start;
  }

  push(at: number, value: number | null): void {
    if (this.length > 0) {
      const last = this.times[this.end - 1];
      // The server's clock was set back: the samples before are of no use
      if (at < last - GAP_MS) {
        this.clear();
      } else {
        at = Math.max(at, last);
        if (this.interval > 0 && at - last > Math.max(GAP_MS, GAP_FACTOR * this.interval)) {
          this.append(last, Number.NaN);
        }
        this.interval = at - last;
      }
    }
    this.append(at, value ?? Number.NaN);
    this.numbers ||= value !== null;
  }

  // Those before a time, and beyond MAX_POINTS
  trim(before: number): void {
    this.start = Math.max(this.indexAt(before), this.end - MAX_POINTS);
  }

  clear(): void {
    this.start = 0;
    this.end = 0;
    this.interval = 0;
  }

  // The first sample at or after a time (end if none)
  indexAt(at: number): number {
    let [low, high] = [this.start, this.end];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.times[middle] < at) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  // The value at a time: the latest sample's at or before it, null if none
  // or if the line breaks there
  valueAt(at: number): number | null {
    const index = this.indexAt(at);
    const found = index < this.end && this.times[index] === at ? index : index - 1;
    if (found < this.start || Number.isNaN(this.values[found])) {
      return null;
    }
    return this.values[found];
  }

  private append(at: number, value: number): void {
    if (this.end === this.times.length) {
      // Those trimmed make room, else the arrays double
      const size = this.length < this.times.length / 2 ? this.times.length : this.times.length * 2;
      const [times, values] = [new Float64Array(size), new Float64Array(size)];
      times.set(this.times.subarray(this.start, this.end));
      values.set(this.values.subarray(this.start, this.end));
      [this.times, this.values, this.end, this.start] = [times, values, this.length, 0];
    }
    this.times[this.end] = at;
    this.values[this.end] = value;
    this.end++;
  }
}

// Of each field of a topic's samples: its buffer, if still plotted
export function addSamples(buffers: (SeriesBuffer | undefined)[], samples: TopicSamples): void {
  buffers.forEach((buffer, field) => {
    if (buffer) {
      samples.at.forEach((at, index) => buffer.push(at, samples.values[field][index]));
    }
  });
}

export interface Points {
  times: number[];
  // NaN: the line breaks
  values: number[];
}

// The points drawn of a span, from columns pixel columns: all the samples
// when there are few, else in each column the first, lowest, highest and
// last (the line's shape is kept, with its spikes); with the samples just
// outside the span, which the line comes from and goes to
export function pointsIn(buffer: SeriesBuffer, from: number, to: number, columns: number): Points {
  const first = Math.max(buffer.start, buffer.indexAt(from) - 1);
  const last = Math.min(buffer.end, buffer.indexAt(to) + 1);
  const points: Points = { times: [], values: [] };
  const add = (index: number) => {
    points.times.push(buffer.times[index]);
    points.values.push(buffer.values[index]);
  };
  if (last - first <= 4 * columns) {
    for (let index = first; index < last; index++) {
      add(index);
    }
    return points;
  }
  const width = (to - from) / columns;
  let column = Number.NaN;
  let [low, high, start, end, broken] = [-1, -1, -1, -1, false];
  const flush = () => {
    if (start < 0) {
      return;
    }
    const kept = low < 0 ? [start, end] : [start, Math.min(low, high), Math.max(low, high), end];
    kept.filter((index, n) => n === 0 || index !== kept[n - 1]).forEach(add);
    if (broken) {
      points.times.push(buffer.times[end]);
      points.values.push(Number.NaN);
    }
  };
  for (let index = first; index < last; index++) {
    const at = Math.floor((buffer.times[index] - from) / width);
    if (at !== column) {
      flush();
      [column, low, high, start, broken] = [at, -1, -1, index, false];
    }
    end = index;
    const value = buffer.values[index];
    if (Number.isNaN(value)) {
      broken = true;
    } else {
      if (low < 0 || value < buffer.values[low]) {
        low = index;
      }
      if (high < 0 || value > buffer.values[high]) {
        high = index;
      }
    }
  }
  flush();
  return points;
}

export interface Ticks {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

// 1, 2 or 5 times a power of ten
function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  return ([1, 2, 5, 10].find((step) => step * power >= rough * (1 - 1e-9)) ?? 10) * power;
}

// The value axis of what is shown: from and to round values, a tick every
// round step, about count of them; a flat line in the middle
export function valueTicks(low: number, high: number, count: number): Ticks {
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    [low, high] = [0, 1];
  } else if (high - low < Math.max(Math.abs(high), 1) * 1e-9) {
    const margin = Math.abs(low) > 1 ? Math.abs(low) / 10 : 1;
    [low, high] = [low - margin, high + margin];
  }
  const step = niceStep((high - low) / Math.max(1, count));
  const [min, max] = [Math.floor(low / step + 1e-9) * step, Math.ceil(high / step - 1e-9) * step];
  const ticks: number[] = [];
  for (let n = 0; min + n * step <= max + step / 2; n++) {
    ticks.push(min + n * step);
  }
  return { min, max, step, ticks };
}

const TIME_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];

// The time axis: a tick every round step, at most count of them; live, at
// whole steps before now (the grid stays as the lines scroll), else at
// whole steps of the clock
export function timeTicks(from: number, to: number, count: number, live: boolean): { step: number; ticks: number[] } {
  const step = TIME_STEPS.find((s) => (to - from) / s <= count) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const ticks: number[] = [];
  const first = live ? to - Math.floor((to - from) / step) * step : Math.ceil(from / step) * step;
  for (let at = first; at <= to + 1e-6; at += step) {
    ticks.push(at);
  }
  return { step, ticks };
}

// −20 s, −1.5 s, −2 min, now
export function relativeTime(ms: number, step: number): string {
  if (Math.abs(ms) < step / 2) {
    return 'now';
  }
  if (step >= 60_000 && step % 60_000 === 0) {
    return `−${Math.round(ms / 60_000)} min`;
  }
  const digits = step >= 1000 ? 0 : step >= 100 ? 1 : step >= 10 ? 2 : 3;
  return `−${(ms / 1000).toFixed(digits)} s`;
}

// 14:03:20, 14:03:21.25: as precise as the ticks are apart
export function clockTime(at: number, step: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const digits = step >= 1000 ? 0 : step >= 100 ? 1 : step >= 10 ? 2 : 3;
  return digits === 0 ? time : `${time}.${pad(date.getMilliseconds(), 3).slice(0, digits)}`;
}

// A tick's value, with the step's decimals
export function tickText(value: number, step: number): string {
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return (Math.abs(value) < step / 2 ? 0 : value).toFixed(Math.min(digits, 12));
}

// A value read: 4 significant digits, or its units for big ones
export function valueText(value: number | null): string {
  if (value === null) {
    return '–';
  }
  const size = Math.abs(value);
  if (size === 0) {
    return '0';
  }
  if (size < 1e-3 || size >= 1e15) {
    return value.toExponential(2);
  }
  return size >= 1000 ? value.toFixed(1) : String(Number(value.toPrecision(4)));
}

// What the chart shows: the latest span ms, scrolling, or a span of time
export type View = { live: true; span: number } | { live: false; from: number; to: number };

export function viewSpan(view: View, now: number): { from: number; to: number } {
  return view.live ? { from: now - view.span, to: now } : view;
}

function clampSpan(span: number): number {
  return Math.min(BUFFER_MS, Math.max(MIN_SPAN_MS, span));
}

// By factor (>1: out) around a point of the span (0: its start, 1: its end);
// live, a shorter or longer span to now
export function zoomView(view: View, now: number, factor: number, anchor: number): View {
  if (view.live) {
    return { live: true, span: clampSpan(view.span * factor) };
  }
  const span = clampSpan((view.to - view.from) * factor);
  const at = view.from + anchor * (view.to - view.from);
  return { live: false, from: at - anchor * span, to: at - anchor * span + span };
}

// By a share of the span (<0: back in time), not past now: the view stops
export function panView(view: View, now: number, share: number): View {
  const { from, to } = viewSpan(view, now);
  const shift = Math.min(share * (to - from), now - to);
  return { live: false, from: from + shift, to: to + shift };
}

// The samples of a span as CSV: the time (s since the epoch, as ROS's), then
// a column for each series; a row for each message, those of a topic's
// series on the same rows
export function csvText(
  columns: { name: string; topic: string; buffer: SeriesBuffer }[],
  from: number,
  to: number,
): string {
  const quote = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = [['time', ...columns.map((c) => quote(c.name))].join(',')];
  const cursors = columns.map((c) => c.buffer.indexAt(from));
  const ends = columns.map((c) => c.buffer.indexAt(to + 1e-6));
  for (;;) {
    // The earliest sample left, and the samples of its topic at that time
    let next = -1;
    columns.forEach((c, n) => {
      if (cursors[n] < ends[n] && (next < 0 || c.buffer.times[cursors[n]] < columns[next].buffer.times[cursors[next]])) {
        next = n;
      }
    });
    if (next < 0) {
      break;
    }
    const at = columns[next].buffer.times[cursors[next]];
    const cells = columns.map((c, n) => {
      if (c.topic !== columns[next].topic || cursors[n] >= ends[n] || c.buffer.times[cursors[n]] !== at) {
        return '';
      }
      const value = c.buffer.values[cursors[n]++];
      return Number.isNaN(value) ? '' : String(value);
    });
    if (cells.some(Boolean)) {
      lines.push([(at / 1000).toFixed(3), ...cells].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface NumericField {
  // twist.twist.linear.x, effort[2]
  field: string;
  value: number | null;
  // An item's name, of a list beside of the same length: a joint's
  name: string | null;
}

// Lists of names that name the items of the lists beside them (JointState's)
const NAME_LISTS = ['name', 'names', 'joint_names'];

function items(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  return isTruncated(value) && Array.isArray(value.head) ? value.head : null;
}

// Of a list, cut or not
function size(value: unknown): number {
  return isTruncated(value) ? value.$truncated : Array.isArray(value) ? value.length : 0;
}

function numberOf(value: unknown): { value: number | null } | null {
  if (typeof value === 'number') {
    return { value };
  }
  if (typeof value === 'boolean') {
    return { value: value ? 1 : 0 };
  }
  if (value !== null && typeof value === 'object') {
    if ('$int' in value && typeof value.$int === 'string') {
      return { value: Number(value.$int) };
    }
    if ('$number' in value) {
      return { value: null };
    }
    if ('sec' in value && 'nanosec' in value && typeof value.sec === 'number' && typeof value.nanosec === 'number') {
      return { value: value.sec + value.nanosec / 1e9 };
    }
  }
  return null;
}

// The fields of an echoed message (see TopicEcho) that a plot takes, as the
// server reads them (sampleValue): numbers, booleans, times; and whether
// lists were cut, whose further items are not listed
export function numericFields(message: unknown, limit = 1000): { fields: NumericField[]; cut: boolean } {
  const fields: NumericField[] = [];
  let cut = false;
  const walk = (value: unknown, path: string) => {
    if (fields.length >= limit) {
      cut = true;
      return;
    }
    const number = numberOf(value);
    if (number) {
      fields.push({ field: path, value: number.value, name: null });
      return;
    }
    const list = items(value);
    if (list) {
      cut ||= isTruncated(value);
      list.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const named = entries.find(([key, v]) => NAME_LISTS.includes(key) && items(v)?.every((n) => typeof n === 'string'));
    const names = named && { items: items(named[1]) as string[], size: size(named[1]) };
    for (const [key, item] of entries) {
      const child = path ? `${path}.${key}` : key;
      const list = items(item);
      if (names && list && size(item) === names.size && list.every((v) => numberOf(v))) {
        cut ||= isTruncated(item);
        list.forEach((v, index) => {
          if (fields.length < limit) {
            fields.push({ field: `${child}[${index}]`, value: numberOf(v)!.value, name: names.items[index] ?? null });
          }
        });
      } else {
        walk(item, child);
      }
    }
  };
  walk(message, '');
  return { fields, cut };
}

// The label of a field of a named item: elbow_joint effort
export function fieldLabel(field: NumericField): string {
  return field.name ? `${field.name} ${field.field.replace(/\[\d+\]$/, '').split('.').pop()}` : '';
}
