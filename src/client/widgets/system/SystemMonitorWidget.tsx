// The robot's computer, as top, free, sensors and a Jetson's jtop show it:
// the CPU's cores and their frequencies, the memory, the temperatures by
// chip and the fans, a Raspberry Pi's throttling (under-voltage, capped
// frequency), the GPUs (a Jetson's, nvidia-smi's, amdgpu's), the power
// rails (a Jetson's INA3221), the disks' traffic and space, the networks'
// traffic; with charts of the last minutes. The server reads them every
// second while a page watches (see src/server/system.ts).

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { FsDisk } from '../../../shared/file_manager.ts';
import type { SystemUpdate } from '../../../shared/protocol.ts';
import {
  hottest,
  mainRail,
  throttlingFlags,
  trendPoint,
  type Gpu,
  type SystemInfo,
  type SystemSample,
  type TrendPoint,
} from '../../../shared/system.ts';
import { connection } from '../../connection.ts';
import { ChipIcon } from '../../icons.tsx';
import { formatSize } from '../file_manager/model.ts';
import { UsageBar } from '../file_manager/parts.tsx';
import { interfaceFilter } from '../networking/model.ts';
import { defineWidget, type WidgetProps } from '../types.ts';
import {
  chipName,
  formatCelsius,
  formatMhz,
  formatRate,
  formatUptime,
  formatWatts,
  HISTORY_MS,
  niceMax,
  percent,
  shownNetworks,
  sumSeries,
  temperatureGroups,
  temperatureLimits,
  temperatureTone,
} from './model.ts';
import { Card, Legend, Meter, TrendChart, type ChartPoint, type ChartSeries } from './parts.tsx';

interface SystemConfig {
  cpu: boolean;
  memory: boolean;
  temperatures: boolean;
  gpu: boolean;
  power: boolean;
  disks: boolean;
  network: boolean;
  interfaces: string;
}

interface State {
  info: SystemInfo | null;
  space: FsDisk[] | null;
  history: TrendPoint[];
  sample: SystemSample | null;
  error: string | null;
}

const EMPTY: State = { info: null, space: null, history: [], sample: null, error: null };

const ONE: ChartSeries[] = [{ name: 'Value', color: 'var(--sys-series-1)' }];
const DISK_SERIES: ChartSeries[] = [
  { name: 'Read', color: 'var(--sys-series-1)' },
  { name: 'Written', color: 'var(--sys-series-2)' },
];
const NETWORK_SERIES: ChartSeries[] = [
  { name: 'Received', color: 'var(--sys-series-1)' },
  { name: 'Sent', color: 'var(--sys-series-2)' },
];
// The rate charts' least top: idle traffic stays at the bottom
const RATE_FLOOR = 10_000;

function update(state: State, message: SystemUpdate): State {
  let { history } = state;
  if (message.history) {
    history = message.history;
  }
  if (message.sample) {
    const since = message.sample.at - HISTORY_MS;
    history = [...history.filter((point) => point.at >= since && point.at < message.sample!.at), trendPoint(message.sample)];
  }
  return {
    info: message.info ?? state.info,
    space: message.space ?? state.space,
    history,
    sample: message.sample ?? state.sample,
    error: message.error ?? state.error,
  };
}

function chartPoints(history: TrendPoint[], value: (point: TrendPoint) => number | null): ChartPoint[] {
  return history.map((point) => ({ at: point.at, values: [value(point)] }));
}

function CpuCard({ info, sample, history }: { info: SystemInfo; sample: SystemSample; history: TrendPoint[] }) {
  const online = sample.cores.filter((share) => share !== null).length;
  const known = sample.mhz.filter((mhz): mhz is number => mhz !== null);
  const labelled = sample.cores.length <= 12;
  return (
    <Card
      title="CPU"
      figure={percent(sample.cpu)}
      detail={[
        online < info.cores ? `${online} of ${info.cores} cores online` : `${info.cores} ${info.cores === 1 ? 'core' : 'cores'}`,
        known.length > 0 ? `${formatMhz(known.reduce((sum, mhz) => sum + mhz, 0) / known.length)} on average` : null,
        `load ${sample.load.map((load) => load.toFixed(2)).join(' ')}`,
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      <TrendChart label="CPU" series={ONE} points={chartPoints(history, (point) => point.cpu)} end={sample.at} max={1} format={percent} />
      <ul className={`sys-cores${labelled ? ' labelled' : ''}`} aria-label="Cores">
        {sample.cores.map((share, core) => {
          const mhz = sample.mhz[core];
          const text = share === null ? `Core ${core}: offline` : `Core ${core}: ${percent(share)}${mhz ? ` at ${formatMhz(mhz)}` : ''}`;
          return (
            <li key={core} className={`sys-core${share === null ? ' off' : ''}`} title={text} aria-label={text}>
              <span className="sys-core-bar">
                <span className="sys-core-fill" style={{ height: `${(share ?? 0) * 100}%` }} />
              </span>
              {labelled && <span className="sys-core-value">{share === null ? 'off' : Math.round(share * 100)}</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ThrottlingCard({ bits }: { bits: number }) {
  const flags = throttlingFlags(bits);
  const now = flags.filter((flag) => flag.now);
  const occurred = flags.filter((flag) => flag.occurred);
  const tone = now.length > 0 ? 'hot' : occurred.length > 0 ? 'warn' : 'ok';
  return (
    <Card
      title="Throttling"
      className={tone}
      figure={<span className={`sys-state ${tone}`}>{now.length > 0 ? now[0].label : occurred.length > 0 ? 'Since boot' : 'None'}</span>}
      detail={`The Raspberry Pi’s firmware: 0x${bits.toString(16)}`}
    >
      <ul className="sys-rows">
        {flags.map((flag) => (
          <li key={flag.label} className="sys-row sys-flag" title={flag.help}>
            <span className="sys-row-name">{flag.label}</span>
            <span className={`sys-state ${flag.now ? 'hot' : flag.occurred ? 'warn' : 'ok'}`}>
              {flag.now ? 'Now' : flag.occurred ? 'Since boot' : 'Never'}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MemoryCard({ sample, history }: { sample: SystemSample; history: TrendPoint[] }) {
  const { total, used, cached, swapTotal, swapUsed } = sample.memory;
  return (
    <Card
      title="Memory"
      figure={percent(total > 0 ? used / total : 0)}
      detail={`${formatSize(used)} used of ${formatSize(total)} · ${formatSize(cached)} of cache`}
    >
      <Meter share={total > 0 ? used / total : 0} extra={total > 0 ? cached / total : 0} label="Memory used, then cache" />
      <TrendChart
        label="Memory used"
        series={ONE}
        points={chartPoints(history, (point) => (total > 0 ? point.memory / total : null))}
        end={sample.at}
        max={1}
        format={percent}
      />
      {swapTotal > 0 && (
        <div className="sys-line-meter">
          <span className="sys-row-name">Swap</span>
          <Meter share={swapUsed / swapTotal} label="Swap used" />
          <span className="sys-row-value">
            {formatSize(swapUsed)} of {formatSize(swapTotal)}
          </span>
        </div>
      )}
    </Card>
  );
}

function TemperaturesCard({ sample, history }: { sample: SystemSample; history: TrendPoint[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = temperatureGroups(sample.temperatures);
  const top = hottest(sample.temperatures);
  const highest = Math.max(0, ...history.map((point) => point.temperature ?? 0));
  const toggle = (sensor: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(sensor)) {
        next.add(sensor);
      }
      return next;
    });
  // A sensor, or a chip's hottest with its others to unfold
  const row = (
    key: string,
    name: string,
    source: string | null,
    temperature: SystemSample['temperatures'][number],
    group?: { sensor: string; count: number },
    nested = false,
  ) => {
    const { critical } = temperatureLimits(temperature);
    const tone = temperatureTone(temperature);
    return (
      <li key={key} className={`sys-row sys-temperature${nested ? ' nested' : ''}`}>
        {group ? (
          <button type="button" className="sys-row-name sys-disclosure" aria-expanded={open.has(group.sensor)} onClick={() => toggle(group.sensor)}>
            {name}
            <span className="sys-muted">{group.count} sensors</span>
          </button>
        ) : (
          <span className="sys-row-name" title={source ?? undefined}>
            {name}
            {source && <span className="sys-muted">{source}</span>}
          </span>
        )}
        <Meter share={temperature.celsius / critical} tone={tone} label={`${name}: ${formatCelsius(temperature.celsius)} of ${formatCelsius(critical)} critical`} />
        <span className={`sys-row-value ${tone}`}>{formatCelsius(temperature.celsius)}</span>
      </li>
    );
  };
  return (
    <Card
      title="Temperatures"
      figure={top ? formatCelsius(top.celsius) : '–'}
      detail={top ? `Hottest: ${top.label ?? chipName(top.sensor)}${top.label ? ` (${chipName(top.sensor)})` : ''}` : 'No sensor'}
    >
      {top && (
        <TrendChart
          label="Hottest temperature"
          series={ONE}
          points={chartPoints(history, (point) => point.temperature)}
          end={sample.at}
          max={Math.max(100, Math.ceil(highest / 20) * 20)}
          format={formatCelsius}
        />
      )}
      <ul className="sys-rows">
        {groups.flatMap((group) => {
          if (group.temperatures.length === 1) {
            const [temperature] = group.temperatures;
            // Its label first (edge, Composite), else the chip's name, then
            // the chip's own if it says more
            const labelled = temperature.label !== null && group.sensor !== 'GPU';
            const name = labelled ? temperature.label! : group.name;
            const source = labelled ? group.name : group.name !== group.sensor && group.sensor !== 'GPU' ? group.sensor : null;
            return [row(group.sensor, name, source, temperature)];
          }
          return [
            row(group.sensor, group.name, null, group.hottest, { sensor: group.sensor, count: group.temperatures.length }),
            ...(open.has(group.sensor)
              ? group.temperatures.map((temperature, index) =>
                  row(`${group.sensor}-${index}`, temperature.label ?? `${group.name} ${index + 1}`, null, temperature, undefined, true),
                )
              : []),
          ];
        })}
      </ul>
      {sample.fans.length > 0 && (
        <ul className="sys-rows sys-fans" aria-label="Fans">
          {sample.fans.map((fan, index) => (
            <li key={index} className="sys-row">
              <span className="sys-row-name">{fan.label ?? `${chipName(fan.sensor)} fan ${index + 1}`}</span>
              <span className="sys-row-value">{fan.rpm} rpm</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GpuCard({ gpu, index, sample, history }: { gpu: Gpu; index: number; sample: SystemSample; history: TrendPoint[] }) {
  const facts = [
    gpu.mhz !== null && ['Clock', formatMhz(gpu.mhz)],
    gpu.celsius !== null && ['Temperature', formatCelsius(gpu.celsius)],
    gpu.watts !== null && ['Power', formatWatts(gpu.watts)],
  ].filter((fact): fact is [string, string] => !!fact);
  return (
    <Card title="GPU" figure={gpu.load === null ? '–' : percent(gpu.load)} detail={gpu.name}>
      {gpu.load !== null && (
        <TrendChart label={`${gpu.name} load`} series={ONE} points={chartPoints(history, (point) => point.gpus[index] ?? null)} end={sample.at} max={1} format={percent} />
      )}
      {gpu.memoryUsed !== null && gpu.memoryTotal !== null && gpu.memoryTotal > 0 && (
        <div className="sys-line-meter">
          <span className="sys-row-name">Memory</span>
          <Meter share={gpu.memoryUsed / gpu.memoryTotal} label="GPU memory used" />
          <span className="sys-row-value">
            {formatSize(gpu.memoryUsed)} of {formatSize(gpu.memoryTotal)}
          </span>
        </div>
      )}
      {facts.length > 0 && (
        <dl className="sys-facts">
          {facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function PowerCard({ sample, history }: { sample: SystemSample; history: TrendPoint[] }) {
  const main = mainRail(sample.power);
  const highest = Math.max(0, ...history.map((point) => point.watts ?? 0));
  return (
    <Card title="Power" figure={main ? formatWatts(main.watts) : undefined} detail={main ? `Through ${main.name}` : 'By rail'}>
      {main && (
        <TrendChart label={`Power through ${main.name}`} series={ONE} points={chartPoints(history, (point) => point.watts)} end={sample.at} max={niceMax(highest, 1)} format={formatWatts} />
      )}
      <ul className="sys-rows">
        {sample.power.map((rail) => (
          <li key={rail.name} className="sys-row">
            <span className="sys-row-name">{rail.name}</span>
            <span className="sys-muted sys-row-extra">
              {[rail.volts !== null && `${rail.volts.toFixed(2)} V`, rail.amps !== null && `${rail.amps.toFixed(2)} A`].filter(Boolean).join(' · ')}
            </span>
            <span className="sys-row-value">{formatWatts(rail.watts)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RatesCard({
  title,
  kind,
  series,
  names,
  history,
  sample,
  children,
}: {
  title: string;
  kind: 'disks' | 'networks';
  series: ChartSeries[];
  // Those summed in the chart
  names: string[];
  history: TrendPoint[];
  sample: SystemSample;
  children: ReactNode;
}) {
  const points = sumSeries(history, kind, names);
  const latest = points[points.length - 1]?.values ?? [0, 0];
  const highest = Math.max(0, ...points.flatMap((point) => point.values));
  return (
    <Card title={title} detail={<Legend series={series} values={latest} format={formatRate} />}>
      <TrendChart label={title} series={series} points={points} end={sample.at} max={niceMax(highest, RATE_FLOOR)} format={formatRate} />
      {children}
    </Card>
  );
}

function SystemMonitorWidget({ config }: WidgetProps<SystemConfig>) {
  const [state, setState] = useState<State>(EMPTY);
  useEffect(() => {
    setState(EMPTY);
    return connection.subscribeSystem((message) => setState((current) => update(current, message)));
  }, []);
  const filter = useMemo(() => (config.interfaces.trim() ? interfaceFilter(config.interfaces) : null), [config.interfaces]);

  const { info, space, history, sample, error } = state;
  if (error || !info || !sample) {
    return (
      <div className="sys">
        <p className={`sys-empty${error ? ' error' : ''}`}>{error ?? 'Reading the robot’s computer…'}</p>
      </div>
    );
  }

  const networks = shownNetworks(sample.networks, filter);
  const cards = [
    config.cpu && <CpuCard key="cpu" info={info} sample={sample} history={history} />,
    config.power && sample.throttled !== null && <ThrottlingCard key="throttling" bits={sample.throttled} />,
    config.memory && <MemoryCard key="memory" sample={sample} history={history} />,
    config.temperatures && (sample.temperatures.length > 0 || sample.fans.length > 0) && (
      <TemperaturesCard key="temperatures" sample={sample} history={history} />
    ),
    ...(config.gpu ? sample.gpus.map((gpu, index) => <GpuCard key={`gpu-${index}`} gpu={gpu} index={index} sample={sample} history={history} />) : []),
    config.power && sample.power.length > 0 && <PowerCard key="power" sample={sample} history={history} />,
    config.disks && (
      <RatesCard key="disks" title="Disks" kind="disks" series={DISK_SERIES} names={sample.disks.map((disk) => disk.name)} history={history} sample={sample}>
        <ul className="sys-rows">
          {sample.disks.map((disk) => (
            <li key={disk.name} className="sys-row sys-io disk">
              <span className="sys-row-name">{disk.name}</span>
              <span className="sys-row-value" title="Read">
                ↓ {formatRate(disk.read)}
              </span>
              <span className="sys-row-value" title="Written">
                ↑ {formatRate(disk.written)}
              </span>
              <span className="sys-row-value sys-busy" title="Of the time busy with I/O">
                {percent(disk.busy)}
              </span>
            </li>
          ))}
        </ul>
        {space && space.length > 0 && (
          <ul className="sys-rows sys-space" aria-label="Space">
            {space.map((disk) => (
              <li key={disk.mount} className="sys-row" title={`${disk.device} (${disk.type})${disk.readOnly ? ', read only' : ''}`}>
                <span className="sys-row-name">{disk.mount}</span>
                <UsageBar used={disk.used} total={disk.total} />
                <span className="sys-row-value">
                  {formatSize(disk.free)} free of {formatSize(disk.total)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </RatesCard>
    ),
    config.network && (
      <RatesCard key="network" title="Network" kind="networks" series={NETWORK_SERIES} names={networks.map((network) => network.name)} history={history} sample={sample}>
        <ul className="sys-rows">
          {networks.map((network) => (
            <li
              key={network.name}
              className={`sys-row sys-io${network.up ? '' : ' down'}`}
              title={`${formatSize(network.totalReceived)} received, ${formatSize(network.totalSent)} sent since it came up`}
            >
              <span className="sys-row-name">
                <span className={`sys-link ${network.up ? 'up' : 'down'}`} aria-hidden="true" />
                {network.name}
                {!network.up && <span className="sys-muted">down</span>}
              </span>
              <span className="sys-row-value" title="Received">
                ↓ {formatRate(network.received)}
              </span>
              <span className="sys-row-value" title="Sent">
                ↑ {formatRate(network.sent)}
              </span>
            </li>
          ))}
          {networks.length === 0 && <li className="sys-row sys-muted">No interface{filter ? ' matches' : ''}</li>}
        </ul>
      </RatesCard>
    ),
  ].filter(Boolean);

  const about = [
    info.cpu,
    `Linux ${info.kernel}`,
    info.jetson && `L4T ${info.jetson.release ?? '?'}${info.jetson.powerMode ? `, power mode ${info.jetson.powerMode}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="sys">
      <p className="sys-about" title={about}>
        <strong>{info.model ?? info.hostname}</strong>
        {[info.jetson?.powerMode && `${info.jetson.powerMode} mode`, info.os, `up ${formatUptime(sample.at - info.boot)}`]
          .filter(Boolean)
          .map((part) => (
            <span key={part as string}> · {part}</span>
          ))}
      </p>
      <div className="sys-cards">{cards}</div>
    </div>
  );
}

export const systemMonitorWidget = defineWidget<SystemConfig>({
  type: 'system-monitor',
  name: 'System Monitor',
  description: 'The robot’s computer: CPU per core, memory, temperatures, a Raspberry Pi’s throttling, GPUs, power, disks and networks.',
  icon: ChipIcon,
  defaultSize: { w: 8, h: 8 },
  minSize: { w: 3, h: 3 },
  component: SystemMonitorWidget,
  properties: [
    { key: 'cpu', label: 'CPU', kind: 'boolean', default: true, help: 'Its load, of each core, and their frequencies' },
    { key: 'memory', label: 'Memory', kind: 'boolean', default: true },
    { key: 'temperatures', label: 'Temperatures and fans', kind: 'boolean', default: true },
    { key: 'gpu', label: 'GPUs', kind: 'boolean', default: true, help: 'A Jetson’s, NVIDIA’s (nvidia-smi), AMD’s' },
    {
      key: 'power',
      label: 'Power and throttling',
      kind: 'boolean',
      default: true,
      help: 'Power rails (a Jetson’s), a CPU package’s when readable, a Raspberry Pi’s throttling',
    },
    { key: 'disks', label: 'Disks', kind: 'boolean', default: true, help: 'Their traffic and the file systems’ space' },
    { key: 'network', label: 'Networks', kind: 'boolean', default: true },
    {
      key: 'interfaces',
      label: 'Interfaces',
      kind: 'string',
      default: '',
      placeholder: 'wlan0, eth*',
      help: 'Names or globs, separated by commas or spaces: the device’s own (not docker’s, VPNs’) if none',
    },
  ],
});
