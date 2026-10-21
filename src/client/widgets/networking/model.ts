// What the Networking widget shows, worked out from the network updates:
// which interfaces and connections, in which order, how they are doing, what
// is being done to them, and which changes would cut the page off from the
// robot. Kept apart from the components, to be tested.

import {
  DEVICE_ACTIVATED,
  DEVICE_DEACTIVATING,
  DEVICE_DISCONNECTED,
  DEVICE_FAILED,
  DEVICE_UNAVAILABLE,
  DEVICE_UNMANAGED,
  defaultSettings,
  type ConnectionKind,
  type NetworkActivity,
  type NetworkConnection,
  type NetworkDevice,
  type NetworkRequest,
  type NetworkSettings,
  type NetworkState,
  type WifiNetwork,
} from '../../../shared/networking.ts';

export type View = 'wifi' | 'saved' | 'devices';

// The colour of a state: see .net-dot in styles.css
export type Tone = 'on' | 'busy' | 'off' | 'warn' | 'failed';

// A failure is shown on its row that long
export const FAILURE_SHOWN_MS = 120_000;

// What the state says of the page: through which interface it reaches the
// robot
export interface PageState extends NetworkState {
  via: string | null;
  canChange: boolean;
}

// Arcs of the Wi-Fi icon lit: 1 to 4
export function signalLevel(signal: number): number {
  return signal >= 70 ? 4 : signal >= 50 ? 3 : signal >= 30 ? 2 : 1;
}

export function bandOf(frequency: number): string {
  if (frequency <= 0) {
    return '';
  }
  return frequency < 3000 ? '2.4 GHz' : frequency < 5925 ? '5 GHz' : '6 GHz';
}

// The widget's interfaces: names or globs, separated by commas or spaces;
// all if none
export function interfaceFilter(text: string): (name: string) => boolean {
  const patterns = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`));
  return patterns.length === 0 ? () => true : (name) => patterns.some((pattern) => pattern.test(name));
}

// The robot's own interfaces: not the loopback, Wi-Fi P2P, nor those other
// programs make and configure (docker's bridges, VPN clients' tunnels),
// unless all
export function shownDevices(devices: NetworkDevice[], filter: (name: string) => boolean, all: boolean): NetworkDevice[] {
  return devices.filter(
    (device) =>
      filter(device.name) &&
      (all ||
        (device.type !== 'loopback' &&
          device.type !== 'wifi-p2p' &&
          !device.external &&
          !(device.software && device.state === DEVICE_UNMANAGED))),
  );
}

const CONNECTING: [RegExp, string][] = [
  [/need auth/, 'Waiting for the password…'],
  [/getting IP/i, 'Getting an address…'],
  [/checking IP/i, 'Checking the connection…'],
];

// In words, and its colour
export function deviceStatus(device: NetworkDevice, wifiOn: boolean): { text: string; tone: Tone } {
  const { state } = device;
  if (state === DEVICE_ACTIVATED) {
    if (device.external) {
      return { text: 'Configured by another program', tone: 'on' };
    }
    return { text: device.connectionName ? `Connected to ${device.connectionName}` : 'Connected', tone: 'on' };
  }
  if (state > DEVICE_DISCONNECTED && state < DEVICE_ACTIVATED) {
    const known = CONNECTING.find(([pattern]) => pattern.test(device.stateText));
    return { text: known ? known[1] : 'Connecting…', tone: 'busy' };
  }
  if (state === DEVICE_DEACTIVATING) {
    return { text: 'Disconnecting…', tone: 'busy' };
  }
  if (state === DEVICE_FAILED) {
    return { text: device.reason ? `Failed: ${device.reason}` : 'Failed', tone: 'failed' };
  }
  if (state === DEVICE_UNAVAILABLE) {
    if (device.carrier === false) {
      return { text: 'Cable unplugged', tone: 'off' };
    }
    if (device.type === 'wifi' && !wifiOn) {
      return { text: 'Wi-Fi is off', tone: 'off' };
    }
    return { text: 'Unavailable', tone: 'off' };
  }
  if (state === DEVICE_UNMANAGED) {
    return { text: 'Not managed by NetworkManager', tone: 'off' };
  }
  return { text: 'Disconnected', tone: 'off' };
}

export function deviceKindLabel(device: NetworkDevice): string {
  switch (device.type) {
    case 'wifi':
      return 'Wi-Fi';
    case 'ethernet':
      return 'Ethernet';
    case 'gsm':
    case 'cdma':
      return 'Mobile broadband';
    case 'bt':
      return 'Bluetooth';
    case 'loopback':
      return 'Loopback';
    default:
      return device.type.charAt(0).toUpperCase() + device.type.slice(1);
  }
}

const VPN_NAMES: Record<string, string> = {
  openvpn: 'OpenVPN',
  vpnc: 'Cisco VPN',
  openconnect: 'OpenConnect',
  l2tp: 'L2TP',
  pptp: 'PPTP',
  strongswan: 'IPsec',
  libreswan: 'IPsec',
  fortisslvpn: 'Fortinet',
};

export function connectionKindLabel(connection: NetworkConnection): string {
  switch (connection.kind) {
    case 'wifi':
      return 'Wi-Fi network';
    case 'hotspot':
      return 'Access point';
    case 'ethernet':
      return 'Wired';
    case 'vpn':
      return connection.type === 'wireguard'
        ? 'WireGuard'
        : `VPN${connection.vpnService ? ` (${VPN_NAMES[connection.vpnService] ?? connection.vpnService})` : ''}`;
    default:
      return connection.type;
  }
}

export interface ConnectionGroup {
  kind: ConnectionKind;
  title: string;
  connections: NetworkConnection[];
}

const GROUPS: { kind: ConnectionKind; title: string }[] = [
  { kind: 'wifi', title: 'Wi-Fi networks' },
  { kind: 'hotspot', title: 'Access points' },
  { kind: 'ethernet', title: 'Wired' },
  { kind: 'vpn', title: 'VPN' },
  { kind: 'other', title: 'Other' },
];

// The active first, then the latest used
export function byUse(a: NetworkConnection, b: NetworkConnection): number {
  return (
    Number(b.activeState !== null) - Number(a.activeState !== null) ||
    (b.lastUsed ?? 0) - (a.lastUsed ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

function matches(connection: NetworkConnection, text: string): boolean {
  const term = text.trim().toLowerCase();
  return (
    !term ||
    [connection.name, connection.ssid, connection.interface, connection.device ?? ''].some((value) =>
      value.toLowerCase().includes(term),
    )
  );
}

// Of the interfaces shown: those bound to them or active on them, and those
// bound to none of a kind they have
export function forDevices(connection: NetworkConnection, devices: NetworkDevice[]): boolean {
  if (connection.device) {
    return devices.some((device) => device.name === connection.device);
  }
  if (connection.interface) {
    return devices.some((device) => device.name === connection.interface);
  }
  const type = connection.kind === 'wifi' || connection.kind === 'hotspot' ? 'wifi' : connection.kind === 'ethernet' ? 'ethernet' : null;
  return type === null || devices.some((device) => device.type === type);
}

// The saved connections, by kind: not those NetworkManager made for another
// program's interfaces, unless all
export function savedGroups(
  connections: NetworkConnection[],
  devices: NetworkDevice[],
  text: string,
  all: boolean,
): ConnectionGroup[] {
  const kept = connections.filter(
    (connection) => (all || !connection.external) && forDevices(connection, devices) && matches(connection, text),
  );
  return GROUPS.map(({ kind, title }) => ({
    kind,
    title,
    connections: kept.filter((connection) => connection.kind === kind).sort(byUse),
  })).filter((group) => group.connections.length > 0);
}

// The connection saved for a network in range: the one active on the
// device, else the latest used of those that may be
export function savedFor(connections: NetworkConnection[], ssid: string, device: string): NetworkConnection | null {
  const candidates = connections
    .filter((c) => c.kind === 'wifi' && c.ssid === ssid && (!c.interface || c.interface === device))
    .sort(byUse);
  return candidates.find((c) => c.device === device) ?? candidates.find((c) => c.device === null) ?? null;
}

export interface NetworkRow {
  network: WifiNetwork;
  saved: NetworkConnection | null;
}

// The networks in range of a device, the one connected to first, then the
// saved ones, then by signal
export function networkRows(state: NetworkState, device: string, text: string): NetworkRow[] {
  const term = text.trim().toLowerCase();
  return state.networks
    .filter((network) => network.device === device && (!term || network.ssid.toLowerCase().includes(term)))
    .map((network) => ({ network, saved: savedFor(state.connections, network.ssid, device) }))
    .sort(
      (a, b) =>
        Number(b.network.active) - Number(a.network.active) ||
        Number(b.saved !== null) - Number(a.saved !== null) ||
        b.network.signal - a.network.signal,
    );
}

// The access points saved that may start on the device
export function hotspotsFor(connections: NetworkConnection[], device: string): NetworkConnection[] {
  return connections
    .filter((c) => c.kind === 'hotspot' && (!c.interface || c.interface === device))
    .sort(byUse);
}

export interface Target {
  uuid?: string | null;
  ssid?: string | null;
  device?: string | null;
}

function concerns(activity: NetworkActivity, target: Target): boolean {
  if (target.uuid && activity.uuid === target.uuid) {
    return true;
  }
  return (
    !!target.ssid &&
    activity.ssid === target.ssid &&
    (!target.device || !activity.device || activity.device === target.device)
  );
}

// What is being done to it, and what failed lately (since then, it did not
// work out)
export function activityFor(
  activity: NetworkActivity[],
  target: Target,
  now: number,
): { running: NetworkActivity | null; failed: NetworkActivity | null } {
  const own = activity.filter((a) => a.action !== 'rescan' && a.action !== 'wifi' && concerns(a, target));
  const running = own.find((a) => a.finished === null) ?? null;
  // The latest first: a failure stands if nothing was done since
  const latest = own.find((a) => a.finished !== null);
  const failed =
    !running && latest?.error && now - (latest.finished ?? 0) < FAILURE_SHOWN_MS ? latest : null;
  return { running, failed };
}

// Where a connection would be activated: the device asked, the one it is
// bound to, or (Wi-Fi) the page's if it is Wi-Fi, NetworkManager's choice
// being unknown
function deviceFor(state: PageState, kind: ConnectionKind, asked: string | null, bound: string): string | null {
  if (asked || bound) {
    return asked || bound;
  }
  const via = state.devices.find((device) => device.name === state.via);
  const type = kind === 'wifi' || kind === 'hotspot' ? 'wifi' : kind === 'ethernet' ? 'ethernet' : null;
  return via && via.type === type ? via.name : null;
}

// Why the request may cut this page off from the robot, null if it should
// not: it changes what the page reaches the robot through
export function cutsOff(state: PageState, request: NetworkRequest): string | null {
  const { via } = state;
  if (!via) {
    return null;
  }
  const through = `This page reaches the robot through ${via}`;
  const connection =
    'uuid' in request ? state.connections.find((c) => c.uuid === request.uuid) : undefined;
  const carrying = connection?.device === via;
  switch (request.action) {
    case 'connect': {
      if (!connection || carrying) {
        return null;
      }
      const device = deviceFor(state, connection.kind, request.device, connection.interface);
      if (device !== via) {
        return null;
      }
      return connection.kind === 'hotspot'
        ? `${through}: starting the access point disconnects it from its network, and this page loses the robot. Join ${connection.ssid || connection.name} to reach it again.`
        : `${through}: connecting it to ${connection.ssid || connection.name} moves the robot to that network, and this page loses it unless it is on that network too.`;
    }
    case 'create': {
      if (!request.connect) {
        return null;
      }
      const { settings } = request;
      const device = deviceFor(state, settings.kind, request.device, settings.interface);
      if (device !== via) {
        return null;
      }
      return settings.kind === 'hotspot'
        ? `${through}: starting the access point disconnects it from its network, and this page loses the robot. Join ${settings.ssid} to reach it again.`
        : `${through}: connecting it to ${settings.ssid || settings.name} moves the robot to that network, and this page loses it unless it is on that network too.`;
    }
    case 'disconnect':
      return carrying ? `${through}: disconnecting ${connection!.name} cuts this page off from the robot.` : null;
    case 'delete':
      return carrying ? `${through}: forgetting ${connection!.name} disconnects it, and cuts this page off.` : null;
    case 'modify':
      return carrying
        ? `${through}: saving reconnects ${connection!.name}, and if its address changes this page loses the robot.`
        : null;
    case 'wifi': {
      const device = state.devices.find((d) => d.name === via);
      return !request.enabled && device?.type === 'wifi'
        ? `${through}, a Wi-Fi interface: turning Wi-Fi off cuts this page off from the robot.`
        : null;
    }
    default:
      return null;
  }
}

// When it was last used, in words
export function lastUsedText(time: number | null, now: number): string {
  if (time === null) {
    return 'Never used';
  }
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) {
    return 'Used just now';
  }
  if (s < 3600) {
    return `Used ${Math.floor(s / 60)} min ago`;
  }
  if (s < 86400) {
    return `Used ${Math.floor(s / 3600)} h ago`;
  }
  const days = Math.floor(s / 86400);
  if (days < 30) {
    return `Used ${days} day${days === 1 ? '' : 's'} ago`;
  }
  return `Used on ${new Date(time).toLocaleDateString()}`;
}

// The name, or with a number if a connection has it already: Lab (2)
export function uniqueName(name: string, connections: NetworkConnection[]): string {
  const taken = new Set(connections.map((c) => c.name));
  if (!taken.has(name)) {
    return name;
  }
  let n = 2;
  while (taken.has(`${name} (${n})`)) {
    n++;
  }
  return `${name} (${n})`;
}

// To join a network in range
export function joinSettings(
  network: Pick<WifiNetwork, 'ssid' | 'security'>,
  password: string | null,
  identity: string,
  autoconnect: boolean,
  hidden: boolean,
  connections: NetworkConnection[],
): NetworkSettings {
  return {
    ...defaultSettings('wifi'),
    name: uniqueName(network.ssid, connections),
    ssid: network.ssid,
    security: network.security,
    password,
    identity,
    autoconnect,
    hidden,
  };
}

// The robot's way out: the interface with the default route, else the first
// connected
export function mainDevice(devices: NetworkDevice[]): NetworkDevice | null {
  const connected = devices.filter((device) => device.state === DEVICE_ACTIVATED && !device.external);
  return connected.find((device) => device.gateway) ?? connected[0] ?? null;
}

// The status line's, the latest activity first
export function summary(state: PageState, now: number): { text: string; tone: Tone } {
  if (state.error) {
    return { text: state.error, tone: 'failed' };
  }
  const running = state.activity.find((a) => a.finished === null);
  if (running) {
    return { text: `${running.label}…`, tone: 'busy' };
  }
  const latest = state.activity[0];
  if (latest?.error && now - (latest.finished ?? 0) < FAILURE_SHOWN_MS / 2) {
    return { text: `${latest.label}: ${latest.error}`, tone: 'failed' };
  }
  const parts: string[] = [];
  let tone: Tone;
  switch (state.connectivity) {
    case 'full':
      parts.push('Online');
      tone = 'on';
      break;
    case 'limited':
      parts.push('No internet');
      tone = 'warn';
      break;
    case 'portal':
      parts.push('Behind a login page');
      tone = 'warn';
      break;
    default:
      parts.push(state.state.startsWith('connected') ? 'Local network only' : 'Disconnected');
      tone = state.state.startsWith('connected') ? 'warn' : 'off';
  }
  const main = mainDevice(state.devices);
  if (main) {
    const address = main.ipv4[0]?.split('/')[0];
    parts.push(`${main.name}: ${main.connectionName}${address ? ` (${address})` : ''}`);
  }
  if (state.via) {
    parts.push(`this page through ${state.via}`);
  }
  return { text: parts.join(' · '), tone };
}

// Why the page may not change the networks, null if it may: not one of the
// dashboard's own, or the server's user may not
export function changeBlocked(state: PageState, readOnly: boolean): string | null {
  if (readOnly) {
    return 'This widget is read-only';
  }
  if (!state.canChange) {
    return 'The networks are changed from the dashboard’s own pages only';
  }
  if (!state.permissions.control && !state.permissions.modify) {
    return 'The server’s user may not change the robot’s networks (see the README: a polkit rule)';
  }
  return null;
}
