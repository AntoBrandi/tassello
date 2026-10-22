// The system monitor's reading of /proc, /sys and of the tools of some boards
// (nvidia-smi, vcgencmd, nvpmodel): see system.ts.

import type { Gpu, Temperature } from '../shared/system.ts';

export interface CpuTimes {
  busy: number;
  total: number;
}

// /proc/stat's cpu lines (user nice system idle iowait irq softirq steal
// guest guest_nice, in ticks): of all the cores, and of each online one by
// its number. Guests' time is in user's already; waiting for I/O is idle.
export function parseCpuTimes(text: string): { all: CpuTimes | null; cores: Map<number, CpuTimes> } {
  let all: CpuTimes | null = null;
  const cores = new Map<number, CpuTimes>();
  for (const line of text.split('\n')) {
    const match = /^cpu(\d*)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const ticks = match[2].trim().split(/\s+/).slice(0, 8).map(Number);
    const total = ticks.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    const times = { busy: total - (ticks[3] || 0) - (ticks[4] || 0), total };
    if (match[1] === '') {
      all = times;
    } else {
      cores.set(Number(match[1]), times);
    }
  }
  return { all, cores };
}

// 0..1, between two readings; null without both
export function busyShare(before: CpuTimes | null | undefined, after: CpuTimes | null | undefined): number | null {
  if (!before || !after) {
    return null;
  }
  const total = after.total - before.total;
  return total > 0 ? Math.min(1, Math.max(0, (after.busy - before.busy) / total)) : 0;
}

// /sys/devices/system/cpu/present: 0-3,6
export function cpuCount(text: string): number {
  let count = 0;
  for (const part of text.trim().split(',')) {
    const [from, to] = part.split('-').map(Number);
    if (Number.isInteger(from)) {
      count += Number.isInteger(to) ? to - from + 1 : 1;
    }
  }
  return count;
}

// /proc/meminfo, in bytes
export function parseMeminfo(text: string): { total: number; used: number; cached: number; swapTotal: number; swapUsed: number } {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (match) {
      values.set(match[1], Number(match[2]) * 1024);
    }
  }
  const get = (key: string) => values.get(key) ?? 0;
  const total = get('MemTotal');
  // Before Linux 3.14: free memory and what can be freed
  const available = values.get('MemAvailable') ?? get('MemFree') + get('Buffers') + get('Cached');
  return {
    total,
    used: Math.max(0, total - available),
    // free's buff/cache
    cached: get('Buffers') + get('Cached') + get('SReclaimable'),
    swapTotal: get('SwapTotal'),
    swapUsed: Math.max(0, get('SwapTotal') - get('SwapFree')),
  };
}

export function parseLoadavg(text: string): [number, number, number] {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  return [one || 0, five || 0, fifteen || 0];
}

// /proc/net/dev: bytes received and sent by each interface
export function parseNetDev(text: string): Map<string, { received: number; sent: number }> {
  const counters = new Map<string, { received: number; sent: number }>();
  for (const line of text.split('\n')) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length >= 9) {
      counters.set(match[1], { received: fields[0], sent: fields[8] });
    }
  }
  return counters;
}

// /proc/diskstats: sectors (of 512 bytes, whatever the disk's) read and
// written, and ms spent doing I/O, by device
export function parseDiskstats(text: string): Map<string, { read: number; written: number; busyMs: number }> {
  const counters = new Map<string, { read: number; written: number; busyMs: number }>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 13) {
      counters.set(fields[2], { read: Number(fields[5]) * 512, written: Number(fields[9]) * 512, busyMs: Number(fields[12]) });
    }
  }
  return counters;
}

// The disks of /sys/block worth showing: not RAM, loop devices, nor those
// made of other disks (device mapper, RAID), whose I/O is theirs; nor an
// eMMC's boot and RPMB areas
export function wholeDisk(name: string): boolean {
  return !/^(loop|ram|zram|dm-|md|sr|fd|nbd)/.test(name) && !/(boot\d+|rpmb)$/.test(name);
}

// Per second, between two readings of a counter; 0 if it went back (an
// interface made again)
export function rate(before: number | undefined, after: number, seconds: number): number {
  return before === undefined || seconds <= 0 || after < before ? 0 : (after - before) / seconds;
}

// Watts of an energy counter (µJ) that wraps at range
export function energyWatts(before: number | undefined, after: number, range: number, seconds: number): number | null {
  if (before === undefined || seconds <= 0) {
    return null;
  }
  const used = after >= before ? after - before : after + range - before;
  return used / 1e6 / seconds;
}

// vcgencmd get_throttled (throttled=0x50005) or the firmware's sysfs file
// (50005), hexadecimal both
export function parseThrottled(text: string): number | null {
  const match = /(?:throttled=)?(?:0x)?([0-9a-f]+)\s*$/i.exec(text.trim());
  return match ? parseInt(match[1], 16) : null;
}

// The fields queried of nvidia-smi, the name last as it may hold commas
export const NVIDIA_QUERY = 'utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr,name';

// nvidia-smi --query-gpu=NVIDIA_QUERY --format=csv,noheader,nounits: one line
// a GPU, [N/A] or [Not Supported] for what it does not know
export function parseNvidiaSmi(text: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of text.split('\n')) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length < 7) {
      continue;
    }
    const number = (index: number) => {
      const value = Number(fields[index]);
      return fields[index] !== '' && Number.isFinite(value) ? value : null;
    };
    const load = number(0);
    const used = number(1);
    const total = number(2);
    gpus.push({
      name: fields.slice(6).join(', '),
      load: load === null ? null : load / 100,
      memoryUsed: used === null ? null : used * 1024 * 1024,
      memoryTotal: total === null ? null : total * 1024 * 1024,
      celsius: number(3),
      watts: number(4),
      mhz: number(5),
    });
  }
  return gpus;
}

// /etc/os-release's PRETTY_NAME
export function parseOsRelease(text: string): string | null {
  const match = /^PRETTY_NAME=(["']?)(.*)\1\s*$/m.exec(text);
  return match ? match[2] : null;
}

// /etc/nv_tegra_release: "# R36 (release), REVISION: 4.3, GCID: ...": R36.4.3
export function parseTegraRelease(text: string): string | null {
  const match = /#\s*R(\d+)\s*\(release\),\s*REVISION:\s*([\d.]+)/.exec(text);
  return match ? `R${match[1]}.${match[2]}` : null;
}

// nvpmodel -q: "NV Power Mode: 15W" then its number
export function parseNvpmodel(text: string): string | null {
  const match = /NV Power Mode:\s*(.+)/.exec(text);
  return match ? match[1].trim() : null;
}

// ARM's cores by implementer and part, as /proc/cpuinfo has them
const ARM_CORES: Record<string, string> = {
  '0x41:0xd03': 'Cortex-A53',
  '0x41:0xd04': 'Cortex-A35',
  '0x41:0xd05': 'Cortex-A55',
  '0x41:0xd07': 'Cortex-A57',
  '0x41:0xd08': 'Cortex-A72',
  '0x41:0xd09': 'Cortex-A73',
  '0x41:0xd0a': 'Cortex-A75',
  '0x41:0xd0b': 'Cortex-A76',
  '0x41:0xd0c': 'Neoverse-N1',
  '0x41:0xd0d': 'Cortex-A77',
  '0x41:0xd41': 'Cortex-A78',
  '0x41:0xd42': 'Cortex-A78AE',
  '0x41:0xd4b': 'Cortex-A78C',
  '0x41:0xd46': 'Cortex-A510',
  '0x41:0xd47': 'Cortex-A710',
  '0x41:0xd80': 'Cortex-A520',
  '0x41:0xd81': 'Cortex-A720',
  '0x4e:0x003': 'NVIDIA Denver 2',
  '0x4e:0x004': 'NVIDIA Carmel',
};

// The processor's name: x86's model name, else ARM's cores (big ones first,
// as listed last)
export function cpuModel(cpuinfo: string): string | null {
  const name = /^model name\s*:\s*(.+)$/m.exec(cpuinfo);
  if (name) {
    return name[1].trim().replace(/\s+/g, ' ');
  }
  const cores: string[] = [];
  let implementer = '';
  for (const line of cpuinfo.split('\n')) {
    const field = /^CPU (implementer|part)\s*:\s*(\S+)/.exec(line);
    if (field?.[1] === 'implementer') {
      implementer = field[2].toLowerCase();
    } else if (field?.[1] === 'part') {
      const core = ARM_CORES[`${implementer}:${field[2].toLowerCase()}`];
      if (core && !cores.includes(core)) {
        cores.unshift(core);
      }
    }
  }
  return cores.length > 0 ? cores.join(' + ') : null;
}

// x86's cpu MHz lines, of each processor in turn: without cpufreq (VMs)
export function cpuinfoMhz(cpuinfo: string): number[] {
  return [...cpuinfo.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((match) => Number(match[1]));
}

// The board's or computer's name: the device tree's (ARM boards), else the
// firmware's (DMI), unless left as its placeholder
export function modelName(deviceTree: string | null, vendor: string | null, product: string | null): string | null {
  const tree = deviceTree?.replace(/\0/g, '').trim();
  if (tree) {
    return tree;
  }
  const filled = (text: string | null) =>
    text && !/to be filled|system product name|system manufacturer|default string|not specified|^o\.?e\.?m/i.test(text) ? text.trim() : '';
  const [maker, name] = [filled(vendor), filled(product)];
  return name ? (maker && !name.startsWith(maker) ? `${maker} ${name}` : name) : maker || null;
}

// Thermal zones whose readings are not temperatures: a Jetson's PMIC's (100
// °C, always), Intel's DPTF placeholder (20 °C)
const NOT_TEMPERATURES = new Set(['PMIC-Die', 'INT3400 Thermal']);

export function isTemperatureZone(type: string): boolean {
  return !NOT_TEMPERATURES.has(type);
}

// A thermal zone's trip points: where it is hot (the first passive or hot
// one), and critical
export function zoneLimits(trips: { type: string; celsius: number }[]): { high: number | null; critical: number | null } {
  const of = (types: string[]) => {
    const found = trips.filter((trip) => types.includes(trip.type)).map((trip) => trip.celsius);
    return found.length > 0 ? Math.min(...found) : null;
  };
  return { high: of(['passive', 'hot']), critical: of(['critical']) };
}

// m°C, as hwmon and thermal zones have them; null if not a plausible reading
export function celsius(milli: number | null): number | null {
  if (milli === null || !Number.isFinite(milli)) {
    return null;
  }
  const value = milli / 1000;
  return value > -60 && value < 250 ? Math.round(value * 10) / 10 : null;
}

// The thermal zones and the hwmon chips' sensors, without the chips that are
// thermal zones (the kernel adds a hwmon chip for some: acpitz, cpu_thermal)
export function mergeTemperatures(zones: Temperature[], chips: Temperature[]): Temperature[] {
  const zoneNames = new Set(zones.map((zone) => zone.sensor.toLowerCase().replace(/-/g, '_')));
  return [...zones, ...chips.filter((sensor) => !zoneNames.has(sensor.sensor.toLowerCase().replace(/-/g, '_')))];
}

// The name of a RAPL domain, as Intel's powercap names them
export function raplName(name: string): string {
  const pkg = /^package-(\d+)$/.exec(name);
  if (pkg) {
    return pkg[1] === '0' ? 'CPU package' : `CPU package ${pkg[1]}`;
  }
  return { core: 'CPU cores', uncore: 'CPU graphics', dram: 'Memory', psys: 'Platform' }[name] ?? name;
}
