// The CPU's load, of all the cores or of the busiest, with its last minute:
// the System Monitor's samples (see src/server/system.ts), every second.

import { useEffect, useState } from 'react';

import type { SystemUpdate } from '../../../shared/protocol.ts';
import type { SystemSample } from '../../../shared/system.ts';
import { connection } from '../../connection.ts';
import { ChipIcon } from '../../icons.tsx';
import { defineStatusWidget, type StatusWidgetProps } from '../types.ts';
import { cpuShare, cpuTitle, loadTone, sparkline, type ChartPoint } from './model.ts';
import { StatusReadout } from './StatusReadout.tsx';

interface CpuStatusConfig {
  of: 'all' | 'busiest';
  warnAbove: number;
  criticalAbove: number;
  chart: boolean;
}

interface State {
  sample: SystemSample | null;
  cpu: string | null;
  // Of all the cores, and of the busiest
  points: { at: number; all: number; busiest: number }[];
  error: string | null;
}

const CHART_MS = 60_000;
const CHART_WIDTH = 100;
const CHART_HEIGHT = 20;

function update(state: State, message: SystemUpdate): State {
  let { points } = state;
  if (message.history) {
    // The history has the total only
    points = message.history.map((point) => ({ at: point.at, all: point.cpu, busiest: point.cpu }));
  }
  if (message.sample) {
    const { sample } = message;
    points = [
      ...points.filter((point) => point.at >= sample.at - CHART_MS && point.at < sample.at),
      { at: sample.at, all: sample.cpu, busiest: cpuShare(sample, 'busiest') },
    ];
  }
  return {
    sample: message.sample ?? state.sample,
    cpu: message.info?.cpu ?? state.cpu,
    points,
    error: message.error ?? state.error,
  };
}

function CpuStatus({ config }: StatusWidgetProps<CpuStatusConfig>) {
  const [state, setState] = useState<State>({ sample: null, cpu: null, points: [], error: null });
  useEffect(() => connection.subscribeSystem((message) => setState((current) => update(current, message))), []);

  const { sample, error } = state;
  if (!sample) {
    return (
      <StatusReadout
        icon={<ChipIcon width={16} height={16} />}
        value={error ? '—' : '…'}
        tone="off"
        title={error ?? 'Reading the robot’s computer…'}
        narrow="value"
      />
    );
  }
  const share = cpuShare(sample, config.of);
  const chart: ChartPoint[] = state.points.map((point) => ({ at: point.at, value: point[config.of] }));
  return (
    <StatusReadout
      icon={<ChipIcon width={16} height={16} />}
      value={`${Math.round(share * 100)}%`}
      tone={loadTone(share, config.warnAbove, config.criticalAbove)}
      title={cpuTitle(sample, state.cpu)}
      narrow="value"
    >
      {config.chart && (
        <svg className="status-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={sparkline(chart, sample.at, CHART_MS, CHART_WIDTH, CHART_HEIGHT)} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </StatusReadout>
  );
}

export const cpuStatusWidget = defineStatusWidget<CpuStatusConfig>({
  type: 'cpu-status',
  name: 'CPU',
  description: 'The load of the robot’s processor, of all its cores or the busiest, with its last minute.',
  icon: ChipIcon,
  defaultWidth: 3,
  minWidth: 1,
  component: CpuStatus,
  properties: [
    {
      key: 'of',
      label: 'Load of',
      kind: 'select',
      default: 'all',
      options: [
        { value: 'all', label: 'All the cores' },
        { value: 'busiest', label: 'The busiest core' },
      ],
      help: 'The busiest shows a node that keeps one core busy, which the total of many hides',
    },
    { key: 'warnAbove', label: 'Busy above (%)', kind: 'number', default: 75, min: 0, max: 100, help: 'In yellow above this load' },
    { key: 'criticalAbove', label: 'Too busy above (%)', kind: 'number', default: 90, min: 0, max: 100, help: 'In red above this one' },
    { key: 'chart', label: 'Chart', kind: 'boolean', default: true, help: 'The last minute, when the widget is wide enough' },
  ],
});
