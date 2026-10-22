// The system monitor's charts and meters

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';

import { ago, HISTORY_MS, nearest, segments } from './model.ts';

export interface ChartSeries {
  name: string;
  // A CSS colour: var(--sys-series-1)
  color: string;
}

export interface ChartPoint {
  at: number;
  values: (number | null)[];
}

const CHART_HEIGHT = 56;

function useWidth<E extends HTMLElement>(): [RefObject<E | null>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// The last minutes of one or two series, on one scale from 0 to max: a line
// (with a wash under it when alone), a crosshair and the values at the
// pointer, or at the point chosen by the arrow keys
export function TrendChart({
  label,
  series,
  points,
  end,
  max,
  format,
}: {
  label: string;
  series: ChartSeries[];
  // In time order
  points: ChartPoint[];
  // The latest sample's time: the right edge
  end: number;
  max: number;
  format: (value: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // The time of the point shown: the points are made anew with each sample
  const [hover, setHover] = useState<number | null>(null);
  const start = end - HISTORY_MS;
  const shown = points.filter((point) => point.at >= start);
  const x = (at: number) => ((at - start) / HISTORY_MS) * width;
  const y = (value: number) => CHART_HEIGHT - 1 - (Math.min(max, Math.max(0, value)) / max) * (CHART_HEIGHT - 2);
  // Until it leaves the chart
  const current = hover === null ? null : (shown.find((point) => point.at === hover) ?? null);

  const lines = series.map((_, index) =>
    segments(shown)
      .flatMap((run) => {
        // Unknown values break the line too
        const parts: ChartPoint[][] = [[]];
        for (const point of run) {
          if (point.values[index] === null) {
            parts.push([]);
          } else {
            parts[parts.length - 1].push(point);
          }
        }
        return parts.filter((part) => part.length > 0);
      })
      .map((part) => part.map((point) => [x(point.at), y(point.values[index]!)] as const)),
  );

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = start + ((event.clientX - box.left) / box.width) * HISTORY_MS;
    const found = nearest(shown, at);
    setHover(found && Math.abs(found.at - at) <= HISTORY_MS / 60 ? found.at : null);
  };

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = current ? shown.indexOf(current) : shown.length - 1;
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: shown.length - 1 }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setHover(shown[Math.max(0, Math.min(shown.length - 1, next))]?.at ?? null);
    } else if (event.key === 'Escape') {
      setHover(null);
    }
  };

  const latest = shown[shown.length - 1];
  const highest = series.map((_, index) => Math.max(0, ...shown.map((point) => point.values[index] ?? 0)));
  const summary = `${label}, the last ${HISTORY_MS / 60_000} minutes: ${series
    .map((s, index) => `${series.length > 1 ? `${s.name} ` : ''}${latest?.values[index] != null ? format(latest.values[index]) : 'unknown'} now, at most ${format(highest[index])}`)
    .join('; ')}`;

  return (
    <div className="sys-chart">
      <div
        ref={ref}
        className="sys-chart-plot"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(latest?.at ?? null)}
        onBlur={() => setHover(null)}
        onKeyDown={step}
      >
        {width > 0 && (
          <svg width={width} height={CHART_HEIGHT} aria-hidden="true">
            <line className="sys-grid" x1={0} x2={width} y1={0.5} y2={0.5} />
            <line className="sys-grid" x1={0} x2={width} y1={CHART_HEIGHT / 2} y2={CHART_HEIGHT / 2} />
            <line className="sys-axis" x1={0} x2={width} y1={CHART_HEIGHT - 0.5} y2={CHART_HEIGHT - 0.5} />
            {series.length === 1 &&
              lines[0].map((part, index) => (
                <path
                  key={`area-${index}`}
                  className="sys-area"
                  style={{ fill: series[0].color }}
                  d={`M${part[0][0]},${CHART_HEIGHT}${part.map(([px, py]) => `L${px},${py}`).join('')}L${part[part.length - 1][0]},${CHART_HEIGHT}Z`}
                />
              ))}
            {lines.map((parts, index) =>
              parts.map((part, run) => (
                <path
                  key={`${index}-${run}`}
                  className="sys-line"
                  style={{ stroke: series[index].color }}
                  d={part.length === 1 ? `M${part[0][0] - 1},${part[0][1]}h2` : `M${part.map(([px, py]) => `${px},${py}`).join('L')}`}
                />
              )),
            )}
            {current && (
              <g>
                <line className="sys-crosshair" x1={x(current.at)} x2={x(current.at)} y1={0} y2={CHART_HEIGHT} />
                {current.values.map((value, index) =>
                  value === null ? null : (
                    <circle key={index} className="sys-marker" style={{ fill: series[index].color }} cx={x(current.at)} cy={y(value)} r={4} />
                  ),
                )}
              </g>
            )}
          </svg>
        )}
        <span className="sys-chart-max">{format(max)}</span>
        {current && (
          <div
            className="sys-tooltip"
            style={x(current.at) > width / 2 ? { right: width - x(current.at) + 10 } : { left: x(current.at) + 10 }}
          >
            {current.values.map((value, index) => (
              <div key={index} className="sys-tooltip-row">
                {series.length > 1 && <span className="sys-key" style={{ background: series[index].color }} aria-hidden="true" />}
                <strong>{value === null ? '?' : format(value)}</strong>
                {series.length > 1 && <span>{series[index].name}</span>}
              </div>
            ))}
            <div className="sys-tooltip-time">{ago(end - current.at)}</div>
          </div>
        )}
      </div>
      <div className="sys-chart-times" aria-hidden="true">
        <span>{HISTORY_MS / 60_000} min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

// Of two series: their names with their line keys and values now
export function Legend({ series, values, format }: { series: ChartSeries[]; values: number[]; format: (value: number) => string }) {
  return (
    <div className="sys-legend">
      {series.map((s, index) => (
        <span key={s.name} className="sys-legend-item">
          <span className="sys-key" style={{ background: s.color }} aria-hidden="true" />
          {s.name} <strong>{format(values[index] ?? 0)}</strong>
        </span>
      ))}
    </div>
  );
}

// A share of a whole, its fill coloured by its tone; a second, lighter part
// after it (cached memory)
export function Meter({
  share,
  extra = 0,
  tone = 'ok',
  label,
}: {
  share: number;
  extra?: number;
  tone?: 'ok' | 'warn' | 'hot';
  label: string;
}) {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return (
    <span className={`sys-meter ${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamp(share) * 100)}>
      <span className="sys-meter-fill" style={{ width: `${clamp(share) * 100}%` }} />
      {extra > 0 && <span className="sys-meter-extra" style={{ width: `${clamp(Math.min(extra, 1 - share)) * 100}%` }} />}
    </span>
  );
}

export function Card({
  title,
  figure,
  detail,
  children,
  className = '',
}: {
  title: string;
  figure?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`sys-card ${className}`} aria-label={title}>
      <header className="sys-card-head">
        <h3>{title}</h3>
        {figure !== undefined && <span className="sys-figure">{figure}</span>}
      </header>
      {detail && <div className="sys-detail">{detail}</div>}
      {children}
    </section>
  );
}
