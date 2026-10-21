// What nmcli prints, read, and the arguments it is given: for networking.ts,
// kept apart to be tested without NetworkManager.
//
// nmcli runs with --terse: tables are a line per row, their fields separated
// by colons (those of the values escaped, \:, as backslashes are, \\); the
// details of a device or connection are a "FIELD:value" line per field, the
// value as it is, and a blank line between devices or connections.

import {
  isInterfaceName,
  isUuid,
  needsPassword,
  settingsProblems,
  WRONG_PASSWORD,
  type ConnectionKind,
  type EditableKind,
  type Ipv4Method,
  type NetworkConnection,
  type NetworkDevice,
  type NetworkPermissions,
  type NetworkRequest,
  type NetworkSettings,
  type WifiNetwork,
  type WifiSecurity,
} from '../shared/networking.ts';

// The fields asked of each, in this order (-f)
export const GENERAL_FIELDS = 'RUNNING,VERSION,STATE,CONNECTIVITY,NETWORKING,WIFI-HW,WIFI';
export const DEVICE_SECTIONS = 'GENERAL,CAPABILITIES,WIRED-PROPERTIES,WIFI-PROPERTIES,IP4,IP6';
export const CONNECTION_FIELDS = 'NAME,UUID,TYPE,TIMESTAMP,AUTOCONNECT,AUTOCONNECT-PRIORITY,READONLY,DEVICE,ACTIVE,STATE,FILENAME';
export const CONNECTION_SETTINGS = [
  'connection.id',
  'connection.uuid',
  'connection.type',
  'connection.interface-name',
  'connection.autoconnect',
  'connection.autoconnect-priority',
  '802-11-wireless.ssid',
  '802-11-wireless.mode',
  '802-11-wireless.band',
  '802-11-wireless.channel',
  '802-11-wireless.hidden',
  '802-11-wireless-security.key-mgmt',
  '802-1x.identity',
  'vpn.service-type',
  'ipv4.method',
  'ipv4.addresses',
  'ipv4.gateway',
  'ipv4.dns',
].join(',');
export const WIFI_FIELDS = 'SSID,SSID-HEX,BSSID,MODE,CHAN,FREQ,RATE,SIGNAL,SECURITY,DEVICE,ACTIVE';

// One line of a terse table: its fields, unescaped
export function terseFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      field += line[++i];
    } else if (c === ':') {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

function terseRows(output: string): string[][] {
  return output
    .split('\n')
    .filter((line) => line.trim())
    .map(terseFields);
}

// The details of devices or connections: a map per block, from the field
// (IP4.ADDRESS[2]: IP4.ADDRESS) to its values, in order
export function terseBlocks(output: string): Map<string, string[]>[] {
  return output
    .split(/\n\s*\n/)
    .map((block) => {
      const fields = new Map<string, string[]>();
      for (const line of block.split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) {
          continue;
        }
        const key = line.slice(0, colon).replace(/\[\d+\]$/, '');
        fields.set(key, [...(fields.get(key) ?? []), line.slice(colon + 1)]);
      }
      return fields;
    })
    .filter((fields) => fields.size > 0);
}

function first(fields: Map<string, string[]>, key: string): string {
  return fields.get(key)?.[0] ?? '';
}

function yes(value: string): boolean {
  return value === 'yes' || value === 'on' || value === 'enabled';
}

// "100 (connected (externally))": 100, connected (externally)
function coded(value: string): { code: number; text: string } {
  const match = /^(\d+)\s*\((.*)\)$/.exec(value.trim());
  return match ? { code: Number(match[1]), text: match[2] } : { code: 0, text: value.trim() };
}

export interface GeneralState {
  running: boolean;
  version: string;
  state: string;
  connectivity: string;
  networking: boolean;
  wifiHardware: boolean;
  wifi: boolean;
}

// nmcli -f GENERAL_FIELDS general
export function parseGeneral(output: string): GeneralState {
  const [running = '', version = '', state = '', connectivity = '', networking = '', wifiHardware = '', wifi = ''] =
    terseRows(output)[0] ?? [];
  return {
    running: running === 'running',
    version,
    state,
    connectivity,
    networking: yes(networking),
    wifiHardware: yes(wifiHardware),
    wifi: yes(wifi),
  };
}

// nmcli general permissions: "org.freedesktop.NetworkManager.network-control:yes"
export function parsePermissions(output: string): NetworkPermissions {
  const granted = new Set(
    terseRows(output)
      .filter(([, value]) => value === 'yes')
      .map(([name]) => name.replace(/^org\.freedesktop\.NetworkManager\./, '')),
  );
  return {
    control: granted.has('network-control'),
    modify: granted.has('settings.modify.system'),
    wifi: granted.has('enable-disable-wifi'),
    scan: granted.has('wifi.scan'),
    share: granted.has('wifi.share.protected') || granted.has('wifi.share.open'),
  };
}

// nmcli -f DEVICE_SECTIONS device show
export function parseDevices(output: string): NetworkDevice[] {
  return terseBlocks(output)
    .filter((fields) => first(fields, 'GENERAL.DEVICE'))
    .map((fields) => {
      const state = coded(first(fields, 'GENERAL.STATE'));
      const reason = coded(first(fields, 'GENERAL.REASON'));
      const carrier = fields.get('WIRED-PROPERTIES.CARRIER');
      const mtu = Number(first(fields, 'GENERAL.MTU'));
      const speed = first(fields, 'CAPABILITIES.SPEED');
      return {
        name: first(fields, 'GENERAL.DEVICE'),
        type: first(fields, 'GENERAL.TYPE'),
        state: state.code,
        stateText: state.text,
        reason: reason.code === 0 ? '' : reason.text,
        connection: first(fields, 'GENERAL.CON-UUID') || null,
        connectionName: first(fields, 'GENERAL.CONNECTION'),
        external: state.text.includes('externally'),
        software: yes(first(fields, 'GENERAL.IS-SOFTWARE')),
        hwaddr: first(fields, 'GENERAL.HWADDR'),
        mtu: mtu > 0 ? mtu : null,
        carrier: carrier ? yes(carrier[0]) : null,
        speed: speed === 'unknown' ? '' : speed,
        driver: first(fields, 'GENERAL.DRIVER'),
        vendor: first(fields, 'GENERAL.VENDOR'),
        product: first(fields, 'GENERAL.PRODUCT'),
        accessPoint: yes(first(fields, 'WIFI-PROPERTIES.AP')),
        band24: yes(first(fields, 'WIFI-PROPERTIES.2GHZ')),
        band5: yes(first(fields, 'WIFI-PROPERTIES.5GHZ')),
        ipv4: fields.get('IP4.ADDRESS') ?? [],
        ipv6: fields.get('IP6.ADDRESS') ?? [],
        gateway: first(fields, 'IP4.GATEWAY'),
        dns: fields.get('IP4.DNS') ?? [],
      };
    });
}

// Newer nmcli lists them as wifi and ethernet, older ones by their settings'
// names
function connectionType(type: string): string {
  return type === 'wifi' ? '802-11-wireless' : type === 'ethernet' ? '802-3-ethernet' : type;
}

export function connectionKind(type: string, mode: string): ConnectionKind {
  switch (connectionType(type)) {
    case '802-11-wireless':
      return mode === 'ap' ? 'hotspot' : 'wifi';
    case '802-3-ethernet':
      return 'ethernet';
    case 'vpn':
    case 'wireguard':
      return 'vpn';
    default:
      return 'other';
  }
}

// Of a saved Wi-Fi connection (802-11-wireless-security.key-mgmt): none is
// WEP; no security setting at all, open
export function keyManagementSecurity(keyManagement: string): WifiSecurity {
  switch (keyManagement) {
    case 'none':
      return 'wep';
    case 'wpa-psk':
      return 'wpa-psk';
    case 'sae':
      return 'sae';
    case 'owe':
      return 'owe';
    case 'wpa-eap':
    case 'wpa-eap-suite-b-192':
    case 'ieee8021x':
      return 'wpa-eap';
    default:
      return 'open';
  }
}

// Of a network in range, as nmcli says it: WPA3 alone is SAE, with WPA2
// (transition mode) WPA2's password works
export function scanSecurity(text: string): WifiSecurity {
  if (text.includes('802.1X')) {
    return 'wpa-eap';
  }
  if (/WPA[12]/.test(text)) {
    return 'wpa-psk';
  }
  if (text.includes('WPA3')) {
    return 'sae';
  }
  if (text.includes('WEP')) {
    return 'wep';
  }
  if (text.includes('OWE')) {
    return 'owe';
  }
  return 'open';
}

// "192.168.1.20/24, 192.168.1.21/24", "8.8.8.8,1.1.1.1"
function list(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item && item !== '--');
}

function settingNumber(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// nmcli -f CONNECTION_FIELDS connection show, merged with the settings of
// each (nmcli -f CONNECTION_SETTINGS connection show uuid ...), by uuid. The
// devices tell which are another program's.
export function parseConnections(
  listOutput: string,
  settings: ReadonlyMap<string, Map<string, string[]>>,
  devices: NetworkDevice[],
): NetworkConnection[] {
  const external = new Set(devices.filter((device) => device.external && device.connection).map((d) => d.connection));
  return terseRows(listOutput)
    .filter((row) => row.length >= 11)
    .map(([name, uuid, type, timestamp, autoconnect, priority, readOnly, device, active, activeState, file]) => {
      const own = settings.get(uuid) ?? new Map<string, string[]>();
      const setting = (key: string) => first(own, key);
      const mode = setting('802-11-wireless.mode');
      const kind = connectionKind(type, mode);
      const wireless = kind === 'wifi' || kind === 'hotspot';
      const keyManagement = setting('802-11-wireless-security.key-mgmt');
      const band = setting('802-11-wireless.band');
      const lastUsed = Number(timestamp);
      return {
        uuid,
        name,
        type: connectionType(type),
        kind,
        interface: setting('connection.interface-name'),
        autoconnect: yes(autoconnect),
        priority: settingNumber(priority),
        lastUsed: lastUsed > 0 ? lastUsed * 1000 : null,
        readOnly: yes(readOnly),
        file,
        device: yes(active) && device ? device : null,
        activeState: yes(active) ? activeState || 'activated' : null,
        external: external.has(uuid),
        ssid: setting('802-11-wireless.ssid'),
        security: wireless ? keyManagementSecurity(keyManagement) : null,
        hidden: yes(setting('802-11-wireless.hidden')),
        band: band === 'a' || band === 'bg' ? band : '',
        channel: settingNumber(setting('802-11-wireless.channel')),
        identity: setting('802-1x.identity'),
        vpnService: setting('vpn.service-type').replace(/^org\.freedesktop\.NetworkManager\./, ''),
        ipv4Method: setting('ipv4.method'),
        addresses: list(setting('ipv4.addresses')),
        gateway: setting('ipv4.gateway').replace(/^--$/, ''),
        dns: list(setting('ipv4.dns')),
      };
    });
}

// Of nmcli -f CONNECTION_FIELDS connection show
export function connectionUuids(listOutput: string): string[] {
  return terseRows(listOutput)
    .map((row) => row[1])
    .filter((uuid) => uuid && isUuid(uuid));
}

// By uuid
export function settingsBlocks(output: string): Map<string, Map<string, string[]>> {
  return new Map(terseBlocks(output).map((fields) => [first(fields, 'connection.uuid'), fields]));
}

// The exact name, from its bytes: nmcli's SSID column is for reading, and
// not every name is UTF-8
function ssidFromHex(hex: string, shown: string): string {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) {
    return shown;
  }
  const bytes = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return shown;
  }
}

// nmcli -f WIFI_FIELDS device wifi list: the access points, by device and
// name, the strongest standing for the others; hidden ones (no name) left
// out. The device's own first, then the strongest.
export function parseWifiList(output: string): WifiNetwork[] {
  const networks = new Map<string, WifiNetwork>();
  for (const row of terseRows(output)) {
    if (row.length < 11) {
      continue;
    }
    const [shown, hex, bssid, mode, channel, frequency, rate, signal, securityText, device, active] = row;
    const ssid = ssidFromHex(hex, shown);
    if (!ssid || !device) {
      continue;
    }
    const point: WifiNetwork = {
      ssid,
      device,
      bssid,
      signal: settingNumber(signal),
      frequency: Number.parseInt(frequency, 10) || 0,
      channel: settingNumber(channel),
      rate,
      securityText: securityText === '--' ? '' : securityText,
      security: scanSecurity(securityText),
      mode,
      active: yes(active),
      points: 1,
    };
    const key = `${device}\n${ssid}`;
    const known = networks.get(key);
    if (!known) {
      networks.set(key, point);
      continue;
    }
    // The one connected to, else the strongest
    const better = point.active || (!known.active && point.signal > known.signal);
    networks.set(key, {
      ...(better ? point : known),
      active: known.active || point.active,
      points: known.points + 1,
    });
  }
  return [...networks.values()].sort(
    (a, b) =>
      a.device.localeCompare(b.device) ||
      Number(b.active) - Number(a.active) ||
      b.signal - a.signal ||
      a.ssid.localeCompare(b.ssid),
  );
}

// The interface a page reaches the server through, from the address it
// reached (the socket's local address); null if none, or the robot itself
export function deviceOfAddress(devices: NetworkDevice[], address: string | null | undefined): string | null {
  if (!address) {
    return null;
  }
  // IPv4 in IPv6 (::ffff:192.168.1.20), and link-local scopes (fe80::1%wlan0)
  const plain = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '').toLowerCase();
  if (plain === '::1' || plain.startsWith('127.')) {
    return null;
  }
  const device = devices.find((d) =>
    [...d.ipv4, ...d.ipv6].some((cidr) => cidr.split('/')[0].toLowerCase() === plain),
  );
  return device && device.type !== 'loopback' ? device.name : null;
}

// What nmcli said went wrong, for the page: without its "Error:" and its
// hints, and a word on what to do when the reason is a usual one
export function nmcliProblem(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Hint:'));
  let text = lines.join(' ').replace(/^Error:\s*/i, '');
  text = text.replace(/^Connection activation failed:\s*/i, '').replace(/^\(\d+\)\s*/, '').replace(/\.$/, '');
  if (!text) {
    return fallback;
  }
  if (/not authorized|insufficient privileges|permission denied/i.test(text)) {
    return `${text}: the server's user may not change the robot's networks (see the README: a polkit rule)`;
  }
  if (/secrets were required|no secrets|802\.1x supplicant/i.test(text)) {
    return WRONG_PASSWORD;
  }
  if (/could not be found|no network with ssid/i.test(text)) {
    return 'The network is not in range';
  }
  if (/IP configuration could not be reserved/i.test(text)) {
    return 'The network gave no address (no DHCP server, or it did not answer)';
  }
  if (/timeout expired/i.test(text)) {
    return 'NetworkManager took too long: it may still be trying';
  }
  if (/dnsmasq/i.test(text)) {
    return `${text}: the access point needs dnsmasq (the dnsmasq-base package) to give addresses`;
  }
  return text;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

// The security settings: key management and secrets. password null: the
// secret saved is kept.
function securityArgs(settings: NetworkSettings): string[] {
  const password = settings.password;
  const security = '802-11-wireless-security';
  switch (settings.security) {
    case 'open':
      return [];
    case 'owe':
      return [`${security}.key-mgmt`, 'owe'];
    case 'wep':
      return [
        `${security}.key-mgmt`,
        'none',
        `${security}.wep-key-type`,
        '1',
        ...(password === null ? [] : [`${security}.wep-key0`, password]),
      ];
    case 'wpa-psk':
      return [
        `${security}.key-mgmt`,
        'wpa-psk',
        ...(password === null ? [] : [`${security}.psk`, password]),
        // As nmcli's own hotspots: WPA2 with AES only, which every client
        // and driver of today handles
        ...(settings.kind === 'hotspot'
          ? [`${security}.proto`, 'rsn', `${security}.pairwise`, 'ccmp', `${security}.group`, 'ccmp']
          : []),
      ];
    case 'sae':
      return [`${security}.key-mgmt`, 'sae', ...(password === null ? [] : [`${security}.psk`, password])];
    case 'wpa-eap':
      return [
        `${security}.key-mgmt`,
        'wpa-eap',
        '802-1x.eap',
        'peap',
        '802-1x.phase2-auth',
        'mschapv2',
        '802-1x.identity',
        settings.identity.trim(),
        ...(password === null ? [] : ['802-1x.password', password]),
      ];
  }
}

function ipv4Args(settings: NetworkSettings): string[] {
  const { ipv4 } = settings;
  const args = ['ipv4.method', ipv4];
  args.push('ipv4.addresses', ipv4 === 'manual' || ipv4 === 'shared' ? settings.addresses.join(',') : '');
  args.push('ipv4.gateway', ipv4 === 'manual' ? settings.gateway : '');
  args.push('ipv4.dns', ipv4 === 'disabled' ? '' : settings.dns.join(','));
  return args;
}

function wirelessArgs(settings: NetworkSettings): string[] {
  const args = ['802-11-wireless.ssid', settings.ssid, '802-11-wireless.hidden', yesNo(settings.hidden)];
  if (settings.kind === 'hotspot') {
    args.push('802-11-wireless.mode', 'ap', '802-11-wireless.band', settings.band);
    args.push('802-11-wireless.channel', String(settings.band ? settings.channel : 0));
  }
  return args;
}

// nmcli connection add's arguments for the settings (checked already: see
// settingsProblems). The secrets are on nmcli's command line for the moment
// it takes to save them: activating the connection is another command.
export function createArgs(settings: NetworkSettings): string[] {
  const wireless = settings.kind !== 'ethernet';
  const args = [
    'connection',
    'add',
    'type',
    wireless ? 'wifi' : 'ethernet',
    'con-name',
    settings.name.trim(),
    // Not bound to an interface unless asked: any Wi-Fi adapter joins it
    ...(settings.interface ? ['connection.interface-name', settings.interface] : []),
    'connection.autoconnect',
    yesNo(settings.autoconnect),
    'connection.autoconnect-priority',
    String(settings.priority),
  ];
  if (wireless) {
    args.push(...wirelessArgs(settings), ...securityArgs(settings));
  }
  args.push(...ipv4Args(settings));
  // An access point gives IPv4 addresses only
  if (settings.kind === 'hotspot') {
    args.push('ipv6.method', 'ignore');
  }
  return args;
}

export interface Modification {
  // nmcli connection modify's arguments: settings removed (remove <setting>)
  // and properties set, in one call: NetworkManager checks the connection
  // after each, and a security half changed is no valid one
  args: string[];
  // A change the connection must be activated again for
  reactivate: boolean;
}

// What to change of the saved connection to make it the settings: only
// what differs, so that what the widget does not show is kept
export function modification(current: NetworkConnection, settings: NetworkSettings): Modification {
  const general: string[] = [];
  const name = settings.name.trim();
  if (name !== current.name) {
    general.push('connection.id', name);
  }
  if (settings.autoconnect !== current.autoconnect) {
    general.push('connection.autoconnect', yesNo(settings.autoconnect));
  }
  if (settings.priority !== current.priority) {
    general.push('connection.autoconnect-priority', String(settings.priority));
  }
  const args: string[] = [];
  if (settings.interface !== current.interface) {
    args.push('connection.interface-name', settings.interface);
  }
  if (settings.kind !== 'ethernet') {
    const wireless = wirelessArgs(settings);
    const before = wirelessArgs({
      ...settings,
      ssid: current.ssid,
      hidden: current.hidden,
      band: current.band,
      channel: current.channel,
    });
    if (wireless.join('\n') !== before.join('\n')) {
      args.push(...wireless);
    }
    const was = current.security ?? 'open';
    const securityChanged =
      settings.security !== was ||
      settings.password !== null ||
      (settings.security === 'wpa-eap' && settings.identity.trim() !== current.identity);
    if (securityChanged) {
      if (was === 'wpa-eap' && settings.security !== 'wpa-eap') {
        args.push('remove', '802-1x');
      }
      if (settings.security === 'open') {
        if (was !== 'open') {
          args.push('remove', '802-11-wireless-security');
        }
      } else {
        args.push(...securityArgs(settings));
      }
    }
  }
  const ipv4 = ipv4Args(settings);
  const ipv4Before = ipv4Args({
    ...settings,
    ipv4: current.ipv4Method as NetworkSettings['ipv4'],
    addresses: current.addresses,
    gateway: current.gateway,
    dns: current.dns,
  });
  if (ipv4.join('\n') !== ipv4Before.join('\n')) {
    args.push(...ipv4);
  }
  return { args: [...general, ...args], reactivate: args.length > 0 };
}

// The secrets of a connection, to change a password found wrong
export function passwordArgs(connection: NetworkConnection, password: string): string[] {
  switch (connection.security) {
    case 'wpa-eap':
      return ['802-1x.password', password];
    case 'wep':
      return ['802-11-wireless-security.wep-key0', password];
    default:
      return ['802-11-wireless-security.psk', password];
  }
}

const KINDS: EditableKind[] = ['wifi', 'hotspot', 'ethernet'];
const SECURITIES: WifiSecurity[] = ['open', 'owe', 'wep', 'wpa-psk', 'sae', 'wpa-eap'];
const METHODS: Ipv4Method[] = ['auto', 'manual', 'shared', 'disabled'];

function uuidOf(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new Error('Invalid connection');
  }
  return value.toLowerCase();
}

function deviceOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isInterfaceName(value)) {
    throw new Error('Invalid interface');
  }
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], what: string): T {
  if (!values.includes(value as T)) {
    throw new Error(`Invalid ${what}`);
  }
  return value as T;
}

function addressList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Invalid ${what}`);
  }
  return value.map((item: string) => item.trim()).filter(Boolean);
}

// The settings a page sent, of the right types and checked: throws their
// first problem
export function checkSettings(value: unknown, creating: boolean): NetworkSettings {
  const s = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof s[key] === 'string' ? s[key] : '');
  const integer = (key: string) => (typeof s[key] === 'number' && Number.isInteger(s[key]) ? s[key] : NaN);
  const kind = oneOf(s.kind, KINDS, 'kind of connection');
  const wireless = kind !== 'ethernet';
  const settings: NetworkSettings = {
    kind,
    name: text('name').trim(),
    interface: text('interface').trim(),
    autoconnect: s.autoconnect !== false,
    priority: integer('priority'),
    // As typed: a name or a password may start or end with spaces
    ssid: wireless ? text('ssid') : '',
    hidden: wireless && s.hidden === true,
    security: wireless ? oneOf(s.security, SECURITIES, 'security') : 'open',
    password: wireless && typeof s.password === 'string' ? s.password : null,
    identity: wireless ? text('identity').trim() : '',
    band: kind === 'hotspot' ? oneOf(s.band ?? '', ['', 'a', 'bg'] as const, 'band') : '',
    channel: kind === 'hotspot' ? integer('channel') : 0,
    ipv4: oneOf(s.ipv4, METHODS, 'IPv4 method'),
    addresses: addressList(s.addresses ?? [], 'addresses'),
    gateway: text('gateway').trim(),
    dns: addressList(s.dns ?? [], 'DNS servers'),
  };
  if (!needsPassword(settings.security)) {
    settings.password = null;
  }
  const problem = Object.values(settingsProblems(settings, creating))[0];
  if (problem) {
    throw new Error(problem);
  }
  return settings;
}

// A request a page sent, of the right types and checked: throws why not
export function checkRequest(value: unknown): NetworkRequest {
  const request = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  switch (request.action) {
    case 'connect':
      if (request.password !== null && request.password !== undefined && typeof request.password !== 'string') {
        throw new Error('Invalid password');
      }
      return {
        action: 'connect',
        uuid: uuidOf(request.uuid),
        device: deviceOf(request.device),
        password: typeof request.password === 'string' ? request.password : null,
      };
    case 'disconnect':
    case 'delete':
    case 'secrets':
      return { action: request.action, uuid: uuidOf(request.uuid) };
    case 'create':
      return {
        action: 'create',
        settings: checkSettings(request.settings, true),
        connect: request.connect === true,
        device: deviceOf(request.device),
      };
    case 'modify':
      return { action: 'modify', uuid: uuidOf(request.uuid), settings: checkSettings(request.settings, false) };
    case 'wifi':
      if (typeof request.enabled !== 'boolean') {
        throw new Error('Wi-Fi on or off?');
      }
      return { action: 'wifi', enabled: request.enabled };
    case 'rescan':
      return { action: 'rescan', device: deviceOf(request.device) };
    default:
      throw new Error(`Unknown network action "${String(request.action)}"`);
  }
}
