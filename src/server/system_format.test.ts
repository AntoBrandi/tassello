import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mainRail, throttlingFlags, trendPoint, type SystemSample } from '../shared/system.ts';
import {
  busyShare,
  celsius,
  cpuCount,
  cpuinfoMhz,
  cpuModel,
  energyWatts,
  isTemperatureZone,
  mergeTemperatures,
  modelName,
  parseCpuTimes,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseNvidiaSmi,
  parseNvpmodel,
  parseOsRelease,
  parseTegraRelease,
  parseThrottled,
  raplName,
  rate,
  wholeDisk,
  zoneLimits,
} from './system_format.ts';

test('the cores’ busy shares between two readings of /proc/stat, offline ones missing', () => {
  const before = parseCpuTimes('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 60 0 20 400 20 0 0 0 0 0\ncpu2 40 0 30 400 30 0 0 0 0 0\nintr 1 2 3\n');
  const after = parseCpuTimes('cpu  200 0 100 1000 100 0 0 0 0 0\ncpu0 150 0 30 410 20 0 0 0 0 0\ncpu2 50 0 70 590 80 0 0 0 0 0\n');
  assert.deepEqual(after.all, { busy: 300, total: 1400 });
  assert.deepEqual([...after.cores.keys()], [0, 2]);
  // 150 busy of 400; iowait is idle
  assert.equal(busyShare(before.all, after.all), 0.375);
  assert.equal(busyShare(before.cores.get(0), after.cores.get(0)), 100 / 110);
  assert.equal(busyShare(before.cores.get(1), after.cores.get(1)), null);
  assert.equal(busyShare(after.all, after.all), 0);
  assert.equal(cpuCount('0-3,6\n'), 5);
  assert.equal(cpuCount('0\n'), 1);
});

test('memory: used is what is not available, cached as free counts it', () => {
  const memory = parseMeminfo(
    'MemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:    9000000 kB\nBuffers:          500000 kB\nCached:          6000000 kB\nSwapCached:            0 kB\nSReclaimable:     400000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\nHugePages_Total:       0\n',
  );
  assert.deepEqual(memory, {
    total: 16_000_000 * 1024,
    used: 7_000_000 * 1024,
    cached: 6_900_000 * 1024,
    swapTotal: 2_000_000 * 1024,
    swapUsed: 500_000 * 1024,
  });
  // Before Linux 3.14
  assert.equal(parseMeminfo('MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 300 kB\n').used, 400 * 1024);
  assert.deepEqual(parseLoadavg('0.77 0.84 1.02 3/2619 164734\n'), [0.77, 0.84, 1.02]);
});

test('network and disk counters, and their rates', () => {
  const net = parseNetDev(
    'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 1693 114    0    0    0     0          0         0 1693 114    0    0    0     0       0          0\n  wlan0:5925988304 4817944    0    3    0     0          0         0 459317117 2376558    0    0    0     0       0          0\n',
  );
  assert.deepEqual(net.get('wlan0'), { received: 5925988304, sent: 459317117 });
  assert.equal(net.size, 2);
  const disks = parseDiskstats(
    ' 259       0 nvme0n1 557992 232706 31084746 129745 506041 377375 28285218 1005660 0 125979 1146575 0 0 0 0 22343 11169\n 179       0 mmcblk0 100 0 2048 50 10 0 64 5 0 40 55\n',
  );
  assert.deepEqual(disks.get('nvme0n1'), { read: 31084746 * 512, written: 28285218 * 512, busyMs: 125979 });
  assert.deepEqual(disks.get('mmcblk0'), { read: 2048 * 512, written: 64 * 512, busyMs: 40 });
  assert.deepEqual(['nvme0n1', 'sda', 'mmcblk0', 'loop3', 'zram0', 'dm-0', 'md127', 'mmcblk0boot0', 'mmcblk0rpmb', 'sr0'].filter(wholeDisk), ['nvme0n1', 'sda', 'mmcblk0']);
  assert.equal(rate(1000, 3000, 2), 1000);
  assert.equal(rate(undefined, 3000, 1), 0);
  // The interface was made again
  assert.equal(rate(5000, 10, 1), 0);
  assert.equal(energyWatts(1_000_000, 6_000_000, 2 ** 32, 1), 5);
  assert.equal(energyWatts(2 ** 32 - 1_000_000, 1_000_000, 2 ** 32, 2), 1);
  assert.equal(energyWatts(undefined, 1, 2 ** 32, 1), null);
});

test('a Raspberry Pi’s throttling, of vcgencmd or of the firmware’s file', () => {
  assert.equal(parseThrottled('throttled=0x50005\n'), 0x50005);
  assert.equal(parseThrottled('50005\n'), 0x50005);
  assert.equal(parseThrottled('0\n'), 0);
  assert.equal(parseThrottled('error\n'), null);
  const flags = throttlingFlags(0x50005);
  assert.deepEqual(
    flags.map(({ label, now, occurred }) => [label, now, occurred]),
    [
      ['Under-voltage', true, true],
      ['Frequency capped', false, false],
      ['Throttled', true, true],
      ['Soft temperature limit', false, false],
    ],
  );
});

test('nvidia-smi’s GPUs, with what they do not know', () => {
  const gpus = parseNvidiaSmi('38, 1190, 8188, 48, 3.73, 360, NVIDIA GeForce RTX 4060 Laptop GPU\n[N/A], [N/A], [N/A], 61, [Not Supported], 1410, Tesla T4, rev 2\n');
  assert.deepEqual(gpus[0], {
    name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    load: 0.38,
    memoryUsed: 1190 * 1024 * 1024,
    memoryTotal: 8188 * 1024 * 1024,
    celsius: 48,
    watts: 3.73,
    mhz: 360,
  });
  assert.deepEqual(gpus[1], { name: 'Tesla T4, rev 2', load: null, memoryUsed: null, memoryTotal: null, celsius: 61, watts: null, mhz: 1410 });
  assert.deepEqual(parseNvidiaSmi('No devices were found\n'), []);
});

test('the system’s description: OS, L4T, power mode, processor, board', () => {
  assert.equal(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.5 LTS"\nID=ubuntu\n'), 'Ubuntu 22.04.5 LTS');
  assert.equal(parseOsRelease('PRETTY_NAME=Debian\n'), 'Debian');
  assert.equal(parseTegraRelease('# R36 (release), REVISION: 4.3, GCID: 38968081, BOARD: generic, EABI: aarch64, DATE: Wed Jan  8 01:49:37 UTC 2025\n'), 'R36.4.3');
  assert.equal(parseNvpmodel('NV Power Mode: 15W\n0\n'), '15W');
  assert.equal(cpuModel('processor\t: 0\nmodel name\t: 13th Gen Intel(R) Core(TM)  i7-13700H\n'), '13th Gen Intel(R) Core(TM) i7-13700H');
  const rk3588 = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((core) => `processor\t: ${core}\nCPU implementer\t: 0x41\nCPU part\t: ${core < 4 ? '0xd05' : '0xd0b'}\n`)
    .join('\n');
  assert.equal(cpuModel(rk3588), 'Cortex-A76 + Cortex-A55');
  assert.equal(cpuModel('processor\t: 0\nCPU implementer\t: 0x41\nCPU part\t: 0xd08\nModel\t: Raspberry Pi 4 Model B Rev 1.4\n'), 'Cortex-A72');
  assert.equal(cpuModel('processor : 0\n'), null);
  assert.deepEqual(cpuinfoMhz('cpu MHz\t\t: 2400.000\ncpu MHz\t\t: 3669.158\n'), [2400, 3669.158]);
  assert.equal(modelName('Raspberry Pi 5 Model B Rev 1.0\0', 'x', 'y'), 'Raspberry Pi 5 Model B Rev 1.0');
  assert.equal(modelName(null, 'HP\n', 'Victus by HP Gaming Laptop 16-r0xxx\n'), 'HP Victus by HP Gaming Laptop 16-r0xxx');
  assert.equal(modelName(null, 'Intel Corporation', 'Intel NUC'), 'Intel Corporation Intel NUC');
  assert.equal(modelName(null, 'LENOVO', 'LENOVO ThinkPad'), 'LENOVO ThinkPad');
  assert.equal(modelName(null, 'To Be Filled By O.E.M.', 'To Be Filled By O.E.M.'), null);
  assert.equal(modelName(null, 'System manufacturer', 'Jetson AGX'), 'Jetson AGX');
});

test('temperatures: plausible readings, limits, and chips that are thermal zones once', () => {
  assert.equal(celsius(54050), 54.1);
  assert.equal(celsius(-273150), null);
  assert.equal(celsius(null), null);
  assert.deepEqual(
    zoneLimits([
      { type: 'active', celsius: 50 },
      { type: 'passive', celsius: 97 },
      { type: 'passive', celsius: 90 },
      { type: 'critical', celsius: 105 },
    ]),
    { high: 90, critical: 105 },
  );
  assert.equal(isTemperatureZone('PMIC-Die'), false);
  assert.equal(isTemperatureZone('cpu-thermal'), true);
  const zone = (sensor: string) => ({ sensor, label: null, celsius: 50, high: null, critical: null });
  assert.deepEqual(
    mergeTemperatures([zone('cpu-thermal'), zone('acpitz')], [zone('cpu_thermal'), zone('acpitz'), zone('nvme')]).map((t) => t.sensor),
    ['cpu-thermal', 'acpitz', 'nvme'],
  );
  assert.equal(raplName('package-0'), 'CPU package');
  assert.equal(raplName('package-1'), 'CPU package 1');
  assert.equal(raplName('dram'), 'Memory');
});

test('what the charts keep of a sample: the hottest, the main rail, rates by name', () => {
  const rail = (name: string, watts: number) => ({ name, watts, volts: null, amps: null });
  assert.equal(mainRail([rail('VDD_CPU_GPU_CV', 2), rail('VDD_IN', 7), rail('VDD_SOC', 1)])?.name, 'VDD_IN');
  assert.equal(mainRail([rail('CPU cores', 3), rail('CPU package', 9)])?.name, 'CPU package');
  assert.equal(mainRail([rail('amdgpu PPT', 20)])?.name, 'amdgpu PPT');
  assert.equal(mainRail([rail('a', 1), rail('b', 2)]), null);
  const sample: SystemSample = {
    at: 1000,
    cpu: 0.5,
    cores: [0.5, null],
    mhz: [1500, null],
    load: [1, 1, 1],
    memory: { total: 100, used: 40, cached: 30, swapTotal: 0, swapUsed: 0 },
    temperatures: [
      { sensor: 'cpu-thermal', label: null, celsius: 61, high: null, critical: null },
      { sensor: 'nvme', label: 'Composite', celsius: 44, high: null, critical: null },
    ],
    fans: [],
    throttled: null,
    gpus: [{ name: 'GPU', load: 0.25, mhz: null, memoryUsed: null, memoryTotal: null, celsius: null, watts: null }],
    power: [rail('VDD_IN', 6.5)],
    disks: [{ name: 'mmcblk0', read: 10, written: 20, busy: 0.1 }],
    networks: [{ name: 'wlan0', received: 300, sent: 40, totalReceived: 0, totalSent: 0, up: true, physical: true }],
  };
  assert.deepEqual(trendPoint(sample), {
    at: 1000,
    cpu: 0.5,
    memory: 40,
    temperature: 61,
    gpus: [0.25],
    watts: 6.5,
    networks: { wlan0: [300, 40] },
    disks: { mmcblk0: [10, 20] },
  });
});
