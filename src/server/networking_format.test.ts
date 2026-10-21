import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSettings, settingsOf, settingsProblems, type NetworkSettings } from '../shared/networking.ts';
import {
  checkRequest,
  connectionUuids,
  createArgs,
  deviceOfAddress,
  modification,
  nmcliProblem,
  parseConnections,
  parseDevices,
  parseGeneral,
  parsePermissions,
  parseWifiList,
  scanSecurity,
  settingsBlocks,
  terseFields,
} from './networking_format.ts';

const WIFI_UUID = 'b6cc5cf5-e485-48db-a4e8-466ae2bd1a1b';
const AP_UUID = '1a83297e-9ba1-4363-8c1d-9c54d35cd9c0';
const CABLE_UUID = '60ec6c3f-3b87-450d-86b0-e187d2fcf5c2';
const VPN_UUID = '6eddbebd-7f01-473f-ba18-a6ad38f09f2f';
const DOCKER_UUID = '9d1c0c21-cb3a-4780-8052-ccc0f0ea86f2';

// nmcli -t -f DEVICE_SECTIONS device show, abridged
const DEVICES = [
  'GENERAL.DEVICE:wlan0',
  'GENERAL.TYPE:wifi',
  'GENERAL.VENDOR:Intel Corporation',
  'GENERAL.PRODUCT:',
  'GENERAL.DRIVER:iwlwifi',
  'GENERAL.HWADDR:E0:2E:0B:35:42:29',
  'GENERAL.MTU:1500',
  'GENERAL.STATE:100 (connected)',
  'GENERAL.REASON:0 (No reason given)',
  'GENERAL.IS-SOFTWARE:no',
  `GENERAL.CONNECTION:Lab: 2nd floor`,
  `GENERAL.CON-UUID:${WIFI_UUID}`,
  'CAPABILITIES.SPEED:458 Mb/s',
  'WIFI-PROPERTIES.AP:yes',
  'WIFI-PROPERTIES.2GHZ:yes',
  'WIFI-PROPERTIES.5GHZ:yes',
  'IP4.ADDRESS[1]:192.168.91.166/24',
  'IP4.GATEWAY:192.168.91.1',
  'IP4.ROUTE[1]:dst = 0.0.0.0/0, nh = 192.168.91.1, mt = 600',
  'IP4.DNS[1]:10.96.0.7',
  'IP4.DNS[2]:10.96.0.8',
  'IP6.ADDRESS[1]:fe80::6cfc:cbd2:84f6:e729/64',
  'IP6.GATEWAY:',
  '',
  'GENERAL.DEVICE:eth0',
  'GENERAL.TYPE:ethernet',
  'GENERAL.HWADDR:64:4E:D7:0A:DA:7F',
  'GENERAL.MTU:1500',
  'GENERAL.STATE:20 (unavailable)',
  'GENERAL.REASON:40 (Carrier/link changed)',
  'GENERAL.IS-SOFTWARE:no',
  'GENERAL.CONNECTION:',
  'GENERAL.CON-UUID:',
  'CAPABILITIES.SPEED:unknown',
  'WIRED-PROPERTIES.CARRIER:off',
  'IP4.GATEWAY:',
  '',
  'GENERAL.DEVICE:docker0',
  'GENERAL.TYPE:bridge',
  'GENERAL.STATE:100 (connected (externally))',
  'GENERAL.REASON:0 (No reason given)',
  'GENERAL.IS-SOFTWARE:yes',
  'GENERAL.CONNECTION:docker0',
  `GENERAL.CON-UUID:${DOCKER_UUID}`,
  'IP4.ADDRESS[1]:172.17.0.1/16',
  '',
  'GENERAL.DEVICE:lo',
  'GENERAL.TYPE:loopback',
  'GENERAL.STATE:10 (unmanaged)',
  'GENERAL.REASON:0 (No reason given)',
  'IP4.ADDRESS[1]:127.0.0.1/8',
  '',
].join('\n');

// nmcli -t -f CONNECTION_FIELDS connection show: newer nmcli says wifi and
// ethernet, older ones 802-11-wireless and 802-3-ethernet
const LIST = [
  `Lab\\: 2nd floor:${WIFI_UUID}:802-11-wireless:1792571255:yes:5:no:wlan0:yes:activated:/etc/NetworkManager/system-connections/Lab.nmconnection`,
  `Robot:${AP_UUID}:wifi:0:no:0:no::no::/etc/NetworkManager/system-connections/Robot.nmconnection`,
  `lidar:${CABLE_UUID}:ethernet:1751296063:yes:0:no::no::/run/NetworkManager/system-connections/netplan-eth0.nmconnection`,
  `Office VPN:${VPN_UUID}:vpn:0:no:0:no:wlan0:yes:activating:/etc/NetworkManager/system-connections/Office VPN.nmconnection`,
  `docker0:${DOCKER_UUID}:bridge:1792571255:no:0:no:docker0:yes:activated:/run/NetworkManager/system-connections/docker0.nmconnection`,
  '',
].join('\n');

// nmcli -t -f CONNECTION_SETTINGS connection show uuid ...
const SETTINGS = [
  'connection.id:Lab: 2nd floor',
  `connection.uuid:${WIFI_UUID}`,
  'connection.type:802-11-wireless',
  'connection.interface-name:',
  'connection.autoconnect:yes',
  'connection.autoconnect-priority:5',
  '802-11-wireless.ssid:Lab',
  '802-11-wireless.mode:infrastructure',
  '802-11-wireless.band:',
  '802-11-wireless.channel:0',
  '802-11-wireless.hidden:no',
  '802-11-wireless-security.key-mgmt:wpa-psk',
  'ipv4.method:auto',
  'ipv4.addresses:',
  'ipv4.gateway:',
  'ipv4.dns:',
  '',
  'connection.id:Robot',
  `connection.uuid:${AP_UUID}`,
  'connection.type:802-11-wireless',
  'connection.interface-name:wlan0',
  'connection.autoconnect:no',
  'connection.autoconnect-priority:0',
  '802-11-wireless.ssid:Robot',
  '802-11-wireless.mode:ap',
  '802-11-wireless.band:bg',
  '802-11-wireless.channel:6',
  '802-11-wireless.hidden:no',
  '802-11-wireless-security.key-mgmt:wpa-psk',
  'ipv4.method:shared',
  'ipv4.addresses:10.42.0.1/24',
  'ipv4.gateway:',
  'ipv4.dns:',
  '',
  'connection.id:lidar',
  `connection.uuid:${CABLE_UUID}`,
  'connection.type:802-3-ethernet',
  'connection.interface-name:eth0',
  'connection.autoconnect:yes',
  'connection.autoconnect-priority:0',
  'ipv4.method:manual',
  'ipv4.addresses:192.168.1.20/24, 192.168.2.20/24',
  'ipv4.gateway:192.168.1.1',
  'ipv4.dns:8.8.8.8,1.1.1.1',
  '',
  'connection.id:Office VPN',
  `connection.uuid:${VPN_UUID}`,
  'connection.type:vpn',
  'connection.autoconnect:no',
  'vpn.service-type:org.freedesktop.NetworkManager.openvpn',
  'ipv4.method:auto',
  '',
].join('\n');

function connections() {
  const devices = parseDevices(DEVICES);
  return parseConnections(LIST, settingsBlocks(SETTINGS), devices);
}

test('terse fields are split on the colons not escaped', () => {
  assert.deepEqual(terseFields('Lab\\: 2nd floor:D0\\:21\\:F9:back\\\\slash:'), ['Lab: 2nd floor', 'D0:21:F9', 'back\\slash', '']);
  assert.deepEqual(terseFields(''), ['']);
});

test('the general state and the permissions', () => {
  assert.deepEqual(parseGeneral('running:1.36.6:connected:full:enabled:enabled:disabled\n'), {
    running: true,
    version: '1.36.6',
    state: 'connected',
    connectivity: 'full',
    networking: true,
    wifiHardware: true,
    wifi: false,
  });
  assert.equal(parseGeneral('').running, false);
  const permissions = [
    'org.freedesktop.NetworkManager.network-control:yes',
    'org.freedesktop.NetworkManager.settings.modify.system:auth',
    'org.freedesktop.NetworkManager.enable-disable-wifi:yes',
    'org.freedesktop.NetworkManager.wifi.scan:no',
    'org.freedesktop.NetworkManager.wifi.share.protected:yes',
  ].join('\n');
  assert.deepEqual(parsePermissions(permissions), { control: true, modify: false, wifi: true, scan: false, share: true });
});

test('devices: their state, connection, addresses and abilities', () => {
  const [wifi, cable, docker, lo] = parseDevices(DEVICES);
  assert.equal(wifi.name, 'wlan0');
  assert.equal(wifi.state, 100);
  assert.equal(wifi.stateText, 'connected');
  assert.equal(wifi.reason, '');
  assert.equal(wifi.connection, WIFI_UUID);
  assert.equal(wifi.connectionName, 'Lab: 2nd floor');
  assert.equal(wifi.hwaddr, 'E0:2E:0B:35:42:29');
  assert.deepEqual(wifi.ipv4, ['192.168.91.166/24']);
  assert.deepEqual(wifi.dns, ['10.96.0.7', '10.96.0.8']);
  assert.equal(wifi.gateway, '192.168.91.1');
  assert.equal(wifi.carrier, null);
  assert.ok(wifi.accessPoint && wifi.band24 && wifi.band5);
  assert.equal(wifi.speed, '458 Mb/s');

  assert.equal(cable.state, 20);
  assert.equal(cable.reason, 'Carrier/link changed');
  assert.equal(cable.carrier, false);
  assert.equal(cable.connection, null);
  assert.equal(cable.speed, '');
  assert.deepEqual(cable.ipv4, []);

  assert.ok(docker.external && docker.software);
  assert.equal(docker.stateText, 'connected (externally)');
  assert.equal(lo.state, 10);
});

test('connections: their kind, state and settings', () => {
  const [wifi, ap, cable, vpn, docker] = connections();
  assert.equal(wifi.name, 'Lab: 2nd floor');
  assert.equal(wifi.kind, 'wifi');
  assert.equal(wifi.ssid, 'Lab');
  assert.equal(wifi.security, 'wpa-psk');
  assert.equal(wifi.device, 'wlan0');
  assert.equal(wifi.activeState, 'activated');
  assert.equal(wifi.priority, 5);
  assert.equal(wifi.lastUsed, 1792571255000);

  assert.equal(ap.type, '802-11-wireless');
  assert.equal(ap.kind, 'hotspot');
  assert.equal(ap.band, 'bg');
  assert.equal(ap.channel, 6);
  assert.equal(ap.ipv4Method, 'shared');
  assert.deepEqual(ap.addresses, ['10.42.0.1/24']);
  assert.equal(ap.device, null);
  assert.equal(ap.activeState, null);
  assert.equal(ap.lastUsed, null);
  assert.equal(ap.autoconnect, false);

  assert.equal(cable.type, '802-3-ethernet');
  assert.equal(cable.kind, 'ethernet');
  assert.equal(cable.security, null);
  assert.deepEqual(cable.addresses, ['192.168.1.20/24', '192.168.2.20/24']);
  assert.deepEqual(cable.dns, ['8.8.8.8', '1.1.1.1']);
  assert.equal(cable.gateway, '192.168.1.1');
  assert.equal(cable.interface, 'eth0');

  assert.equal(vpn.kind, 'vpn');
  assert.equal(vpn.vpnService, 'openvpn');
  assert.equal(vpn.activeState, 'activating');

  assert.equal(docker.kind, 'other');
  assert.ok(docker.external);
  assert.ok(!wifi.external);

  assert.deepEqual(connectionUuids(LIST), [WIFI_UUID, AP_UUID, CABLE_UUID, VPN_UUID, DOCKER_UUID]);
});

test('Wi-Fi networks: by name, the strongest or the one connected to standing for the others', () => {
  const lab = Buffer.from('Lab: 2nd floor').toString('hex').toUpperCase();
  const cafe = Buffer.from('Café').toString('hex').toUpperCase();
  const output = [
    `Lab\\: 2nd floor:${lab}:D0\\:21\\:F9\\:CC\\:CC\\:69:Infra:44:5220 MHz:540 Mbit/s:57:WPA2:wlan0:no`,
    `Lab\\: 2nd floor:${lab}:D0\\:21\\:F9\\:CC\\:CC\\:70:Infra:1:2412 MHz:130 Mbit/s:80:WPA2:wlan0:no`,
    `Lab\\: 2nd floor:${lab}:D0\\:21\\:F9\\:CC\\:CC\\:71:Infra:11:2462 MHz:130 Mbit/s:40:WPA2:wlan0:yes`,
    `Caf?:${cafe}:AA\\:BB\\:CC\\:DD\\:EE\\:01:Infra:6:2437 MHz:54 Mbit/s:90::wlan0:no`,
    `::AA\\:BB\\:CC\\:DD\\:EE\\:02:Infra:6:2437 MHz:54 Mbit/s:95:WPA2:wlan0:no`,
    `Guest:4775657374:AA\\:BB\\:CC\\:DD\\:EE\\:03:Infra:36:5180 MHz:270 Mbit/s:30:WPA2 802.1X:wlan1:no`,
    '',
  ].join('\n');
  const networks = parseWifiList(output);
  assert.deepEqual(
    networks.map((n) => [n.device, n.ssid, n.signal, n.active, n.points]),
    [
      ['wlan0', 'Lab: 2nd floor', 40, true, 3],
      ['wlan0', 'Café', 90, false, 1],
      ['wlan1', 'Guest', 30, false, 1],
    ],
  );
  const [lab0, cafe0, guest] = networks;
  assert.equal(lab0.bssid, 'D0:21:F9:CC:CC:71');
  assert.equal(lab0.frequency, 2462);
  assert.equal(lab0.security, 'wpa-psk');
  assert.equal(cafe0.security, 'open');
  assert.equal(cafe0.securityText, '');
  assert.equal(guest.security, 'wpa-eap');
});

test('the security of networks in range', () => {
  assert.equal(scanSecurity(''), 'open');
  assert.equal(scanSecurity('--'), 'open');
  assert.equal(scanSecurity('WEP'), 'wep');
  assert.equal(scanSecurity('WPA1 WPA2'), 'wpa-psk');
  assert.equal(scanSecurity('WPA2 WPA3'), 'wpa-psk');
  assert.equal(scanSecurity('WPA3'), 'sae');
  assert.equal(scanSecurity('WPA2 802.1X'), 'wpa-eap');
  assert.equal(scanSecurity('WPA3 802.1X'), 'wpa-eap');
  assert.equal(scanSecurity('OWE'), 'owe');
});

test('the interface a page comes through, from the address it reached', () => {
  const devices = parseDevices(DEVICES);
  assert.equal(deviceOfAddress(devices, '::ffff:192.168.91.166'), 'wlan0');
  assert.equal(deviceOfAddress(devices, '192.168.91.166'), 'wlan0');
  assert.equal(deviceOfAddress(devices, 'fe80::6cfc:cbd2:84f6:e729%wlan0'), 'wlan0');
  assert.equal(deviceOfAddress(devices, '172.17.0.1'), 'docker0');
  assert.equal(deviceOfAddress(devices, '127.0.0.1'), null);
  assert.equal(deviceOfAddress(devices, '::1'), null);
  assert.equal(deviceOfAddress(devices, '10.0.0.9'), null);
  assert.equal(deviceOfAddress(devices, null), null);
});

test('what nmcli said went wrong, for the page', () => {
  const hint = "Hint: use 'journalctl -xe NM_CONNECTION=x + NM_DEVICE=wlan0' to get more details.";
  assert.equal(
    nmcliProblem(`Error: Connection activation failed: (7) Secrets were required, but not provided.\n${hint}\n`, 'x'),
    'Wrong password, or none given',
  );
  assert.equal(
    nmcliProblem('Error: Connection activation failed: The Wi-Fi network could not be found\n', 'x'),
    'The network is not in range',
  );
  assert.match(nmcliProblem('Error: Not authorized to control networking.', 'x'), /^Not authorized to control networking: .*polkit/);
  assert.equal(
    nmcliProblem('Error: Connection activation failed: No suitable device found for this connection.\n', 'x'),
    'No suitable device found for this connection',
  );
  assert.equal(nmcliProblem('\n', 'nmcli failed (1)'), 'nmcli failed (1)');
});

function settings(kind: NetworkSettings['kind'], changes: Partial<NetworkSettings>): NetworkSettings {
  return { ...defaultSettings(kind), ...changes };
}

test('a Wi-Fi network, an access point and a cable, as nmcli connection add makes them', () => {
  assert.deepEqual(createArgs(settings('wifi', { name: 'Lab', ssid: 'Lab', password: 'secret123' })), [
    'connection', 'add', 'type', 'wifi', 'con-name', 'Lab',
    'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '0',
    '802-11-wireless.ssid', 'Lab', '802-11-wireless.hidden', 'no',
    '802-11-wireless-security.key-mgmt', 'wpa-psk', '802-11-wireless-security.psk', 'secret123',
    'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '',
  ]);
  const ap = createArgs(
    settings('hotspot', {
      name: 'Robot',
      interface: 'wlan0',
      ssid: 'Robot',
      password: 'secret123',
      band: 'a',
      channel: 36,
      addresses: ['192.168.4.1/24'],
      autoconnect: false,
    }),
  );
  assert.deepEqual(ap.slice(0, 8), ['connection', 'add', 'type', 'wifi', 'con-name', 'Robot', 'connection.interface-name', 'wlan0']);
  const pairs = new Map<string, string>();
  for (let i = 6; i < ap.length; i += 2) {
    pairs.set(ap[i], ap[i + 1]);
  }
  assert.equal(pairs.get('802-11-wireless.mode'), 'ap');
  assert.equal(pairs.get('802-11-wireless.band'), 'a');
  assert.equal(pairs.get('802-11-wireless.channel'), '36');
  assert.equal(pairs.get('802-11-wireless-security.proto'), 'rsn');
  assert.equal(pairs.get('802-11-wireless-security.pairwise'), 'ccmp');
  assert.equal(pairs.get('ipv4.method'), 'shared');
  assert.equal(pairs.get('ipv4.addresses'), '192.168.4.1/24');
  assert.equal(pairs.get('ipv6.method'), 'ignore');
  assert.equal(pairs.get('connection.autoconnect'), 'no');

  const cable = createArgs(
    settings('ethernet', {
      name: 'lidar',
      interface: 'eth1',
      ipv4: 'manual',
      addresses: ['192.168.1.20/24'],
      gateway: '192.168.1.1',
      dns: ['8.8.8.8'],
    }),
  );
  assert.deepEqual(cable, [
    'connection', 'add', 'type', 'ethernet', 'con-name', 'lidar', 'connection.interface-name', 'eth1',
    'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '0',
    'ipv4.method', 'manual', 'ipv4.addresses', '192.168.1.20/24', 'ipv4.gateway', '192.168.1.1', 'ipv4.dns', '8.8.8.8',
  ]);

  const enterprise = createArgs(
    settings('wifi', { name: 'Campus', ssid: 'Campus', security: 'wpa-eap', identity: ' ada ', password: 'pw' }),
  );
  assert.ok(enterprise.join(' ').includes('802-1x.eap peap 802-1x.phase2-auth mschapv2 802-1x.identity ada 802-1x.password pw'));
});

test('changes: only what differs, activated again unless only the name, autoconnect or priority', () => {
  const [wifi, , cable] = connections();
  const current = settingsOf(wifi)!;
  assert.deepEqual(modification(wifi, current), { args: [], reactivate: false });

  const renamed = modification(wifi, { ...current, name: 'Lab', autoconnect: false, priority: 10 });
  assert.deepEqual(renamed.args, [
    'connection.id', 'Lab', 'connection.autoconnect', 'no', 'connection.autoconnect-priority', '10',
  ]);
  assert.equal(renamed.reactivate, false);

  const password = modification(wifi, { ...current, password: 'another123' });
  assert.deepEqual(password.args, [
    '802-11-wireless-security.key-mgmt', 'wpa-psk', '802-11-wireless-security.psk', 'another123',
  ]);
  assert.equal(password.reactivate, true);

  const open = modification(wifi, { ...current, security: 'open' });
  assert.deepEqual(open, { args: ['remove', '802-11-wireless-security'], reactivate: true });

  // Enterprise to open, or to a password: in one call, NetworkManager
  // refusing a security half changed
  const enterprise = { ...wifi, security: 'wpa-eap' as const, identity: 'ada' };
  assert.deepEqual(modification(enterprise, { ...settingsOf(enterprise)!, security: 'open', identity: '' }).args, [
    'remove', '802-1x', 'remove', '802-11-wireless-security',
  ]);
  assert.deepEqual(
    modification(enterprise, { ...settingsOf(enterprise)!, security: 'wpa-psk', password: 'secret123' }).args,
    ['remove', '802-1x', '802-11-wireless-security.key-mgmt', 'wpa-psk', '802-11-wireless-security.psk', 'secret123'],
  );

  const dhcp = modification(cable, { ...settingsOf(cable)!, ipv4: 'auto', addresses: [], gateway: '', dns: [] });
  assert.deepEqual(dhcp.args, ['ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']);
  assert.equal(dhcp.reactivate, true);
});

test('the settings typed are checked', () => {
  const wifi = settings('wifi', { name: 'Lab', ssid: 'Lab', password: 'short' });
  assert.match(settingsProblems(wifi, true).password ?? '', /8 to 63/);
  assert.deepEqual(settingsProblems({ ...wifi, password: 'long enough' }, true), {});
  assert.deepEqual(settingsProblems({ ...wifi, password: 'a'.repeat(64).replace(/a/g, 'f') }, true), {});
  assert.match(settingsProblems({ ...wifi, password: null }, true).password ?? '', /password/);
  assert.deepEqual(settingsProblems({ ...wifi, password: null }, false), {});
  assert.match(settingsProblems({ ...wifi, ssid: 'é'.repeat(17), password: 'long enough' }, true).ssid ?? '', /32 bytes/);

  const ap = settings('hotspot', { name: 'Robot', ssid: 'Robot', password: 'secret123' });
  assert.match(settingsProblems(ap, true).interface ?? '', /Wi-Fi interface/);
  assert.match(settingsProblems({ ...ap, interface: 'wlan0', security: 'sae' }, true).security ?? '', /WPA2/);
  assert.match(settingsProblems({ ...ap, interface: 'wlan0', band: 'bg', channel: 36 }, true).channel ?? '', /2\.4 GHz/);
  assert.deepEqual(settingsProblems({ ...ap, interface: 'wlan0', band: 'a', channel: 36 }, true), {});

  const cable = settings('ethernet', { name: 'lidar', ipv4: 'manual' });
  assert.match(settingsProblems(cable, true).addresses ?? '', /192\.168\.1\.20\/24/);
  assert.match(settingsProblems({ ...cable, addresses: ['192.168.1.20'] }, true).addresses ?? '', /\/24/);
  assert.match(settingsProblems({ ...cable, addresses: ['192.168.1.300/24'] }, true).addresses ?? '', /not an IPv4/);
  assert.match(settingsProblems({ ...cable, addresses: ['192.168.1.20/24'], gateway: 'router' }, true).gateway ?? '', /router/);
  assert.match(settingsProblems({ ...cable, addresses: ['192.168.1.20/24'], dns: ['1.1.1.1', 'x'] }, true).dns ?? '', /“x”/);
  assert.deepEqual(settingsProblems({ ...cable, addresses: ['192.168.1.20/24'], dns: ['2001:4860:4860::8888'] }, true), {});
  assert.match(settingsProblems({ ...cable, interface: 'eth0; reboot' }, true).interface ?? '', /not an interface/);
});

test('the requests of the pages are checked', () => {
  assert.deepEqual(checkRequest({ action: 'connect', uuid: WIFI_UUID.toUpperCase(), device: 'wlan0' }), {
    action: 'connect',
    uuid: WIFI_UUID,
    device: 'wlan0',
    password: null,
  });
  assert.deepEqual(checkRequest({ action: 'rescan' }), { action: 'rescan', device: null });
  assert.throws(() => checkRequest({ action: 'connect', uuid: 'Lab' }), /Invalid connection/);
  assert.throws(() => checkRequest({ action: 'connect', uuid: WIFI_UUID, device: '-wlan0 --help x' }), /Invalid interface/);
  assert.throws(() => checkRequest({ action: 'wifi', enabled: 'off' }));
  assert.throws(() => checkRequest({ action: 'reboot' }), /Unknown/);
  assert.throws(() => checkRequest(null), /Unknown/);

  const create = { action: 'create', connect: true, settings: { ...settings('wifi', { name: 'Lab', ssid: 'Lab', password: 'short' }) } };
  assert.throws(() => checkRequest(create), /8 to 63/);
  // A cable's: no Wi-Fi settings, whatever the page sent
  const cable = checkRequest({
    action: 'create',
    connect: false,
    settings: { ...settings('ethernet', { name: ' lidar ' }), ssid: 'x', security: 'wpa-psk', password: 'x' },
  });
  assert.equal(cable.action, 'create');
  if (cable.action === 'create') {
    assert.equal(cable.settings.name, 'lidar');
    assert.equal(cable.settings.ssid, '');
    assert.equal(cable.settings.security, 'open');
    assert.equal(cable.settings.password, null);
  }
  // Types the page cannot get wrong
  assert.throws(() => checkRequest({ action: 'create', settings: { ...settings('wifi', {}), priority: '1' } }));
  assert.throws(() => checkRequest({ action: 'create', settings: { ...settings('wifi', {}), kind: 'bridge' } }), /kind/);
});
