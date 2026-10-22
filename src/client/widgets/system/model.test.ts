import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NetworkIo, Temperature, TrendPoint } from '../../../shared/system.ts';
import { interfaceFilter } from '../networking/model.ts';
import {
  ago,
  formatMhz,
  formatRate,
  formatUptime,
  formatWatts,
  nearest,
  niceMax,
  percent,
  segments,
  shownNetworks,
  sumSeries,
  temperatureGroups,
  temperatureLimits,
  temperatureTone,
} from './model.ts';

const temperature = (sensor: string, celsius: number, label: string | null = null, high: number | null = null, critical: number | null = null): Temperature => ({
  sensor,
  label,
  celsius,
  high,
  critical,
});

test('figures in their units', () => {
  assert.equal(percent(0.236), '24%');
  assert.equal(formatRate(512), '512 B/s');
  assert.equal(formatRate(1530), '1.5 kB/s');
  assert.equal(formatRate(98_400), '98 kB/s');
  assert.equal(formatRate(2_500_000), '2.5 MB/s');
  assert.equal(formatMhz(612), '612 MHz');
  assert.equal(formatMhz(2401), '2.4 GHz');
  assert.equal(formatWatts(6.024), '6.02 W');
  assert.equal(formatWatts(11.62), '11.6 W');
  assert.equal(formatUptime(12 * 60_000 + 59_000), '12 min');
  assert.equal(formatUptime((5 * 60 + 3) * 60_000), '5 h 3 min');
  assert.equal(formatUptime((3 * 24 + 4) * 3_600_000), '3 d 4 h');
  assert.equal(ago(400), 'now');
  assert.equal(ago(42_000), '42 s ago');
  assert.equal(ago(185_000), '3 min 5 s ago');
});

test('temperatures: hot and critical of the sensor, else of a Raspberry Pi', () => {
  assert.deepEqual(temperatureLimits(temperature('cpu-thermal', 50)), { high: 80, critical: 95 });
  // coretemp's max is its critical
  assert.deepEqual(temperatureLimits(temperature('coretemp', 50, 'Core 0', 100, 100)), { high: 80, critical: 100 });
  assert.deepEqual(temperatureLimits(temperature('cpu-thermal', 50, null, null, 110)), { high: 80, critical: 110 });
  assert.deepEqual(temperatureLimits(temperature('nvme', 50, 'Composite', 84.9, 85.9)), { high: 84.9, critical: 85.9 });
  assert.deepEqual(temperatureLimits(temperature('acpitz', 50, null, null, 105)), { high: 80, critical: 105 });
  assert.equal(temperatureTone(temperature('cpu-thermal', 79)), 'ok');
  assert.equal(temperatureTone(temperature('cpu-thermal', 82)), 'warn');
  assert.equal(temperatureTone(temperature('cpu-thermal', 95)), 'hot');
});

test('temperatures by chip, as read, each with its hottest', () => {
  const groups = temperatureGroups([
    temperature('acpitz', 28),
    temperature('coretemp', 54, 'Package id 0'),
    temperature('coretemp', 61, 'Core 4'),
    temperature('nvme', 46, 'Composite'),
    temperature('GPU', 49, 'NVIDIA GeForce RTX 4060 Laptop GPU'),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.name, group.temperatures.length, group.hottest.celsius]),
    [
      ['ACPI', 1, 28],
      ['CPU cores', 2, 61],
      ['NVMe drive', 1, 46],
      ['NVIDIA GeForce RTX 4060 Laptop GPU', 1, 49],
    ],
  );
});

test('the device’s interfaces, or those chosen; their traffic summed', () => {
  const network = (name: string, physical: boolean): NetworkIo => ({ name, received: 0, sent: 0, totalReceived: 0, totalSent: 0, up: true, physical });
  const networks = [network('eth0', true), network('wlan0', true), network('docker0', false), network('tailscale0', false)];
  assert.deepEqual(shownNetworks(networks, null).map((n) => n.name), ['eth0', 'wlan0']);
  assert.deepEqual(shownNetworks(networks, interfaceFilter('wlan0, tailscale*')).map((n) => n.name), ['wlan0', 'tailscale0']);
  const point = (at: number, networks: TrendPoint['networks']): TrendPoint => ({ at, cpu: 0, memory: 0, temperature: null, gpus: [], watts: null, networks, disks: {} });
  assert.deepEqual(sumSeries([point(1, { eth0: [100, 10], wlan0: [5, 1], docker0: [100, 100] }), point(2, {})], 'networks', ['eth0', 'wlan0']), [
    { at: 1, values: [105, 11] },
    { at: 2, values: [0, 0] },
  ]);
});

test('charts: their tops, their gaps, the point at a time', () => {
  assert.equal(niceMax(0, 10_000), 10_000);
  assert.equal(niceMax(13_000, 10_000), 20_000);
  assert.equal(niceMax(340_000, 10_000), 500_000);
  assert.equal(niceMax(0.6, 1), 1);
  assert.equal(niceMax(6.3, 1), 10);
  const points = [{ at: 0 }, { at: 1000 }, { at: 2000 }, { at: 9000 }, { at: 10_000 }];
  assert.deepEqual(segments(points).map((run) => run.length), [3, 2]);
  assert.equal(nearest(points, 1400)?.at, 1000);
  assert.equal(nearest(points, 6000)?.at, 9000);
  assert.equal(nearest(points, 99_999)?.at, 10_000);
  assert.equal(nearest([], 1), null);
});
