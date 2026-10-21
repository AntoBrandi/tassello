import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultSettings,
  type NetworkActivity,
  type NetworkConnection,
  type NetworkDevice,
  type WifiNetwork,
} from '../../../shared/networking.ts';
import {
  activityFor,
  bandOf,
  cutsOff,
  deviceStatus,
  interfaceFilter,
  lastUsedText,
  networkRows,
  savedFor,
  savedGroups,
  shownDevices,
  signalLevel,
  summary,
  uniqueName,
  type PageState,
} from './model.ts';

function device(name: string, changes: Partial<NetworkDevice> = {}): NetworkDevice {
  return {
    name,
    type: 'wifi',
    state: 30,
    stateText: 'disconnected',
    reason: '',
    connection: null,
    connectionName: '',
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
    ipv4: [],
    ipv6: [],
    gateway: '',
    dns: [],
    ...changes,
  };
}

function saved(name: string, changes: Partial<NetworkConnection> = {}): NetworkConnection {
  return {
    uuid: `00000000-0000-0000-0000-${name.padStart(12, '0').slice(-12).replace(/[^0-9a-f]/gi, '0')}`,
    name,
    type: '802-11-wireless',
    kind: 'wifi',
    interface: '',
    autoconnect: true,
    priority: 0,
    lastUsed: null,
    readOnly: false,
    file: '',
    device: null,
    activeState: null,
    external: false,
    ssid: name,
    security: 'wpa-psk',
    hidden: false,
    band: '',
    channel: 0,
    identity: '',
    vpnService: '',
    ipv4Method: 'auto',
    addresses: [],
    gateway: '',
    dns: [],
    ...changes,
  };
}

function network(ssid: string, changes: Partial<WifiNetwork> = {}): WifiNetwork {
  return {
    ssid,
    device: 'wlan0',
    bssid: '',
    signal: 50,
    frequency: 2412,
    channel: 1,
    rate: '',
    securityText: 'WPA2',
    security: 'wpa-psk',
    mode: 'Infra',
    active: false,
    points: 1,
    ...changes,
  };
}

function page(changes: Partial<PageState> = {}): PageState {
  return {
    error: null,
    version: '1.46.0',
    state: 'connected',
    connectivity: 'full',
    wifi: true,
    wifiHardware: true,
    permissions: { control: true, modify: true, wifi: true, scan: true, share: true },
    devices: [],
    connections: [],
    networks: [],
    scanning: false,
    activity: [],
    via: null,
    canChange: true,
    ...changes,
  };
}

function activity(changes: Partial<NetworkActivity>): NetworkActivity {
  return {
    id: 1,
    action: 'connect',
    label: 'Connecting to Lab',
    uuid: null,
    ssid: null,
    device: null,
    started: 0,
    finished: null,
    error: null,
    ...changes,
  };
}

test('signals, bands and interface filters', () => {
  assert.deepEqual([0, 29, 30, 50, 69, 70, 100].map(signalLevel), [1, 1, 2, 3, 3, 4, 4]);
  assert.deepEqual([0, 2412, 5180, 5955].map(bandOf), ['', '2.4 GHz', '5 GHz', '6 GHz']);
  const filter = interfaceFilter('wlan0, eth*');
  assert.ok(filter('wlan0') && filter('eth1') && !filter('wlan1') && !filter('veth0'));
  assert.ok(interfaceFilter(' ')('anything'));
});

test('the robot’s own interfaces, not those of other programs', () => {
  const devices = [
    device('wlan0'),
    device('eth0', { type: 'ethernet' }),
    device('docker0', { type: 'bridge', external: true, software: true, state: 100 }),
    device('lo', { type: 'loopback', state: 10 }),
    device('p2p-dev-wlan0', { type: 'wifi-p2p' }),
    device('veth1', { type: 'veth', software: true, state: 10 }),
  ];
  const names = (list: NetworkDevice[]) => list.map((d) => d.name);
  assert.deepEqual(names(shownDevices(devices, () => true, false)), ['wlan0', 'eth0']);
  assert.equal(shownDevices(devices, () => true, true).length, 6);
  assert.deepEqual(names(shownDevices(devices, interfaceFilter('eth*'), false)), ['eth0']);
});

test('the states of the interfaces in words', () => {
  assert.deepEqual(deviceStatus(device('wlan0', { state: 100, connectionName: 'Lab' }), true), {
    text: 'Connected to Lab',
    tone: 'on',
  });
  assert.equal(deviceStatus(device('wlan0', { state: 70, stateText: 'connecting (getting IP configuration)' }), true).text, 'Getting an address…');
  assert.equal(deviceStatus(device('wlan0', { state: 60, stateText: 'connecting (need authentication)' }), true).tone, 'busy');
  assert.equal(deviceStatus(device('eth0', { type: 'ethernet', state: 20, carrier: false }), true).text, 'Cable unplugged');
  assert.equal(deviceStatus(device('wlan0', { state: 20 }), false).text, 'Wi-Fi is off');
  assert.deepEqual(deviceStatus(device('wlan0', { state: 120, reason: 'Supplicant timed out' }), true), {
    text: 'Failed: Supplicant timed out',
    tone: 'failed',
  });
  assert.equal(deviceStatus(device('docker0', { state: 100, external: true }), true).text, 'Configured by another program');
});

test('saved connections by kind, the active then the latest used first', () => {
  const connections = [
    saved('Old', { lastUsed: 1000 }),
    saved('Recent', { lastUsed: 5000 }),
    saved('Here', { device: 'wlan0', activeState: 'activated', lastUsed: 10 }),
    saved('Robot', { kind: 'hotspot', interface: 'wlan0' }),
    saved('lidar', { kind: 'ethernet', type: '802-3-ethernet', interface: 'eth1' }),
    saved('docker0', { kind: 'other', type: 'bridge', external: true, device: 'docker0', activeState: 'activated' }),
  ];
  const devices = [device('wlan0'), device('eth0', { type: 'ethernet' })];
  const groups = savedGroups(connections, devices, '', false);
  assert.deepEqual(
    groups.map((g) => [g.kind, g.connections.map((c) => c.name)]),
    [
      ['wifi', ['Here', 'Recent', 'Old']],
      ['hotspot', ['Robot']],
    ],
  );
  // eth1's is not of the interfaces shown; docker0's is another program's
  const all = savedGroups(connections, [...devices, device('eth1', { type: 'ethernet' })], '', true);
  assert.deepEqual(all.map((g) => g.kind), ['wifi', 'hotspot', 'ethernet']);
  assert.deepEqual(savedGroups(connections, devices, 'rec', false)[0].connections.map((c) => c.name), ['Recent']);
});

test('the networks in range, with what is saved of them', () => {
  const connections = [
    saved('Lab', { lastUsed: 100 }),
    saved('Lab 2', { ssid: 'Lab', lastUsed: 200 }),
    saved('Elsewhere', { ssid: 'Lab', interface: 'wlan1', lastUsed: 300 }),
    saved('Office'),
  ];
  assert.equal(savedFor(connections, 'Lab', 'wlan0')?.name, 'Lab 2');
  assert.equal(savedFor(connections, 'Lab', 'wlan1')?.name, 'Elsewhere');
  assert.equal(savedFor(connections, 'Guest', 'wlan0'), null);

  const state = page({
    connections,
    networks: [
      network('Guest', { signal: 90 }),
      network('Office', { signal: 20 }),
      network('Lab', { signal: 40, active: true }),
      network('Far', { signal: 60, device: 'wlan1' }),
    ],
  });
  assert.deepEqual(
    networkRows(state, 'wlan0', '').map((row) => [row.network.ssid, row.saved?.name ?? null]),
    [
      ['Lab', 'Lab 2'],
      ['Office', 'Office'],
      ['Guest', null],
    ],
  );
  assert.deepEqual(networkRows(state, 'wlan0', 'gue').map((row) => row.network.ssid), ['Guest']);
});

test('what is done to a connection, and what failed lately', () => {
  const now = 1_000_000;
  const lab = { uuid: 'u1', ssid: 'Lab', device: 'wlan0' };
  const running = activity({ id: 3, uuid: 'u1' });
  assert.equal(activityFor([running], lab, now).running, running);

  const failed = activity({ id: 2, ssid: 'Lab', device: 'wlan0', finished: now - 1000, error: 'Wrong password' });
  assert.equal(activityFor([failed], lab, now).failed, failed);
  assert.equal(activityFor([failed], { ssid: 'Lab', device: 'wlan1' }, now).failed, null);
  // Old, or done again since
  assert.equal(activityFor([failed], lab, now + 200_000).failed, null);
  const since = activity({ id: 4, uuid: 'u1', finished: now - 10 });
  assert.equal(activityFor([since, failed], lab, now).failed, null);
});

test('the changes that cut the page off from the robot', () => {
  const lab = saved('Lab', { device: 'wlan0', activeState: 'activated' });
  const office = saved('Office');
  const robot = saved('Robot', { kind: 'hotspot', interface: 'wlan0' });
  const cable = saved('lidar', { kind: 'ethernet', interface: 'eth0' });
  const state = page({
    via: 'wlan0',
    devices: [device('wlan0', { state: 100, connection: lab.uuid }), device('eth0', { type: 'ethernet' })],
    connections: [lab, office, robot, cable],
  });
  assert.match(cutsOff(state, { action: 'connect', uuid: office.uuid, device: null, password: null }) ?? '', /moves the robot to that network/);
  assert.match(cutsOff(state, { action: 'connect', uuid: robot.uuid, device: null, password: null }) ?? '', /Join Robot/);
  // Already connected; another interface
  assert.equal(cutsOff(state, { action: 'connect', uuid: lab.uuid, device: null, password: null }), null);
  assert.equal(cutsOff(state, { action: 'connect', uuid: cable.uuid, device: null, password: null }), null);
  assert.equal(cutsOff(state, { action: 'connect', uuid: office.uuid, device: 'wlan1', password: null }), null);
  assert.match(cutsOff(state, { action: 'disconnect', uuid: lab.uuid }) ?? '', /cuts this page off/);
  assert.equal(cutsOff(state, { action: 'disconnect', uuid: cable.uuid }), null);
  assert.match(cutsOff(state, { action: 'delete', uuid: lab.uuid }) ?? '', /forgetting Lab/);
  assert.match(cutsOff(state, { action: 'wifi', enabled: false }) ?? '', /turning Wi-Fi off/);
  assert.equal(cutsOff(state, { action: 'wifi', enabled: true }), null);
  const join = { ...defaultSettings('wifi'), name: 'Guest', ssid: 'Guest', password: 'secret123' };
  assert.match(cutsOff(state, { action: 'create', settings: join, connect: true, device: null }) ?? '', /Guest/);
  assert.equal(cutsOff(state, { action: 'create', settings: join, connect: false, device: null }), null);
  // Through a cable, or from the robot itself
  assert.equal(cutsOff({ ...state, via: 'eth0' }, { action: 'connect', uuid: office.uuid, device: null, password: null }), null);
  assert.equal(cutsOff({ ...state, via: null }, { action: 'wifi', enabled: false }), null);
});

test('names, times and the status line', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  assert.equal(lastUsedText(null, now), 'Never used');
  assert.equal(lastUsedText(now - 30_000, now), 'Used just now');
  assert.equal(lastUsedText(now - 5 * 60_000, now), 'Used 5 min ago');
  assert.equal(lastUsedText(now - 3 * 3600_000, now), 'Used 3 h ago');
  assert.equal(lastUsedText(now - 86400_000, now), 'Used 1 day ago');

  const connections = [saved('Lab'), saved('Lab (2)')];
  assert.equal(uniqueName('Guest', connections), 'Guest');
  assert.equal(uniqueName('Lab', connections), 'Lab (3)');

  const state = page({
    via: 'eth0',
    devices: [device('wlan0', { state: 100, connectionName: 'Lab', ipv4: ['192.168.1.20/24'], gateway: '192.168.1.1' })],
  });
  assert.deepEqual(summary(state, now), { text: 'Online · wlan0: Lab (192.168.1.20) · this page through eth0', tone: 'on' });
  assert.equal(summary({ ...state, connectivity: 'limited' }, now).tone, 'warn');
  assert.deepEqual(summary({ ...state, activity: [activity({})] }, now), { text: 'Connecting to Lab…', tone: 'busy' });
  const failed = activity({ finished: now - 1000, error: 'Wrong password, or none given' });
  assert.equal(summary({ ...state, activity: [failed] }, now).text, 'Connecting to Lab: Wrong password, or none given');
  assert.deepEqual(summary({ ...state, error: 'NetworkManager is not running' }, now), {
    text: 'NetworkManager is not running',
    tone: 'failed',
  });
});
