// What the status widgets show, worked out from the robot's updates: the
// Wi-Fi network joined and its signal, the CPU's load and its last minute,
// a disk's use. Kept apart from the components, to be tested.

import type { FsDisk } from '../../../shared/file_manager.ts';
import {
  DEVICE_ACTIVATED,
  DEVICE_DISCONNECTED,
  type NetworkDevice,
  type NetworkState,
} from '../../../shared/networking.ts';
import type { SystemSample } from '../../../shared/system.ts';
import { counted, formatSize } from '../file_manager/model.ts';
import { bandOf, deviceStatus } from '../networking/model.ts';

// The colour of a reading: see .status-readout in styles.css. off: none to
// show (not read yet, nothing to read)
export type StatusTone = 'ok' | 'warn' | 'critical' | 'off';

export interface WifiReading {
  tone: StatusTone;
  // Of the network joined, 0..100; null if none, or not known (the robot's
  // own access point)
  signal: number | null;
  // 72 %, Off
  value: string;
  // The network's name, or what the interface is doing
  label: string;
  // The details, one per line
  title: string;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

// Below the thresholds (in %), the signal is weak, then too weak
export function signalTone(signal: number, warnBelow: number, criticalBelow: number): StatusTone {
  return signal < criticalBelow ? 'critical' : signal < warnBelow ? 'warn' : 'ok';
}

// The interface shown: the one named, else the one with the default route,
// the first connected, the first
export function wifiDevice(devices: NetworkDevice[], name: string): NetworkDevice | null {
  const wifi = devices.filter((device) => device.type === 'wifi');
  if (name) {
    return wifi.find((device) => device.name === name) ?? null;
  }
  const connected = wifi.filter((device) => device.state === DEVICE_ACTIVATED);
  return connected.find((device) => device.gateway) ?? connected[0] ?? wifi[0] ?? null;
}

export function wifiReading(
  state: (NetworkState & { via: string | null }) | null,
  name: string,
  warnBelow: number,
  criticalBelow: number,
): WifiReading {
  const none = (value: string, label: string, title: string, tone: StatusTone = 'off'): WifiReading => ({
    tone,
    signal: null,
    value,
    label,
    title,
  });
  if (!state) {
    return none('…', 'Wi-Fi', 'Reading the robot’s networks…');
  }
  if (state.error) {
    return none('—', 'No Wi-Fi', state.error);
  }
  const device = wifiDevice(state.devices, name);
  if (!device) {
    return none('—', name || 'No Wi-Fi', name ? `The robot has no Wi-Fi interface ${name}` : 'The robot has no Wi-Fi interface');
  }
  if (!state.wifi) {
    return none('Off', 'Wi-Fi off', state.wifiHardware ? 'Wi-Fi is turned off' : 'Wi-Fi is turned off by its switch');
  }
  const status = deviceStatus(device, state.wifi);
  const through = state.via === device.name ? 'This page reaches the robot through it' : null;
  if (device.state !== DEVICE_ACTIVATED) {
    const connecting = device.state > DEVICE_DISCONNECTED;
    return none(
      connecting ? '…' : '—',
      connecting ? device.connectionName || 'Connecting' : 'Not connected',
      [`${device.name}: ${status.text}`, through].filter(Boolean).join('\n'),
      connecting ? 'warn' : 'critical',
    );
  }
  const connection = state.connections.find((c) => c.uuid === device.connection);
  const address = device.ipv4[0]?.split('/')[0];
  const where = `${device.name}${address ? `: ${address}` : ''}`;
  if (connection?.kind === 'hotspot') {
    const ssid = connection.ssid || connection.name;
    return {
      tone: 'ok',
      signal: null,
      value: 'AP',
      label: ssid,
      title: [`The robot’s access point ${ssid}`, where, through].filter(Boolean).join('\n'),
    };
  }
  const ssid = connection?.ssid || device.connectionName;
  const network =
    state.networks.find((n) => n.device === device.name && n.active) ??
    state.networks.find((n) => n.device === device.name && n.ssid === ssid);
  if (!network) {
    return { tone: 'ok', signal: null, value: '—', label: ssid, title: [ssid, where, through].filter(Boolean).join('\n') };
  }
  const radio = [bandOf(network.frequency), network.channel ? `channel ${network.channel}` : ''].filter(Boolean).join(', ');
  return {
    tone: signalTone(network.signal, warnBelow, criticalBelow),
    signal: network.signal,
    value: percent(network.signal),
    label: network.ssid || ssid,
    title: [
      [network.ssid || ssid, `signal ${percent(network.signal)}`, radio, network.rate].filter(Boolean).join(' · '),
      where,
      through,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

// Above the thresholds (in %), the CPU is busy, then too busy
export function loadTone(share: number, warnAbove: number, criticalAbove: number): StatusTone {
  const value = share * 100;
  return value >= criticalAbove ? 'critical' : value >= warnAbove ? 'warn' : 'ok';
}

// The share shown: of all the cores, or of the busiest (a node that keeps one
// busy, unseen in the total of many)
export function cpuShare(sample: SystemSample, of: 'all' | 'busiest'): number {
  if (of === 'all') {
    return sample.cpu;
  }
  return Math.max(0, ...sample.cores.filter((share): share is number => share !== null));
}

// CPU 23 % of 8 cores · busiest: core 3 at 67 % · load 0.52 0.61 0.70, and
// the processor's name
export function cpuTitle(sample: SystemSample, cpu: string | null): string {
  let online = 0;
  let busiest: { core: number; share: number } | null = null;
  for (const [core, share] of sample.cores.entries()) {
    if (share !== null) {
      online++;
      if (!busiest || share > busiest.share) {
        busiest = { core, share };
      }
    }
  }
  const facts = [
    `CPU ${percent(sample.cpu * 100)} of ${online} ${online === 1 ? 'core' : 'cores'}`,
    busiest && online > 1 ? `busiest: core ${busiest.core} at ${percent(busiest.share * 100)}` : null,
    `load ${sample.load.map((load) => load.toFixed(2)).join(' ')}`,
  ];
  return [facts.filter(Boolean).join(' · '), cpu].filter(Boolean).join('\n');
}

// Of a disk's space, the share used, of what its users may fill (not what is
// kept for root), as the file manager shows it
export function diskShare(disk: FsDisk): number {
  const size = disk.used + disk.free;
  return size > 0 ? disk.used / size : 0;
}

function inodeShare(disk: FsDisk): number {
  return disk.inodes && disk.inodes.total > 0 ? (disk.inodes.total - disk.inodes.free) / disk.inodes.total : 0;
}

// Out of either, no file can be written
function fullness(disk: FsDisk): number {
  return Math.max(diskShare(disk), inodeShare(disk));
}

// The disk shown: the one mounted there, else the fullest of those written
// to (a read-only one is as full as it was made: an image, a CD), else of all
export function diskShown(disks: FsDisk[], mount: string): FsDisk | null {
  if (mount) {
    return disks.find((disk) => disk.mount === mount) ?? null;
  }
  const writable = disks.filter((disk) => !disk.readOnly);
  let fullest: FsDisk | null = null;
  for (const disk of writable.length > 0 ? writable : disks) {
    if (!fullest || fullness(disk) > fullness(fullest)) {
      fullest = disk;
    }
  }
  return fullest;
}

export interface DiskReading {
  tone: StatusTone;
  // Of its space used, 0..1; null if no disk is shown
  share: number | null;
  // 76%, or 120 GB free
  value: string;
  // Its mount point
  label: string;
  // The details, one per line
  title: string;
}

const TONES: StatusTone[] = ['off', 'ok', 'warn', 'critical'];

// The file manager's overview of the disks, in a reading: of the disk mounted
// there ('' the fullest), its share used or its free space; above the
// thresholds (in %) of its space or of its inodes, filling, then full
export function diskReading(
  disks: FsDisk[] | null,
  error: string | null,
  mount: string,
  show: 'used' | 'free',
  warnAbove: number,
  criticalAbove: number,
): DiskReading {
  const none = (value: string, label: string, title: string): DiskReading => ({ tone: 'off', share: null, value, label, title });
  if (!disks) {
    return none(error ? '—' : '…', mount || 'Disk', error ?? 'Reading the robot’s disks…');
  }
  const disk = diskShown(disks, mount);
  if (!disk) {
    return none('—', mount || 'No disk', mount ? `No disk is mounted at ${mount}` : 'The robot’s file systems could not be read');
  }
  const share = diskShare(disk);
  const inodes = disk.inodes && disk.inodes.total > 0 ? disk.inodes : null;
  const inodesTone = inodes ? loadTone(inodeShare(disk), warnAbove, criticalAbove) : 'ok';
  const spaceTone = loadTone(share, warnAbove, criticalAbove);
  const others = mount ? [] : disks.filter((other) => other !== disk);
  return {
    tone: TONES.indexOf(inodesTone) > TONES.indexOf(spaceTone) ? inodesTone : spaceTone,
    share,
    value: show === 'free' ? formatSize(disk.free) : percent(share * 100),
    label: disk.mount,
    title: [
      `${disk.mount}: ${formatSize(disk.free)} free of ${formatSize(disk.total)} · ${formatSize(disk.used)} used, ${percent(share * 100)}`,
      [disk.device, disk.type, disk.readOnly ? 'read-only' : null].filter(Boolean).join(' · '),
      inodes && inodesTone !== 'ok'
        ? `${percent(inodeShare(disk) * 100)} of its inodes used: ${counted(inodes.free, 'file')} more at most`
        : null,
      others.length > 0 ? `The fullest of ${disks.length} disks; the others:` : null,
      ...others.map(
        (other) =>
          `${other.mount}: ${formatSize(other.free)} free, ${percent(diskShare(other) * 100)} used${other.readOnly ? ', read-only' : ''}`,
      ),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export interface ChartPoint {
  at: number;
  value: number;
}

// An SVG path of values 0..1 over the last spanMs to end, in a box of
// width × height; points further apart than gapMs are not joined (sampling
// stopped)
export function sparkline(points: ChartPoint[], end: number, spanMs: number, width: number, height: number, gapMs = 3500): string {
  const x = (at: number) => ((at - (end - spanMs)) / spanMs) * width;
  const y = (value: number) => height - Math.min(1, Math.max(0, value)) * height;
  let path = '';
  let previous: ChartPoint | null = null;
  for (const point of points) {
    if (point.at < end - spanMs - gapMs || point.at > end) {
      continue;
    }
    const joined = previous !== null && point.at - previous.at <= gapMs;
    path += `${joined ? 'L' : 'M'}${x(point.at).toFixed(1)} ${y(point.value).toFixed(1)}`;
    previous = point;
  }
  return path;
}
