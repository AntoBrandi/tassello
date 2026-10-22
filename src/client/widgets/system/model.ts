// The system monitor's figures: units, the temperatures by chip, the
// interfaces and disks shown, the charts' scales.

import type { NetworkIo, Temperature, TrendPoint } from '../../../shared/system.ts';

// As much history as the server keeps
export const HISTORY_MS = 5 * 60_000;
// Points further apart than this are not joined: sampling stopped
export const GAP_MS = 3500;

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Bytes per second, as file sizes are shown (kB = 1000 bytes)
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1000) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  const units = ['kB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatMhz(mhz: number): string {
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(1)} GHz` : `${Math.round(mhz)} MHz`;
}

export function formatWatts(watts: number): string {
  return watts < 10 ? `${watts.toFixed(2)} W` : `${watts.toFixed(1)} W`;
}

export function formatCelsius(celsius: number): string {
  return `${Math.round(celsius)} °C`;
}

// 3 d 4 h, 5 h 12 min, 12 min
export function formatUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const [days, hours] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24];
  if (days > 0) {
    return `${days} d ${hours} h`;
  }
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

// Chips' names, as people know them
const CHIPS: Record<string, string> = {
  coretemp: 'CPU cores',
  k10temp: 'CPU',
  zenpower: 'CPU',
  'cpu-thermal': 'CPU',
  cpu_thermal: 'CPU',
  'CPU-therm': 'CPU',
  x86_pkg_temp: 'CPU package',
  TCPU: 'CPU',
  'gpu-thermal': 'GPU',
  'GPU-therm': 'GPU',
  amdgpu: 'AMD GPU',
  nvme: 'NVMe drive',
  drivetemp: 'Drive',
  acpitz: 'ACPI',
  'soc-thermal': 'SoC',
  'tj-thermal': 'Junction',
  'Tdiode_tegra': 'SoC diode',
  'thermal-fan-est': 'Fan estimate',
};

export function chipName(sensor: string): string {
  return CHIPS[sensor] ?? (/^iwlwifi/.test(sensor) ? 'Wi-Fi' : sensor);
}

export interface TemperatureLimits {
  high: number;
  critical: number;
}

// Where a sensor is hot and too hot: its own limits, else 80 and 95 °C; hot
// from 80 °C at the latest when it only says critical (a Raspberry Pi's 110,
// though it throttles from 80) or the same for both (coretemp's 100)
export function temperatureLimits(temperature: Temperature): TemperatureLimits {
  const critical = temperature.critical ?? (temperature.high !== null ? temperature.high + 15 : 95);
  const high = temperature.high !== null && temperature.high < critical ? temperature.high : Math.min(80, critical - 15);
  return { high, critical };
}

export function temperatureTone(temperature: Temperature): 'ok' | 'warn' | 'hot' {
  const { high, critical } = temperatureLimits(temperature);
  return temperature.celsius >= critical ? 'hot' : temperature.celsius >= high ? 'warn' : 'ok';
}

export interface TemperatureGroup {
  // The chip's sensor name
  sensor: string;
  name: string;
  hottest: Temperature;
  temperatures: Temperature[];
}

// The temperatures by chip, as read (rows that do not jump), each with its
// hottest
export function temperatureGroups(temperatures: Temperature[]): TemperatureGroup[] {
  const groups = new Map<string, TemperatureGroup>();
  for (const temperature of temperatures) {
    const group = groups.get(temperature.sensor);
    if (!group) {
      groups.set(temperature.sensor, {
        sensor: temperature.sensor,
        name: temperature.sensor === 'GPU' && temperature.label ? temperature.label : chipName(temperature.sensor),
        hottest: temperature,
        temperatures: [temperature],
      });
    } else {
      group.temperatures.push(temperature);
      if (temperature.celsius > group.hottest.celsius) {
        group.hottest = temperature;
      }
    }
  }
  return [...groups.values()];
}

// Those chosen (see the networking widget's interfaceFilter); else the
// device's own (not docker's bridges, VPNs' tunnels: their traffic is the
// devices' too)
export function shownNetworks(networks: NetworkIo[], filter: ((name: string) => boolean) | null): NetworkIo[] {
  return networks.filter((network) => (filter ? filter(network.name) : network.physical));
}

// The charts' points of a few series, the sums of those of some names
export function sumSeries(history: TrendPoint[], key: 'networks' | 'disks', names: string[]): { at: number; values: number[] }[] {
  return history.map((point) => {
    const values = [0, 0];
    for (const name of names) {
      const pair = point[key][name];
      if (pair) {
        values[0] += pair[0];
        values[1] += pair[1];
      }
    }
    return { at: point.at, values };
  });
}

// The top of a chart of rates: 1, 2 or 5 times a power of ten, at least floor
export function niceMax(value: number, floor: number): number {
  const top = Math.max(value, floor);
  const power = 10 ** Math.floor(Math.log10(top));
  return ([1, 2, 5, 10].find((step) => step * power >= top) ?? 10) * power;
}

// Runs of points close enough to be joined
export function segments<P extends { at: number }>(points: P[]): P[][] {
  const runs: P[][] = [];
  let run: P[] = [];
  for (const point of points) {
    if (run.length > 0 && point.at - run[run.length - 1].at > GAP_MS) {
      runs.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) {
    runs.push(run);
  }
  return runs;
}

// The point nearest a time, by binary search of points in time order
export function nearest<P extends { at: number }>(points: P[], at: number): P | null {
  if (points.length === 0) {
    return null;
  }
  let [low, high] = [0, points.length - 1];
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle].at <= at) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return Math.abs(points[low].at - at) <= Math.abs(points[high].at - at) ? points[low] : points[high];
}

// 42 s ago, 3 min 5 s ago: before the latest sample
export function ago(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds <= 0) {
    return 'now';
  }
  return seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ${seconds % 60} s ago`;
}
