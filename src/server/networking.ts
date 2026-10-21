// The robot's networks for the Networking widgets, through NetworkManager's
// nmcli: its interfaces, the connections saved and the Wi-Fi networks in
// range, followed for every page at once (read again as soon as nmcli
// monitor reports a change, and every few seconds for the signals), and the
// pages' changes: connections activated and deactivated, made, changed and
// deleted, access points started, Wi-Fi turned on and off. What is being
// done is part of the state: every page shows it, the one that asked
// included, which may have lost the robot meanwhile (it switched networks).
//
// The server's user needs the right to manage NetworkManager, e.g. a polkit
// rule (see the README); without it the actions fail, with nmcli's reason,
// and the state says what is not allowed.

import { execFile, spawn, type ChildProcess } from 'node:child_process';

import {
  needsPassword,
  passwordProblem,
  settingsOf,
  type NetworkActivity,
  type NetworkConnection,
  type NetworkPermissions,
  type NetworkRequest,
  type NetworkResult,
  type NetworkSecrets,
  type NetworkState,
} from '../shared/networking.ts';
import {
  CONNECTION_FIELDS,
  CONNECTION_SETTINGS,
  connectionUuids,
  createArgs,
  DEVICE_SECTIONS,
  GENERAL_FIELDS,
  keyManagementSecurity,
  modification,
  nmcliProblem,
  parseConnections,
  parseDevices,
  parseGeneral,
  parsePermissions,
  parseWifiList,
  passwordArgs,
  settingsBlocks,
  terseBlocks,
  WIFI_FIELDS,
} from './networking_format.ts';
import { errorMessage, type Logger } from './util.ts';

// How often the state is read while pages follow it: the signals of the
// networks in range change without nmcli monitor saying so
const POLL_PERIOD_MS = 3000;
// The connections' settings change when changed (and monitor says so): read
// again at most this often otherwise
const SETTINGS_PERIOD_MS = 30_000;
const PERMISSIONS_PERIOD_MS = 60_000;
// nmcli monitor reports a change in bursts of lines
const MONITOR_DEBOUNCE_MS = 250;
const MONITOR_RETRY_MS = 5000;
// How long NetworkManager is given to activate a connection: DHCP alone may
// take 45 s
const ACTIVATION_WAIT_S = 60;
// A page opening the widget scans for networks if the last scan is older
const SCAN_AGE_MS = 30_000;
// The scan's results come in the next seconds
const SCAN_MS = 5000;
// What was done, shown that long
const ACTIVITY_KEPT_MS = 10 * 60_000;
const ACTIVITY_LIMIT = 20;
// Untranslated, as the parsers read it, and in UTF-8: the names of networks
const ENV = { ...process.env, LC_ALL: 'C.UTF-8', LANGUAGE: '' };

const NO_PERMISSIONS: NetworkPermissions = { control: false, modify: false, wifi: false, scan: false, share: false };

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  // Not run: nmcli is not installed
  missing: boolean;
}

function nmcli(args: string[], timeout = 10_000): Promise<Result> {
  return new Promise((resolve) => {
    execFile('nmcli', args, { timeout, maxBuffer: 8 * 1024 * 1024, env: ENV }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr: stderr || (error && !stdout ? error.message : ''),
        missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT',
      }),
    );
  });
}

// Runs nmcli for an action: throws its reason. Never says the arguments,
// which may be secrets.
async function run(args: string[], timeout?: number): Promise<string> {
  const result = await nmcli(args, timeout);
  if (result.missing) {
    throw new Error('nmcli is not installed: the Networking widget needs NetworkManager');
  }
  if (result.code !== 0) {
    throw new Error(nmcliProblem(result.stderr || result.stdout, `nmcli failed (${result.code})`));
  }
  return result.stdout;
}

function activate(uuid: string, device: string | null): Promise<string> {
  return run(
    ['--wait', String(ACTIVATION_WAIT_S), 'connection', 'up', 'uuid', uuid, ...(device ? ['ifname', device] : [])],
    (ACTIVATION_WAIT_S + 10) * 1000,
  );
}

function emptyState(error: string, activity: NetworkActivity[]): NetworkState {
  return {
    error,
    version: '',
    state: '',
    connectivity: '',
    wifi: false,
    wifiHardware: false,
    permissions: NO_PERMISSIONS,
    devices: [],
    connections: [],
    networks: [],
    scanning: false,
    activity,
  };
}

// For the messages: the network's name if it has one
function nameOf(connection: NetworkConnection): string {
  return connection.kind === 'wifi' && connection.ssid ? connection.ssid : connection.name;
}

type NetworkListener = (state: NetworkState) => void;

export class Networking {
  private readonly logger: Logger;
  private readonly listeners = new Set<NetworkListener>();
  private latest: NetworkState | null = null;
  private latestJson = '';
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private again = false;
  private monitor: ChildProcess | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  // The connections' settings, by uuid, read for the list of uuids key
  private settings = new Map<string, Map<string, string[]>>();
  private settingsKey = '';
  private settingsAt = 0;
  private permissions: NetworkPermissions = NO_PERMISSIONS;
  private permissionsAt = 0;
  private activity: NetworkActivity[] = [];
  private nextActivity = 1;
  private scannedAt = 0;
  // From the scan's request until its results are read
  private scanning = false;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // The networks, whenever they change, until the returned function is
  // called. A page opening the widget looks for networks if the last look
  // is old.
  watch(listener: NetworkListener): () => void {
    this.listeners.add(listener);
    if (this.latest) {
      listener(this.latest);
    }
    if (this.listeners.size === 1) {
      this.startMonitor();
      void this.refresh();
    }
    if (Date.now() - this.scannedAt > SCAN_AGE_MS) {
      void this.rescan(null);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  // Resolves once NetworkManager is done: NetworkResult, or NetworkSecrets.
  // Throws why not. The request is checked (checkRequest).
  async act(request: NetworkRequest): Promise<NetworkResult | NetworkSecrets> {
    switch (request.action) {
      case 'connect': {
        const connection = await this.connection(request.uuid);
        const { password, device } = request;
        if (password !== null) {
          const problem =
            connection.security && needsPassword(connection.security)
              ? passwordProblem(connection.security, password)
              : 'It has no password';
          if (problem) {
            throw new Error(problem);
          }
        }
        const label =
          connection.kind === 'hotspot' ? `Starting the access point ${nameOf(connection)}` : `Connecting to ${nameOf(connection)}`;
        return this.track('connect', label, { uuid: connection.uuid, ssid: connection.ssid || null, device }, async () => {
          if (password !== null) {
            await run(['connection', 'modify', 'uuid', connection.uuid, ...passwordArgs(connection, password)]);
          }
          await activate(connection.uuid, device);
          return { uuid: connection.uuid, message: null };
        });
      }

      case 'disconnect': {
        const connection = await this.connection(request.uuid);
        const label =
          connection.kind === 'hotspot'
            ? `Stopping the access point ${nameOf(connection)}`
            : `Disconnecting from ${nameOf(connection)}`;
        return this.track(
          'disconnect',
          label,
          { uuid: connection.uuid, ssid: connection.ssid || null, device: connection.device },
          async () => {
            await run(['connection', 'down', 'uuid', connection.uuid], 30_000);
            return { uuid: connection.uuid, message: null };
          },
        );
      }

      case 'create': {
        const { settings, connect } = request;
        const device = request.device ?? (settings.kind === 'hotspot' ? settings.interface : null);
        let label = `Saving ${settings.name}`;
        if (settings.kind === 'hotspot') {
          label = connect ? `Starting the access point ${settings.ssid}` : `Saving the access point ${settings.ssid}`;
        } else if (connect) {
          label = settings.kind === 'wifi' ? `Joining ${settings.ssid}` : `Connecting ${settings.name}`;
        }
        return this.track('create', label, { uuid: null, ssid: settings.ssid || null, device }, async (activity) => {
          const added = await run(createArgs(settings));
          // Connection 'Lab' (4e1c…) successfully added.
          const uuid = /\(([0-9a-f-]{36})\)/i.exec(added)?.[1];
          if (!uuid) {
            throw new Error('nmcli did not say which connection it saved');
          }
          activity.uuid = uuid;
          if (!connect) {
            return { uuid, message: null };
          }
          try {
            await activate(uuid, device);
          } catch (e) {
            // A cable's connects once plugged in; a Wi-Fi network's that
            // failed, with a password mistyped, is not kept
            if (settings.kind === 'ethernet') {
              return { uuid, message: `Saved, not connected: ${errorMessage(e)}` };
            }
            await run(['connection', 'delete', 'uuid', uuid]).catch(() => {});
            activity.uuid = null;
            throw e;
          }
          return { uuid, message: null };
        });
      }

      case 'modify': {
        const connection = await this.connection(request.uuid);
        const current = settingsOf(connection);
        const { settings } = request;
        if (!current || current.kind !== settings.kind) {
          throw new Error(`${connection.name} is not changed here: it is not a Wi-Fi network, an access point or a cable's`);
        }
        if (
          settings.kind !== 'ethernet' &&
          settings.security !== current.security &&
          needsPassword(settings.security) &&
          settings.password === null
        ) {
          throw new Error('The network’s password, for its new security');
        }
        const change = modification(connection, settings);
        if (change.args.length === 0) {
          return { uuid: connection.uuid, message: null };
        }
        const active = connection.activeState !== null && change.reactivate;
        return this.track(
          'modify',
          `Saving the changes of ${connection.name}`,
          { uuid: connection.uuid, ssid: connection.ssid || null, device: connection.device },
          async () => {
            await run(['connection', 'modify', 'uuid', connection.uuid, ...change.args]);
            if (active) {
              await activate(connection.uuid, connection.device);
            }
            return { uuid: connection.uuid, message: null };
          },
        );
      }

      case 'delete': {
        const connection = await this.connection(request.uuid);
        return this.track(
          'delete',
          `Forgetting ${connection.name}`,
          { uuid: connection.uuid, ssid: connection.ssid || null, device: connection.device },
          async () => {
            await run(['connection', 'delete', 'uuid', connection.uuid], 30_000);
            return { uuid: null, message: null };
          },
        );
      }

      case 'wifi':
        return this.track('wifi', `Turning Wi-Fi ${request.enabled ? 'on' : 'off'}`, {}, async () => {
          await run(['radio', 'wifi', request.enabled ? 'on' : 'off']);
          return { uuid: null, message: null };
        });

      case 'rescan':
        await this.rescan(request.device);
        return { uuid: null, message: null };

      case 'secrets':
        return this.secrets(await this.connection(request.uuid));
    }
  }

  // The server is shutting down
  stopAll(): void {
    this.listeners.clear();
    this.stop();
  }

  // Of the latest state (read if no page follows it): throws if not known
  private async connection(uuid: string): Promise<NetworkConnection> {
    const state = this.latest ?? (await this.read());
    const connection = state.connections.find((c) => c.uuid === uuid);
    if (!connection) {
      throw new Error('No such connection: it may have been deleted meanwhile');
    }
    return connection;
  }

  private async track(
    action: NetworkActivity['action'],
    label: string,
    target: Partial<Pick<NetworkActivity, 'uuid' | 'ssid' | 'device'>>,
    work: (activity: NetworkActivity) => Promise<NetworkResult>,
  ): Promise<NetworkResult> {
    const activity: NetworkActivity = {
      id: this.nextActivity++,
      action,
      label,
      uuid: target.uuid ?? null,
      ssid: target.ssid ?? null,
      device: target.device ?? null,
      started: Date.now(),
      finished: null,
      error: null,
    };
    this.activity = [activity, ...this.activity];
    this.logger.info(label);
    this.publish();
    try {
      return await work(activity);
    } catch (e) {
      activity.error = errorMessage(e);
      this.logger.warn(`${label}: ${activity.error}`);
      throw e;
    } finally {
      activity.finished = Date.now();
      const now = Date.now();
      this.activity = this.activity
        .filter((a) => a.finished === null || now - a.finished < ACTIVITY_KEPT_MS)
        .slice(0, ACTIVITY_LIMIT);
      this.settingsAt = 0;
      this.publish();
      if (this.listeners.size > 0) {
        void this.refresh();
      }
    }
  }

  private async rescan(device: string | null): Promise<void> {
    if (this.latest && (!this.latest.wifi || this.latest.error)) {
      return;
    }
    this.scannedAt = Date.now();
    this.scanning = true;
    this.setScanning(true);
    // Refused if asked again too soon, or not allowed: the networks known
    // are shown all the same
    const result = await nmcli(['device', 'wifi', 'rescan', ...(device ? ['ifname', device] : [])]);
    if (result.code !== 0 && result.stderr) {
      this.logger.debug(`Wi-Fi scan: ${result.stderr.trim()}`);
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scanning = false;
      this.setScanning(false);
      void this.refresh();
    }, SCAN_MS);
  }

  private setScanning(scanning: boolean): void {
    if (this.latest && this.latest.scanning !== scanning) {
      this.latest = { ...this.latest, scanning };
      this.emit();
    }
  }

  private async secrets(connection: NetworkConnection): Promise<NetworkSecrets> {
    if (connection.kind !== 'wifi' && connection.kind !== 'hotspot') {
      throw new Error(`${connection.name} is not a Wi-Fi network`);
    }
    const output = await run([
      '--show-secrets',
      '-t',
      '-f',
      '802-11-wireless.ssid,802-11-wireless.hidden,802-11-wireless-security.key-mgmt,802-11-wireless-security.psk,802-11-wireless-security.wep-key0,802-1x.password',
      'connection',
      'show',
      'uuid',
      connection.uuid,
    ]);
    const fields = terseBlocks(output)[0] ?? new Map<string, string[]>();
    const field = (key: string) => fields.get(key)?.[0] ?? '';
    const security = keyManagementSecurity(field('802-11-wireless-security.key-mgmt'));
    const password =
      security === 'wpa-eap'
        ? field('802-1x.password')
        : security === 'wep'
          ? field('802-11-wireless-security.wep-key0')
          : field('802-11-wireless-security.psk');
    this.logger.info(`Showing the password of ${connection.name}`);
    return {
      ssid: field('802-11-wireless.ssid') || connection.ssid,
      security,
      // Not readable: nmcli shows <hidden>
      password: password === '<hidden>' ? '' : password,
      hidden: field('802-11-wireless.hidden') === 'yes',
    };
  }

  // The latest state, with what is being done now
  private publish(): void {
    if (this.latest) {
      this.latest = { ...this.latest, activity: this.activity.map((a) => ({ ...a })) };
      this.emit();
    }
  }

  private emit(): void {
    const latest = this.latest;
    if (!latest) {
      return;
    }
    this.latestJson = JSON.stringify(latest);
    this.listeners.forEach((listener) => listener(latest));
  }

  // Now, then every POLL_PERIOD_MS; sent only when something changed
  private async refresh(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reading = true;
    let latest: NetworkState;
    try {
      latest = await this.read();
    } catch (e) {
      latest = emptyState(`Cannot read the networks: ${errorMessage(e)}`, this.activity);
    }
    this.reading = false;
    if (this.listeners.size === 0) {
      return;
    }
    const json = JSON.stringify(latest);
    if (json !== this.latestJson) {
      this.latest = latest;
      this.emit();
    }
    if (this.again) {
      this.again = false;
      void this.refresh();
    } else {
      this.timer = setTimeout(() => void this.refresh(), POLL_PERIOD_MS);
    }
  }

  private async read(): Promise<NetworkState> {
    const activity = this.activity.map((a) => ({ ...a }));
    const general = await nmcli(['-t', '-f', GENERAL_FIELDS, 'general']);
    if (general.missing) {
      return emptyState('nmcli is not installed: the Networking widget needs NetworkManager', activity);
    }
    const status = parseGeneral(general.stdout);
    if (general.code !== 0 || !status.running) {
      const reason = nmcliProblem(general.stderr, 'NetworkManager is not running');
      return emptyState(/not running/i.test(reason) ? 'NetworkManager is not running' : reason, activity);
    }
    const now = Date.now();
    const [devicesRead, listRead, wifiRead, permissionsRead] = await Promise.all([
      nmcli(['-t', '-f', DEVICE_SECTIONS, 'device', 'show']),
      nmcli(['-t', '-f', CONNECTION_FIELDS, 'connection', 'show']),
      status.wifi ? nmcli(['-t', '-f', WIFI_FIELDS, 'device', 'wifi', 'list', '--rescan', 'no']) : null,
      now - this.permissionsAt > PERMISSIONS_PERIOD_MS ? nmcli(['-t', 'general', 'permissions']) : null,
    ]);
    if (permissionsRead?.code === 0) {
      this.permissions = parsePermissions(permissionsRead.stdout);
      this.permissionsAt = now;
    }
    const devices = parseDevices(devicesRead.stdout);
    // The settings of each connection, when the list changes, when monitor
    // says something changed, and every SETTINGS_PERIOD_MS
    const uuids = connectionUuids(listRead.stdout);
    const key = uuids.join(' ');
    if (key !== this.settingsKey || now - this.settingsAt > SETTINGS_PERIOD_MS) {
      const shown =
        uuids.length > 0
          ? await nmcli(['-t', '-f', CONNECTION_SETTINGS, 'connection', 'show', ...uuids.flatMap((uuid) => ['uuid', uuid])])
          : null;
      this.settings = shown ? settingsBlocks(shown.stdout) : new Map();
      this.settingsKey = key;
      // One deleted meanwhile fails the others: read again next time
      this.settingsAt = shown && shown.code !== 0 ? 0 : now;
    }
    return {
      error: null,
      version: status.version,
      state: status.state,
      connectivity: status.connectivity,
      wifi: status.wifi,
      wifiHardware: status.wifiHardware,
      permissions: this.permissions,
      devices,
      connections: parseConnections(listRead.stdout, this.settings, devices),
      networks: wifiRead ? parseWifiList(wifiRead.stdout) : [],
      scanning: this.scanning,
      activity,
    };
  }

  // nmcli monitor: a line whenever NetworkManager's state changes, for the
  // state to be read again at once
  private startMonitor(): void {
    if (this.monitor || this.listeners.size === 0) {
      return;
    }
    const child = spawn('nmcli', ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'], env: ENV });
    this.monitor = child;
    child.stdout?.on('data', () => {
      this.settingsAt = 0;
      if (this.debounce) {
        clearTimeout(this.debounce);
      }
      this.debounce = setTimeout(() => {
        this.debounce = null;
        void this.refresh();
      }, MONITOR_DEBOUNCE_MS);
    });
    // Not installed: the state says so, and it is polled
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.monitor !== child) {
        return;
      }
      this.monitor = null;
      if (this.listeners.size > 0) {
        this.monitorTimer = setTimeout(() => {
          this.monitorTimer = null;
          this.startMonitor();
        }, MONITOR_RETRY_MS);
      }
    });
  }

  private stop(): void {
    for (const timer of [this.timer, this.monitorTimer, this.debounce, this.scanTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.timer = this.monitorTimer = this.debounce = this.scanTimer = null;
    this.scanning = false;
    const monitor = this.monitor;
    this.monitor = null;
    monitor?.kill();
    // Read anew when a page follows them again
    this.latest = null;
    this.latestJson = '';
  }
}
