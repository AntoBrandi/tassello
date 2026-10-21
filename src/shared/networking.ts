// The robot's networks, as NetworkManager has them: what the Networking
// widget shows and changes (see src/server/networking.ts), and the checks of
// the settings it sends, which the page makes as they are typed and the
// server again before it passes them to nmcli.

// How a Wi-Fi network is secured: open, OWE (open but encrypted), WEP, WPA
// and WPA2 Personal (a password), WPA3 Personal (SAE), WPA Enterprise (802.1X:
// an identity and a password)
export type WifiSecurity = 'open' | 'owe' | 'wep' | 'wpa-psk' | 'sae' | 'wpa-eap';

// What a saved connection is, for the widget: a Wi-Fi network to join, the
// robot's own access point, a cable, a VPN, or something else (a bridge, a
// modem...), which it activates and deactivates only
export type ConnectionKind = 'wifi' | 'hotspot' | 'ethernet' | 'vpn' | 'other';

// The kinds the widget creates and edits
export type EditableKind = 'wifi' | 'hotspot' | 'ethernet';

export type Ipv4Method = 'auto' | 'manual' | 'shared' | 'disabled';

// NetworkManager's device states (NMDeviceState)
export const DEVICE_UNMANAGED = 10;
export const DEVICE_UNAVAILABLE = 20;
export const DEVICE_DISCONNECTED = 30;
export const DEVICE_ACTIVATED = 100;
export const DEVICE_DEACTIVATING = 110;
export const DEVICE_FAILED = 120;

// An interface (nmcli device show)
export interface NetworkDevice {
  // wlan0, eth0
  name: string;
  // wifi, ethernet, bridge, tun, gsm, wireguard, loopback...
  type: string;
  // NetworkManager's: DEVICE_* (40 to 90: connecting)
  state: number;
  // As nmcli says it: connected, connecting (getting IP configuration)...
  stateText: string;
  // Why it last changed state, e.g. "Secrets were required, but not
  // provided"; '' if none given
  reason: string;
  // Its active connection's
  connection: string | null;
  connectionName: string;
  // Configured by another program than NetworkManager (docker, a VPN
  // client): not NetworkManager's to change
  external: boolean;
  // Virtual (a bridge, a tunnel), not hardware
  software: boolean;
  hwaddr: string;
  mtu: number | null;
  // Of a cable: plugged in; null if not a cable or not known
  carrier: boolean | null;
  // 1000 Mb/s; '' if unknown
  speed: string;
  driver: string;
  vendor: string;
  product: string;
  // Of Wi-Fi: it can be an access point, on these bands
  accessPoint: boolean;
  band24: boolean;
  band5: boolean;
  // CIDR: 192.168.1.20/24
  ipv4: string[];
  ipv6: string[];
  gateway: string;
  dns: string[];
}

// A saved connection (nmcli connection show), with its main settings
export interface NetworkConnection {
  uuid: string;
  name: string;
  // nmcli's: 802-11-wireless, 802-3-ethernet, vpn, bridge...
  type: string;
  kind: ConnectionKind;
  // Only on this interface; '' on any
  interface: string;
  autoconnect: boolean;
  // Among those that connect automatically, the higher first
  priority: number;
  // When it was last active, ms since the epoch; null if never
  lastUsed: number | null;
  readOnly: boolean;
  // Its file: under /run, it is lost at reboot; netplan-*, netplan's
  file: string;
  // Where it is active, and how: activating, activated, deactivating
  device: string | null;
  activeState: string | null;
  // Made by NetworkManager for an interface another program configured
  external: boolean;
  // Wi-Fi networks and access points
  ssid: string;
  security: WifiSecurity | null;
  hidden: boolean;
  // Access points: bg (2.4 GHz), a (5 GHz); '' either
  band: '' | 'a' | 'bg';
  channel: number;
  identity: string;
  // Of a VPN: its plugin (openvpn, vpnc...)
  vpnService: string;
  // IPv4: auto (DHCP), manual, shared (the robot gives the addresses: an
  // access point's), disabled, link-local...
  ipv4Method: string;
  addresses: string[];
  gateway: string;
  dns: string[];
}

// A Wi-Fi network in range of a device: its access points of that name, by
// the strongest (nmcli device wifi list)
export interface WifiNetwork {
  // '' if hidden
  ssid: string;
  device: string;
  bssid: string;
  // %
  signal: number;
  // MHz
  frequency: number;
  channel: number;
  // 540 Mbit/s
  rate: string;
  // As nmcli says it: WPA2, WPA1 WPA2, WPA3, WPA2 802.1X...; '' if open
  securityText: string;
  security: WifiSecurity;
  // Infra, Ad-Hoc, Mesh
  mode: string;
  // The device is connected to it
  active: boolean;
  // Its access points in range (a building's, a mesh's)
  points: number;
}

// Something the pages asked of NetworkManager, while it is done and for a
// while after: every page shows it, the one that asked may have lost the
// robot meanwhile (it switched networks)
export interface NetworkActivity {
  // Numbered by the server
  id: number;
  action: NetworkRequest['action'];
  // What it is, in words: Connecting to Lab, Starting the access point Robot
  label: string;
  // What it is done to
  uuid: string | null;
  ssid: string | null;
  device: string | null;
  // On the server's clock
  started: number;
  finished: number | null;
  // Why it failed; null if it did not (yet)
  error: string | null;
}

// What the server's user may do (nmcli general permissions): without these,
// the actions fail. "auth" (asking for a password) is as good as no: the
// server cannot type it.
export interface NetworkPermissions {
  // Activate and deactivate connections
  control: boolean;
  // Save, change and delete connections
  modify: boolean;
  // Turn Wi-Fi on and off
  wifi: boolean;
  scan: boolean;
  // Start access points
  share: boolean;
}

export interface NetworkState {
  // Why NetworkManager cannot be read: nmcli not installed, NetworkManager
  // not running. The rest is then empty.
  error: string | null;
  // NetworkManager's
  version: string;
  // connected, connected (site only), connecting, disconnected, asleep
  state: string;
  // full, limited, portal, none, unknown
  connectivity: string;
  // The radio, and its hardware switch
  wifi: boolean;
  wifiHardware: boolean;
  permissions: NetworkPermissions;
  devices: NetworkDevice[];
  connections: NetworkConnection[];
  networks: WifiNetwork[];
  // A scan asked for is under way
  scanning: boolean;
  // The latest first
  activity: NetworkActivity[];
}

// What the forms edit: a connection the widget makes (a Wi-Fi network, an
// access point, a cable's), or changes
export interface NetworkSettings {
  kind: EditableKind;
  name: string;
  // Only on this interface; '' on any. An access point's is required.
  interface: string;
  autoconnect: boolean;
  priority: number;
  // Wi-Fi networks and access points
  ssid: string;
  hidden: boolean;
  security: WifiSecurity;
  // null: the one saved (a change)
  password: string | null;
  // WPA Enterprise: PEAP or TTLS, with MSCHAPv2
  identity: string;
  // Access points
  band: '' | 'a' | 'bg';
  channel: number;
  ipv4: Ipv4Method;
  // CIDR: 192.168.1.20/24
  addresses: string[];
  gateway: string;
  dns: string[];
}

export type NetworkRequest =
  // Activates a saved connection, on device (null: where NetworkManager
  // chooses); with a password, saved first in place of the one it has
  | { action: 'connect'; uuid: string; device: string | null; password: string | null }
  | { action: 'disconnect'; uuid: string }
  // Saves a new connection, and activates it if connect (on device, if
  // given). A Wi-Fi network or an access point that fails to start is not
  // kept.
  | { action: 'create'; settings: NetworkSettings; connect: boolean; device: string | null }
  // Changes a saved connection: activated again if active, unless only its
  // name, autoconnect or priority changed
  | { action: 'modify'; uuid: string; settings: NetworkSettings }
  | { action: 'delete'; uuid: string }
  | { action: 'wifi'; enabled: boolean }
  // Scans for Wi-Fi networks: device's, or every Wi-Fi device's (null)
  | { action: 'rescan'; device: string | null }
  // A Wi-Fi network's or an access point's name and password, to share them
  // (a QR code): NetworkSecrets
  | { action: 'secrets'; uuid: string };

export interface NetworkSecrets {
  ssid: string;
  security: WifiSecurity | null;
  // '' if none, or not readable
  password: string;
  hidden: boolean;
}

// The result of an action, but secrets'
export interface NetworkResult {
  // The connection made or acted on
  uuid: string | null;
  // What happened besides, e.g. saved but not connected
  message: string | null;
}

// The reason a connection fails with when its password is wrong: the page
// asks for it again
export const WRONG_PASSWORD = 'Wrong password, or none given';

export const SECURITY_LABELS: Record<WifiSecurity, string> = {
  open: 'None (open)',
  owe: 'Enhanced Open (OWE)',
  wep: 'WEP',
  'wpa-psk': 'WPA/WPA2 Personal',
  sae: 'WPA3 Personal',
  'wpa-eap': 'WPA/WPA2 Enterprise',
};

export function needsPassword(security: WifiSecurity): boolean {
  return security !== 'open' && security !== 'owe';
}

// Linux's: at most 15 characters, no slashes, spaces or colons
const INTERFACE = /^[\w.@-]{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Of the 2.4 GHz band, and of the 5 GHz one (20 MHz channels)
const CHANNELS_24 = Array.from({ length: 14 }, (_, i) => i + 1);
const CHANNELS_5 = [
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165,
  169, 173, 177,
];

export function isInterfaceName(name: string): boolean {
  return INTERFACE.test(name);
}

export function isUuid(uuid: string): boolean {
  return UUID.test(uuid);
}

export function isIpv4(address: string): boolean {
  const parts = address.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export function isIpv6(address: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(address) || !address.includes(':')) {
    return false;
  }
  const halves = address.split('::');
  if (halves.length > 2) {
    return false;
  }
  const groups = halves.flatMap((half) => (half ? half.split(':') : []));
  // An IPv4 tail counts as two groups
  const last = groups.at(-1) ?? '';
  const ipv4Tail = last.includes('.');
  if (ipv4Tail && !isIpv4(last)) {
    return false;
  }
  const hex = ipv4Tail ? groups.slice(0, -1) : groups;
  if (!hex.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
    return false;
  }
  const count = hex.length + (ipv4Tail ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
}

// 192.168.1.20/24: an address of a network, not the network itself
export function cidrProblem(cidr: string): string | null {
  const [address, prefix, ...rest] = cidr.trim().split('/');
  if (rest.length > 0 || !isIpv4(address)) {
    return `“${cidr.trim()}” is not an IPv4 address`;
  }
  if (prefix === undefined) {
    return `Give its network's size: ${address}/24`;
  }
  if (!/^\d{1,2}$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > 32) {
    return `/${prefix} is not a network's size: /1 to /32 (/24: 255.255.255.0)`;
  }
  return null;
}

// Separated by commas, spaces or new lines
export function splitList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Of a Wi-Fi network or an access point, by its security; null if fine
export function passwordProblem(security: WifiSecurity, password: string, hotspot = false): string | null {
  switch (security) {
    case 'open':
    case 'owe':
      return null;
    case 'wpa-psk':
      if (/^[0-9a-f]{64}$/i.test(password)) {
        return null;
      }
      if (!/^[\x20-\x7e]*$/.test(password)) {
        return 'Letters, digits and symbols of the keyboard only: no accents';
      }
      if (password.length < 8 || password.length > 63) {
        return hotspot ? '8 to 63 characters' : 'WPA passwords have 8 to 63 characters';
      }
      return null;
    case 'sae':
      return password.length === 0 ? 'The network’s password' : password.length > 128 ? 'At most 128 characters' : null;
    case 'wep':
      return /^([\x20-\x7e]{5}|[\x20-\x7e]{13}|[0-9a-f]{10}|[0-9a-f]{26})$/i.test(password)
        ? null
        : 'WEP keys have 5 or 13 characters, or 10 or 26 hexadecimal digits';
    case 'wpa-eap':
      return password.length === 0 ? 'Your password on the network' : null;
  }
}

// What is wrong with the settings, by field: empty if nothing. creating: a
// new connection, whose password is required.
export function settingsProblems(
  settings: NetworkSettings,
  creating: boolean,
): Partial<Record<keyof NetworkSettings, string>> {
  const problems: Partial<Record<keyof NetworkSettings, string>> = {};
  const { kind } = settings;
  const name = settings.name.trim();
  if (!name) {
    problems.name = 'A name for the connection';
  } else if (name.length > 255 || /[\x00-\x1f]/.test(name)) {
    problems.name = 'At most 255 characters, on one line';
  }
  if (settings.interface && !isInterfaceName(settings.interface)) {
    problems.interface = `“${settings.interface}” is not an interface's name`;
  } else if (kind === 'hotspot' && !settings.interface) {
    problems.interface = 'The Wi-Fi interface of the access point';
  }
  if (!Number.isInteger(settings.priority) || settings.priority < -999 || settings.priority > 999) {
    problems.priority = 'A whole number, from -999 to 999';
  }
  if (kind !== 'ethernet') {
    const bytes = utf8Length(settings.ssid);
    if (bytes === 0) {
      problems.ssid = kind === 'hotspot' ? 'The name the access point shows' : 'The network’s name';
    } else if (bytes > 32) {
      problems.ssid = 'At most 32 bytes (fewer with accents and symbols)';
    } else if (/[\x00-\x1f]/.test(settings.ssid)) {
      problems.ssid = 'No control characters';
    }
    if (kind === 'hotspot' && settings.security !== 'open' && settings.security !== 'wpa-psk') {
      problems.security = 'An access point is open, or secured by a WPA2 password';
    }
    if (settings.security === 'wpa-eap') {
      if (!settings.identity.trim()) {
        problems.identity = 'Your user name on the network';
      } else if (/[\x00-\x1f]/.test(settings.identity)) {
        problems.identity = 'No control characters';
      }
    }
    if (settings.password !== null) {
      const problem = passwordProblem(settings.security, settings.password, kind === 'hotspot');
      if (problem) {
        problems.password = problem;
      }
    } else if (creating && needsPassword(settings.security)) {
      problems.password = 'The network’s password';
    }
    if (kind === 'hotspot') {
      const channels = settings.band === 'a' ? CHANNELS_5 : settings.band === 'bg' ? CHANNELS_24 : [];
      if (settings.channel !== 0 && !channels.includes(settings.channel)) {
        problems.channel = settings.band
          ? `Not a channel of ${settings.band === 'a' ? '5' : '2.4'} GHz`
          : 'Choose the band of the channel';
      }
    }
  }
  const methods: Ipv4Method[] = kind === 'hotspot' ? ['shared'] : ['auto', 'manual', 'shared', 'disabled'];
  if (!methods.includes(settings.ipv4)) {
    problems.ipv4 = kind === 'hotspot' ? 'An access point gives the addresses (shared)' : 'Not a way to get an address';
  }
  const addressProblem = settings.addresses.map(cidrProblem).find((problem) => problem !== null);
  if (addressProblem) {
    problems.addresses = addressProblem;
  } else if (settings.ipv4 === 'manual' && settings.addresses.length === 0) {
    problems.addresses = 'The robot’s address on this network: 192.168.1.20/24';
  } else if (settings.ipv4 === 'shared' && settings.addresses.length > 1) {
    problems.addresses = 'One address: the robot’s, on the network it gives';
  }
  if (settings.gateway && !isIpv4(settings.gateway)) {
    problems.gateway = `“${settings.gateway}” is not an IPv4 address`;
  }
  const badDns = settings.dns.find((server) => !isIpv4(server) && !isIpv6(server));
  if (badDns !== undefined) {
    problems.dns = `“${badDns}” is not an IP address`;
  }
  return problems;
}

// The settings of a saved connection, to edit them (its password unchanged)
export function settingsOf(connection: NetworkConnection): NetworkSettings | null {
  const kind = connection.kind;
  if (kind !== 'wifi' && kind !== 'hotspot' && kind !== 'ethernet') {
    return null;
  }
  const methods: Ipv4Method[] = ['auto', 'manual', 'shared', 'disabled'];
  return {
    kind,
    name: connection.name,
    interface: connection.interface,
    autoconnect: connection.autoconnect,
    priority: connection.priority,
    ssid: connection.ssid,
    hidden: connection.hidden,
    security: connection.security ?? 'open',
    password: null,
    identity: connection.identity,
    band: connection.band,
    channel: connection.channel,
    ipv4: methods.includes(connection.ipv4Method as Ipv4Method) ? (connection.ipv4Method as Ipv4Method) : 'auto',
    addresses: connection.addresses,
    gateway: connection.gateway,
    dns: connection.dns,
  };
}

// A new connection's, of a kind
export function defaultSettings(kind: EditableKind): NetworkSettings {
  return {
    kind,
    name: '',
    interface: '',
    autoconnect: true,
    priority: 0,
    ssid: '',
    hidden: false,
    security: kind === 'ethernet' ? 'open' : 'wpa-psk',
    password: kind === 'ethernet' ? null : '',
    identity: '',
    band: '',
    channel: 0,
    ipv4: kind === 'hotspot' ? 'shared' : 'auto',
    addresses: [],
    gateway: '',
    dns: [],
  };
}
