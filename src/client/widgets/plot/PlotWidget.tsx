// Plot: numbers of any topic over time (rqt_plot, a small PlotJuggler), e.g.
// /odom.twist.twist.linear.x, a battery's voltage, joints' efforts. The
// server reads every message of their topics (topic.monitor's samples) and
// sends their numbers ten times a second; the page keeps the latest minutes
// of each series. Paused, zoomed and scrolled through; what is shown is
// exported as CSV. The series are chosen in the widget (saved with the
// panel) or listed in its properties.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { StreamStatus } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import { DownloadIcon, PauseIcon, PlayIcon, PlotIcon, PlusIcon, SlidersIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { chartNow, PlotChart, type ChartSeries } from './PlotChart.tsx';
import {
  addSamples,
  BUFFER_MS,
  clockTime,
  csvText,
  MAX_SERIES,
  parseSeries,
  SeriesBuffer,
  seriesName,
  seriesPath,
  seriesText,
  topicFields,
  valueText,
  viewSpan,
  type Series,
  type View,
} from './model.ts';
import { SeriesDialog } from './SeriesDialog.tsx';

interface PlotConfig {
  series: string;
  window: number;
  scale: 'auto' | 'fixed';
  min: number;
  max: number;
}

const COLORS = Array.from({ length: MAX_SERIES }, (_, n) => `--plot-${n + 1}`);
// The legend's values, at most, a second
const LEGEND_RATE = 4;

function spanText(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Number((ms / 1000).toPrecision(3))} s`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// plot_myrobot_20261022_140327.csv
function fileName(prefix: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${connection.hostname || 'robot'}_${date}_${time}.csv`;
}

function PlotWidget({ config, editing, updateConfig }: WidgetProps<PlotConfig>) {
  const { series, invalid } = useMemo(() => parseSeries(config.series), [config.series]);
  const defaultSpan = Math.round(Math.min(BUFFER_MS / 1000, Math.max(1, config.window)) * 1000);
  const [view, setView] = useState<View>({ live: true, span: defaultSpan });
  useEffect(() => setView({ live: true, span: defaultSpan }), [defaultSpan]);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Live before pausing: as long again when going on
  const liveSpan = useRef(defaultSpan);
  if (view.live) {
    liveSpan.current = view.span;
  }
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [choosing, setChoosing] = useState(false);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, { state: StreamStatus['state']; message: string }>>(new Map());
  const [, setRevision] = useState(0);

  // The samples of each series, while it is plotted
  const buffers = useRef(new Map<string, SeriesBuffer>());
  for (const s of series) {
    if (!buffers.current.has(s.path)) {
      buffers.current.set(s.path, new SeriesBuffer());
    }
  }
  useEffect(() => {
    for (const path of buffers.current.keys()) {
      if (!series.some((s) => s.path === path)) {
        buffers.current.delete(path);
      }
    }
  }, [series]);

  // One subscription a topic, with its series' fields
  const fieldsKey = JSON.stringify([...topicFields(series)]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = null;
        setRevision((revision) => revision + 1);
      }, 1000 / LEGEND_RATE);
    };
    const unsubscribes = (JSON.parse(fieldsKey) as [string, string[]][]).map(([topic, fields]) =>
      connection.subscribeTopicMonitor(
        { topic, window: 2, echo: null, samples: fields },
        {
          status: (state, message) => setStatuses((previous) => new Map(previous).set(topic, { state, message })),
          samples: (samples) => {
            const targets = fields.map((field) => buffers.current.get(seriesPath(topic, field)));
            addSamples(targets, samples);
            // Paused, those shown are kept
            const before = viewRef.current.live ? chartNow() - BUFFER_MS : -Infinity;
            targets.forEach((buffer) => buffer?.trim(before));
            refresh();
          },
        },
      ),
    );
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [fieldsKey]);

  const changeSeries = (next: Series[]) => updateConfig({ series: seriesText(next) });

  const { from, to } = viewSpan(view, chartNow());
  const plotted = series.map((s, index) => ({ s, color: COLORS[index], buffer: buffers.current.get(s.path)! }));
  const shown: ChartSeries[] = plotted
    .filter(({ s }) => !hidden.has(s.path))
    .map(({ s, color, buffer }) => ({ key: s.path, name: seriesName(s), color, buffer }));
  const sampled = plotted.some(({ buffer }) => buffer.length > 0);
  const range = config.scale === 'fixed' && config.max > config.min ? { min: config.min, max: config.max } : null;

  // What keeps series from being drawn
  const notes: string[] = [];
  for (const topic of new Set(series.map((s) => s.topic))) {
    const status = statuses.get(topic);
    if (status && status.state !== 'streaming' && status.message) {
      notes.push(status.message);
    }
  }
  for (const { s, buffer } of plotted) {
    if (buffer.length > 0 && !buffer.numbers) {
      notes.push(`No number at ${s.path} in its messages`);
    }
  }
  for (const line of invalid) {
    notes.push(
      parseSeries(line).series.length > 0
        ? `${MAX_SERIES} series at most: ${line} is not plotted`
        : `Not a series: “${line}” (a topic, a dot and its field: /odom.twist.twist.linear.x)`,
    );
  }
  if (config.scale === 'fixed' && !range) {
    notes.push('Fixed scale: its maximum must be above its minimum');
  }

  const when = view.live ? `of the last ${spanText(view.span)}` : `from ${clockTime(from, 1000)} to ${clockTime(to, 1000)}`;
  const label = `Plot ${when}: ${plotted.map(({ s, buffer }) => `${seriesName(s)} ${valueText(buffer.valueAt(to))}`).join('; ')}`;

  const exportCsv = () => {
    const span = viewSpan(viewRef.current, chartNow());
    const columns = plotted.map(({ s, buffer }) => ({ name: seriesName(s), topic: s.topic, buffer }));
    download(fileName('plot'), csvText(columns, span.from, span.to));
  };

  return (
    <div className="plot">
      {series.length === 0 ? (
        <div className="widget-message plot-empty">
          <p>Numbers of any topic over time: odometry, a battery’s voltage, joints’ efforts.</p>
          <button type="button" className="button" disabled={editing} onClick={() => setChoosing(true)}>
            <PlusIcon width={16} height={16} />
            Add series
          </button>
          {editing && <p>Or list them in its properties.</p>}
        </div>
      ) : (
        <>
          <div className="plot-head">
            <div className="plot-legend">
              {plotted.map(({ s, color, buffer }) => {
                const on = !hidden.has(s.path);
                return (
                  <button
                    key={s.path}
                    type="button"
                    className="plot-legend-item"
                    aria-pressed={on}
                    title={`${s.path}: ${on ? 'hide' : 'show'} it`}
                    onClick={() =>
                      setHidden((previous) => {
                        const next = new Set(previous);
                        if (!next.delete(s.path)) {
                          next.add(s.path);
                        }
                        return next;
                      })
                    }
                  >
                    <span className="plot-key" style={{ background: `var(${color})` }} aria-hidden="true" />
                    <span className="plot-legend-name">{seriesName(s)}</span>
                    <strong>{valueText(buffer.valueAt(to))}</strong>
                  </button>
                );
              })}
            </div>
            <div className="plot-tools">
              {view.live ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Pause"
                  title="Pause (Space)"
                  disabled={editing}
                  onClick={() => setView({ live: false, ...viewSpan(viewRef.current, chartNow()) })}
                >
                  <PauseIcon width={16} height={16} />
                </button>
              ) : (
                <button
                  type="button"
                  className="button plot-live"
                  title="Go on live (double click)"
                  disabled={editing}
                  onClick={() => setView({ live: true, span: liveSpan.current })}
                >
                  <PlayIcon width={13} height={13} />
                  Live
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Export as CSV"
                title="Export what is shown as CSV"
                disabled={editing || !sampled}
                onClick={exportCsv}
              >
                <DownloadIcon width={16} height={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Series"
                title="Series"
                disabled={editing}
                onClick={() => setChoosing(true)}
              >
                <SlidersIcon width={16} height={16} />
              </button>
            </div>
          </div>
          {notes.length > 0 && (
            <ul className="plot-notes">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <PlotChart
            series={shown}
            view={view}
            onView={setView}
            defaultSpan={defaultSpan}
            range={range}
            disabled={editing}
            label={label}
            message={sampled ? null : 'Waiting for messages…'}
          />
        </>
      )}
      {series.length === 0 && invalid.length > 0 && (
        <ul className="plot-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {choosing && <SeriesDialog series={series} onChange={changeSeries} onClose={() => setChoosing(false)} />}
    </div>
  );
}

export const plotWidget = defineWidget<PlotConfig>({
  type: 'plot',
  name: 'Plot',
  description: 'Numbers of any topic over time: odometry, a battery’s voltage, joints’ efforts. Paused, zoomed, exported as CSV.',
  icon: PlotIcon,
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  component: PlotWidget,
  properties: [
    {
      key: 'series',
      label: 'Series',
      kind: 'text',
      default: '',
      placeholder: '/odom.twist.twist.linear.x\n/battery_state.voltage Battery\n/joint_states.effort[2] elbow',
      help: `One a line, ${MAX_SERIES} at most: the topic, a dot and its field (list items by their index), then a label if you like. Also chosen in the widget`,
    },
    {
      key: 'window',
      label: 'Time shown (s)',
      kind: 'number',
      default: 30,
      min: 1,
      max: BUFFER_MS / 1000,
      step: 1,
      help: 'Live. Drag across the plot to zoom in, the wheel zooms, Shift+wheel scrolls, a double click goes back live',
    },
    {
      key: 'scale',
      label: 'Scale',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Fitted to what is shown' },
        { value: 'fixed', label: 'Fixed' },
      ],
    },
    { key: 'min', label: 'Minimum', kind: 'number', default: 0, visible: (config) => config.scale === 'fixed' },
    { key: 'max', label: 'Maximum', kind: 'number', default: 1, visible: (config) => config.scale === 'fixed' },
  ],
});
