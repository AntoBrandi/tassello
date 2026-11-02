import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FsDisk } from '../../../shared/file_manager.ts';
import type { NetworkConnection, NetworkDevice, NetworkState, WifiNetwork } from '../../../shared/networking.ts';
import type { SystemSample } from '../../../shared/system.ts';
import {
  cpuShare,
  cpuTitle,
  diskReading,
  diskShare,
  diskShown,
  loadTone,
  signalTone,
  sparkline,
  wifiDevice,
  wifiReading,
} from './model.ts';

function device(name: string, changes: Partial<NetworkDevice> = {}): NetworkDevice {
  return {
    name,
    type: 'wifi',
    state: 100,
    stateText: 'connected',
    reason: '',
    connection: `uuid-${name}`,
    connectionName: 'Lab',
    external: false,
    software: false,
    hwaddr: '',
    mtu: 1500,
    carrier: null,
    speed: '',
    driver: '',
    vendor: '',
    product: '',
    accessPoint: true,
    band24: true,
    band5: true,
    ipv4: ['192.168.1.20/24'],
    ipv6: [],
    gateway: '192.168.1.1',
    dns: [],
    ...changes,
  };
}

function network(ssid: string, changes: Partial<WifiNetwork> = {}): WifiNetwork {
  return {
    ssid,
    device: 'wlan0',
    bssid: '',
    signal: 72,
    frequency: 5180,
    channel: 36,
    rate: '540 Mbit/s',
    securityText: 'WPA2',
    security: 'wpa-psk',
    mode: 'Infra',
    active: true,
    points: 1,
    ...changes,
  };
}

function state(changes: Partial<NetworkState & { via: string | null }> = {}): NetworkState & { via: string | null } {
  return {
    error: null,
    version: '1.46',
    state: 'connected',
    connectivity: 'full',
    wifi: true,
    wifiHardware: true,
    permissions: { control: true, modify: true, wifi: true, scan: true, share: true },
    devices: [device('wlan0')],
    connections: [{ uuid: 'uuid-wlan0', name: 'Lab', kind: 'wifi', ssid: 'Lab' } as NetworkConnection],
    networks: [network('Lab'), network('Guest', { signal: 90, active: false })],
    scanning: false,
    activity: [],
    via: null,
    ...changes,
  };
}

test('the Wi-Fi interface shown: the one named, else the one with the default route', () => {
  const devices = [
    device('eth0', { type: 'ethernet' }),
    device('wlan0', { state: 30, gateway: '' }),
    device('wlan1', { gateway: '' }),
    device('wlan2'),
  ];
  assert.equal(wifiDevice(devices, '')?.name, 'wlan2');
  assert.equal(wifiDevice(devices.slice(0, 3), '')?.name, 'wlan1');
  assert.equal(wifiDevice(devices.slice(0, 2), '')?.name, 'wlan0');
  assert.equal(wifiDevice(devices, 'wlan0')?.name, 'wlan0');
  assert.equal(wifiDevice(devices, 'eth0'), null);
});

test('the network joined, its signal against the thresholds', () => {
  const lab = wifiReading(state({ via: 'wlan0' }), '', 50, 25);
  assert.deepEqual(
    { ...lab, title: lab.title.split('\n') },
    {
      tone: 'ok',
      signal: 72,
      value: '72%',
      label: 'Lab',
      title: ['Lab · signal 72% · 5 GHz, channel 36 · 540 Mbit/s', 'wlan0: 192.168.1.20', 'This page reaches the robot through it'],
    },
  );
  const weak = (signal: number) => wifiReading(state({ networks: [network('Lab', { signal })] }), '', 50, 25).tone;
  assert.deepEqual([weak(50), weak(49), weak(25), weak(24)], ['ok', 'warn', 'warn', 'critical']);
  assert.deepEqual([signalTone(10, 50, 25), signalTone(30, 50, 25), signalTone(60, 50, 25)], ['critical', 'warn', 'ok']);
  // Not in the list (yet): the name alone
  assert.deepEqual(
    [wifiReading(state({ networks: [] }), '', 50, 25)].map(({ value, label, signal }) => ({ value, label, signal })),
    [{ value: '—', label: 'Lab', signal: null }],
  );
});

test('no network to show: why', () => {
  const reading = (s: ReturnType<typeof state> | null, name = '') => {
    const { tone, value, label } = wifiReading(s, name, 50, 25);
    return [tone, value, label];
  };
  assert.deepEqual(reading(null), ['off', '…', 'Wi-Fi']);
  assert.deepEqual(reading(state({ error: 'nmcli is not installed', devices: [] })), ['off', '—', 'No Wi-Fi']);
  assert.deepEqual(reading(state({ devices: [device('eth0', { type: 'ethernet' })] })), ['off', '—', 'No Wi-Fi']);
  assert.deepEqual(reading(state(), 'wlan9'), ['off', '—', 'wlan9']);
  assert.deepEqual(reading(state({ wifi: false })), ['off', 'Off', 'Wi-Fi off']);
  assert.deepEqual(reading(state({ devices: [device('wlan0', { state: 30, connectionName: '' })] })), ['critical', '—', 'Not connected']);
  assert.deepEqual(reading(state({ devices: [device('wlan0', { state: 70, stateText: 'connecting (getting IP configuration)' })] })), [
    'warn',
    '…',
    'Lab',
  ]);
  // The robot's own access point: no signal of its own
  const hotspot = state({ connections: [{ uuid: 'uuid-wlan0', name: 'Hotspot', kind: 'hotspot', ssid: 'Robot' } as NetworkConnection] });
  assert.deepEqual(reading(hotspot), ['ok', 'AP', 'Robot']);
});

function sample(cpu: number, cores: (number | null)[]): SystemSample {
  return {
    at: 0,
    cpu,
    cores,
    mhz: cores.map(() => null),
    load: [0.5, 0.61, 0.7],
    memory: { total: 0, used: 0, cached: 0, swapTotal: 0, swapUsed: 0 },
    temperatures: [],
    fans: [],
    throttled: null,
    gpus: [],
    power: [],
    disks: [],
    networks: [],
  };
}

test('the CPU load: of all the cores or the busiest, against the thresholds', () => {
  const busy = sample(0.3, [0.1, 0.95, null, 0.15]);
  assert.equal(cpuShare(busy, 'all'), 0.3);
  assert.equal(cpuShare(busy, 'busiest'), 0.95);
  assert.equal(cpuShare(sample(0, [null]), 'busiest'), 0);
  assert.deepEqual([0.5, 0.75, 0.9].map((share) => loadTone(share, 75, 90)), ['ok', 'warn', 'critical']);
  assert.equal(
    cpuTitle(busy, 'Cortex-A76'),
    'CPU 30% of 3 cores · busiest: core 1 at 95% · load 0.50 0.61 0.70\nCortex-A76',
  );
  assert.equal(cpuTitle(sample(0.2, [0.2]), null), 'CPU 20% of 1 core · load 0.50 0.61 0.70');
});

test('sparklines span the last minute, with gaps where sampling stopped', () => {
  const points = [
    { at: -1000, value: 1 },
    { at: 0, value: 0 },
    { at: 1000, value: 1 },
    { at: 2000, value: 0.5 },
    { at: 8000, value: 2 },
  ];
  // From the point before it, so that the line comes in from the left edge
  assert.equal(sparkline(points, 10_000, 10_000, 100, 20), 'M-10.0 0.0L0.0 20.0L10.0 0.0L20.0 10.0M80.0 0.0');
  assert.equal(sparkline(points, 15_000, 10_000, 100, 20), 'M-30.0 10.0M30.0 0.0');
  assert.equal(sparkline([], 10_000, 10_000, 100, 20), '');
});

const GB = 1e9;

function disk(mount: string, used: number, free: number, changes: Partial<FsDisk> = {}): FsDisk {
  return {
    mount,
    device: '/dev/nvme0n1p2',
    type: 'ext4',
    readOnly: false,
    // 5 % kept for root
    total: (used + free) * 1.05,
    used,
    free,
    inodes: { total: 1_000_000, free: 900_000 },
    ...changes,
  };
}

test('the disk shown: the one mounted there, else the fullest of those written to', () => {
  const disks = [
    disk('/', 60 * GB, 40 * GB),
    disk('/data', 450 * GB, 50 * GB),
    disk('/media/iso', 4 * GB, 0, { readOnly: true }),
    // Out of inodes, though not of space
    disk('/var/log', 1 * GB, 9 * GB, { inodes: { total: 1000, free: 20 } }),
  ];
  assert.equal(diskShare(disks[1]), 0.9);
  assert.equal(diskShare(disk('/', 0, 0)), 0);
  assert.equal(diskShown(disks, '/')?.mount, '/');
  assert.equal(diskShown(disks, '/media/iso')?.mount, '/media/iso');
  assert.equal(diskShown(disks, '/mnt'), null);
  assert.equal(diskShown(disks, '')?.mount, '/var/log');
  assert.equal(diskShown(disks.slice(0, 3), '')?.mount, '/data');
  assert.equal(diskShown([disks[2]], '')?.mount, '/media/iso');
  assert.equal(diskShown([], ''), null);
});

test('a disk\'s use against the thresholds, of its space or of its inodes', () => {
  const data = disk('/data', 450 * GB, 50 * GB, { device: '/dev/sda1' });
  const reading = diskReading([data], null, '/data', 'used', 85, 95);
  assert.deepEqual(
    { ...reading, title: reading.title.split('\n') },
    {
      tone: 'warn',
      share: 0.9,
      value: '90%',
      label: '/data',
      title: ['/data: 50.0 GB free of 525 GB · 450 GB used, 90%', '/dev/sda1 · ext4'],
    },
  );
  assert.equal(diskReading([data], null, '/data', 'free', 85, 95).value, '50.0 GB');
  const tone = (used: number) => diskReading([disk('/', used, 100 - used)], null, '', 'used', 85, 95).tone;
  assert.deepEqual([tone(84), tone(85), tone(94), tone(95)], ['ok', 'warn', 'warn', 'critical']);
  // Its inodes running short: said, and coloured so
  const logs = diskReading([disk('/var/log', 1 * GB, 9 * GB, { inodes: { total: 1000, free: 20 }, readOnly: true })], null, '/var/log', 'used', 85, 95);
  assert.deepEqual(
    [logs.tone, logs.value, logs.title.split('\n').slice(1)],
    ['critical', '10%', ['/dev/nvme0n1p2 · ext4 · read-only', '98% of its inodes used: 20 files more at most']],
  );
});

test('the fullest disk, with the others in its details', () => {
  const reading = diskReading([disk('/', 60 * GB, 40 * GB), disk('/data', 450 * GB, 50 * GB)], null, '', 'used', 85, 95);
  assert.deepEqual(reading.title.split('\n').slice(2), ['The fullest of 2 disks; the others:', '/: 40.0 GB free, 60% used']);
  assert.equal(reading.label, '/data');
});

test('no disk to show: why', () => {
  const reading = (disks: FsDisk[] | null, error: string | null, mount = '') => {
    const { tone, value, label, title, share } = diskReading(disks, error, mount, 'used', 85, 95);
    return [tone, value, label, title, share];
  };
  assert.deepEqual(reading(null, null), ['off', '…', 'Disk', 'Reading the robot’s disks…', null]);
  assert.deepEqual(reading(null, 'Failed to fetch', '/data'), ['off', '—', '/data', 'Failed to fetch', null]);
  assert.deepEqual(reading([], null), ['off', '—', 'No disk', 'The robot’s file systems could not be read', null]);
  assert.deepEqual(reading([disk('/', 1, 1)], null, '/media/usb'), ['off', '—', '/media/usb', 'No disk is mounted at /media/usb', null]);
  // Read before: kept
  assert.equal(reading([disk('/', 1, 1)], 'Failed to fetch')[1], '50%');
});
