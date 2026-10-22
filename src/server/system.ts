// The robot's computer, as top, free, sensors, iotop and a Jetson's jtop see
// it: read of /proc and /sys every second while a page watches it, and kept
// for the last minutes, the charts' history (see src/shared/system.ts).
//
// The sensors are those the kernel has: hwmon chips and thermal zones
// (temperatures, fans, power rails: a Jetson's INA3221), Intel's RAPL when
// readable, devfreq's GPUs (a Jetson's), amdgpu's; and those of tools when
// there: nvidia-smi, a Raspberry Pi's vcgencmd (if its firmware's
// get_throttled is not in /sys), a Jetson's nvpmodel.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FsDisk } from '../shared/file_manager.ts';
import type { SystemUpdate } from '../shared/protocol.ts';
import { trendPoint, type Fan, type Gpu, type PowerRail, type SystemInfo, type SystemSample, type Temperature, type TrendPoint } from '../shared/system.ts';
import { listDisks } from './disks.ts';
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
  NVIDIA_QUERY,
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
  type CpuTimes,
} from './system_format.ts';
import { errorMessage, type Logger } from './util.ts';

const PERIOD_MS = 1000;
const HISTORY_MS = 5 * 60_000;
// The sensors are looked for again this often: USB ones come and go
const DISCOVER_MS = 30_000;
// After the last page left, sampling goes on this long, for one reloading
const LINGER_MS = 30_000;
const SPACE_MS = 10_000;
// nvidia-smi takes tens of ms: run this often
const NVIDIA_MS = 2000;
const VCGENCMD_MS = 5000;
// A Jetson's power mode changes by hand, rarely
const INFO_MS = 60_000;
const TOOL_TIMEOUT_MS = 5000;

// The names devfreq's integrated GPUs have in a Jetson's device tree
const TEGRA_GPUS = new Set(['gk20a', 'gm20b', 'gp10b', 'gv11b', 'ga10b', 'gb10b', 'gpu']);

export type SystemUpdateBody = Omit<SystemUpdate, 'type' | 'id'>;

type Listener = (update: SystemUpdateBody) => void;

interface Chip {
  name: string;
  temperatures: { input: string; label: string | null; high: number | null; critical: number | null }[];
  fans: { input: string; label: string | null }[];
  power: { input: string; label: string | null }[];
  // INA3221's channels: mV and mA
  rails: { label: string; volts: string; amps: string }[];
  // A Raspberry Pi's rpi_volt: under-voltage now
  underVoltage: string | null;
}

interface Sensors {
  chips: Chip[];
  zones: { type: string; input: string; high: number | null; critical: number | null }[];
  tegraGpus: { name: string; load: string; frequency: string }[];
  amdGpus: { busy: string; used: string; total: string }[];
  rapl: { name: string; energy: string; range: number }[];
  // A Jetson's on L4T 32: INA3221 by IIO, in mW, mV and mA
  iioRails: { name: string; power: string; volts: string; amps: string }[];
  throttled: string | null;
  disks: string[];
  cpufreq: Map<number, string>;
  nvidia: boolean;
  vcgencmd: boolean;
}

async function text(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function number(file: string): Promise<number | null> {
  const read = await text(file);
  const value = read === null ? NaN : Number(read.trim());
  return Number.isFinite(value) ? value : null;
}

async function list(folder: string): Promise<string[]> {
  try {
    return await fs.readdir(folder);
  } catch {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    );
  });
}

function label(read: string | null): string | null {
  return read?.trim() || null;
}

async function discoverChip(folder: string): Promise<Chip | null> {
  const name = label(await text(path.join(folder, 'name')));
  if (!name) {
    return null;
  }
  const files = await list(folder);
  const file = (name: string) => (files.includes(name) ? path.join(folder, name) : null);
  const chip: Chip = { name, temperatures: [], fans: [], power: [], rails: [], underVoltage: file('in0_lcrit_alarm') };
  for (const entry of files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const [, kind, index] = /^(temp|fan|power|curr)(\d+)_(?:input|average)$/.exec(entry) ?? [];
    const of = (suffix: string) => file(`${kind}${index}_${suffix}`);
    const labelOf = async (prefix = kind) => label(await text(path.join(folder, `${prefix}${index}_label`)));
    if (kind === 'temp') {
      const [high, critical] = await Promise.all([of('max'), of('crit')].map((limit) => (limit ? number(limit) : null)));
      chip.temperatures.push({ input: path.join(folder, entry), label: await labelOf(), high: celsius(high), critical: celsius(critical) });
    } else if (kind === 'fan') {
      chip.fans.push({ input: path.join(folder, entry), label: await labelOf() });
    } else if (kind === 'power' && (entry.endsWith('_input') || !file(`power${index}_input`))) {
      chip.power.push({ input: path.join(folder, entry), label: await labelOf() });
    } else if (kind === 'curr' && file(`in${index}_input`)) {
      chip.rails.push({
        label: (await labelOf('in')) ?? `${name} ${index}`,
        volts: path.join(folder, `in${index}_input`),
        amps: path.join(folder, entry),
      });
    }
  }
  return chip;
}

async function discoverZones(): Promise<Sensors['zones']> {
  const zones: Sensors['zones'] = [];
  for (const entry of await list('/sys/class/thermal')) {
    if (!entry.startsWith('thermal_zone')) {
      continue;
    }
    const folder = path.join('/sys/class/thermal', entry);
    const type = label(await text(path.join(folder, 'type')));
    if (!type || !isTemperatureZone(type)) {
      continue;
    }
    const trips: { type: string; celsius: number }[] = [];
    for (const file of await list(folder)) {
      const trip = /^trip_point_(\d+)_type$/.exec(file);
      if (trip) {
        const [kind, value] = await Promise.all([text(path.join(folder, file)), number(path.join(folder, `trip_point_${trip[1]}_temp`))]);
        const limit = celsius(value);
        if (kind && limit !== null) {
          trips.push({ type: kind.trim(), celsius: limit });
        }
      }
    }
    zones.push({ type, input: path.join(folder, 'temp'), ...zoneLimits(trips) });
  }
  return zones.sort((a, b) => a.input.localeCompare(b.input, undefined, { numeric: true }));
}

async function discoverTegraGpus(): Promise<Sensors['tegraGpus']> {
  const gpus: Sensors['tegraGpus'] = [];
  for (const entry of await list('/sys/class/devfreq')) {
    const folder = path.join('/sys/class/devfreq', entry);
    const node = label((await text(path.join(folder, 'device/of_node/name')))?.replace(/\0/g, '') ?? null);
    if (node && TEGRA_GPUS.has(node) && (await exists(path.join(folder, 'device/load')))) {
      gpus.push({ name: `Integrated GPU (${node})`, load: path.join(folder, 'device/load'), frequency: path.join(folder, 'cur_freq') });
    }
  }
  return gpus;
}

async function discoverAmdGpus(): Promise<Sensors['amdGpus']> {
  const gpus: Sensors['amdGpus'] = [];
  for (const entry of await list('/sys/class/drm')) {
    const device = path.join('/sys/class/drm', entry, 'device');
    if (/^card\d+$/.test(entry) && (await exists(path.join(device, 'gpu_busy_percent')))) {
      gpus.push({
        busy: path.join(device, 'gpu_busy_percent'),
        used: path.join(device, 'mem_info_vram_used'),
        total: path.join(device, 'mem_info_vram_total'),
      });
    }
  }
  return gpus;
}

// Intel's energy counters: root's only, since Linux 5.10, unless allowed
async function discoverRapl(): Promise<Sensors['rapl']> {
  const domains: Sensors['rapl'] = [];
  for (const entry of (await list('/sys/class/powercap')).sort()) {
    const folder = path.join('/sys/class/powercap', entry);
    if (!/^intel-rapl:[\d:]+$/.test(entry) || (await number(path.join(folder, 'energy_uj'))) === null) {
      continue;
    }
    const [name, range] = await Promise.all([text(path.join(folder, 'name')), number(path.join(folder, 'max_energy_range_uj'))]);
    domains.push({ name: raplName(name?.trim() ?? entry), energy: path.join(folder, 'energy_uj'), range: range ?? 2 ** 32 });
  }
  return domains;
}

async function discoverIioRails(): Promise<Sensors['iioRails']> {
  const rails: Sensors['iioRails'] = [];
  const driver = '/sys/bus/i2c/drivers/ina3221x';
  for (const device of await list(driver)) {
    for (const iio of (await list(path.join(driver, device))).filter((entry) => entry.startsWith('iio:device'))) {
      const folder = path.join(driver, device, iio);
      for (const file of await list(folder)) {
        const channel = /^rail_name_(\d+)$/.exec(file)?.[1];
        const name = channel === undefined ? null : label(await text(path.join(folder, file)));
        if (name) {
          rails.push({
            name,
            power: path.join(folder, `in_power${channel}_input`),
            volts: path.join(folder, `in_voltage${channel}_input`),
            amps: path.join(folder, `in_current${channel}_input`),
          });
        }
      }
    }
  }
  return rails;
}

// A Raspberry Pi's firmware's: /sys/devices/platform/soc/soc:firmware, or
// where a Pi 5's device tree puts it
async function discoverThrottled(): Promise<string | null> {
  for (const bus of (await list('/sys/devices/platform')).filter((entry) => /^(soc|axi)/.test(entry))) {
    for (const entry of (await list(path.join('/sys/devices/platform', bus))).filter((name) => name.includes('firmware'))) {
      const file = path.join('/sys/devices/platform', bus, entry, 'get_throttled');
      if (await exists(file)) {
        return file;
      }
    }
  }
  return null;
}

async function discoverCpufreq(cores: number): Promise<Map<number, string>> {
  const files = new Map<number, string>();
  await Promise.all(
    Array.from({ length: cores }, async (_, core) => {
      const file = `/sys/devices/system/cpu/cpu${core}/cpufreq/scaling_cur_freq`;
      if (await exists(file)) {
        files.set(core, file);
      }
    }),
  );
  return files;
}

async function discover(cores: number, raspberryPi: boolean): Promise<Sensors> {
  const chipFolders = (await list('/sys/class/hwmon')).map((entry) => path.join('/sys/class/hwmon', entry));
  const [chips, zones, tegraGpus, amdGpus, rapl, iioRails, throttled, blocks, cpufreq, nvidia] = await Promise.all([
    Promise.all(chipFolders.map(discoverChip)),
    discoverZones(),
    discoverTegraGpus(),
    discoverAmdGpus(),
    discoverRapl(),
    discoverIioRails(),
    discoverThrottled(),
    list('/sys/block'),
    discoverCpufreq(cores),
    run('nvidia-smi', ['-L']).then(
      () => true,
      () => false,
    ),
  ]);
  const vcgencmd =
    raspberryPi && !throttled
      ? await run('vcgencmd', ['version']).then(
          () => true,
          () => false,
        )
      : false;
  return {
    chips: chips.filter((chip) => chip !== null),
    zones,
    tegraGpus,
    amdGpus,
    rapl,
    iioRails,
    throttled,
    disks: blocks.filter(wholeDisk).sort(),
    cpufreq,
    nvidia,
    vcgencmd,
  };
}

async function readInfo(): Promise<SystemInfo> {
  const [deviceTree, vendor, product, cpuinfo, present, osRelease, tegra] = await Promise.all([
    text('/proc/device-tree/model'),
    text('/sys/class/dmi/id/sys_vendor'),
    text('/sys/class/dmi/id/product_name'),
    text('/proc/cpuinfo'),
    text('/sys/devices/system/cpu/present'),
    text('/etc/os-release'),
    text('/etc/nv_tegra_release'),
  ]);
  const powerMode = tegra === null ? null : await run('nvpmodel', ['-q']).then(parseNvpmodel, () => null);
  return {
    hostname: os.hostname(),
    model: modelName(deviceTree, vendor, product),
    cpu: cpuinfo ? cpuModel(cpuinfo) : null,
    cores: (present && cpuCount(present)) || os.cpus().length,
    memory: os.totalmem(),
    os: osRelease ? parseOsRelease(osRelease) : null,
    kernel: os.release(),
    boot: Math.round((Date.now() - os.uptime() * 1000) / 1000) * 1000,
    jetson: tegra === null ? null : { release: parseTegraRelease(tegra), powerMode },
  };
}

// The counters of the previous sample, for rates
interface Previous {
  at: number;
  cpu: CpuTimes | null;
  cores: Map<number, CpuTimes>;
  networks: Map<string, { received: number; sent: number }>;
  disks: Map<string, { read: number; written: number; busyMs: number }>;
  energy: Map<string, number>;
}

export class SystemMonitor {
  private readonly logger: Logger;
  private readonly listeners = new Set<Listener>();
  private readonly history: TrendPoint[] = [];
  private info: SystemInfo | null = null;
  private infoJson = '';
  private infoAt = 0;
  private space: FsDisk[] | null = null;
  private spaceJson = '';
  private spaceAt = 0;
  private sensors: Sensors | null = null;
  private sensorsAt = 0;
  private previous: Previous | null = null;
  private latest: SystemSample | null = null;
  private nvidia: { at: number; gpus: Gpu[]; running: boolean } = { at: 0, gpus: [], running: false };
  private vcgencmd: { at: number; bits: number | null; running: boolean } = { at: 0, bits: null, running: false };
  // Under-voltage seen by rpi_volt, without the firmware's bits
  private underVoltageSeen = false;
  private timer: NodeJS.Timeout | null = null;
  private linger: NodeJS.Timeout | null = null;
  private running = false;
  // A sample being read: one at a time, though stopped and started again
  private ticking = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // Returns the unwatch function
  watch(listener: Listener): () => void {
    if (process.platform !== 'linux') {
      listener({ error: 'The system monitor reads Linux’s /proc and /sys: the server runs on another system' });
      return () => {};
    }
    this.listeners.add(listener);
    if (this.linger) {
      clearTimeout(this.linger);
      this.linger = null;
    }
    const since = Date.now() - HISTORY_MS;
    listener({
      ...(this.info && { info: this.info }),
      ...(this.space && { space: this.space }),
      history: this.history.filter((point) => point.at >= since),
      ...(this.latest && this.latest.at >= since && { sample: this.latest }),
    });
    if (!this.running) {
      this.running = true;
      if (!this.ticking) {
        void this.tick();
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.linger) {
        this.linger = setTimeout(() => {
          this.linger = null;
          if (this.listeners.size === 0) {
            this.stop();
          }
        }, LINGER_MS);
      }
    };
  }

  stop(): void {
    this.running = false;
    this.previous = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.linger) {
      clearTimeout(this.linger);
      this.linger = null;
    }
  }

  private send(update: SystemUpdateBody): void {
    for (const listener of this.listeners) {
      listener(update);
    }
  }

  private async tick(): Promise<void> {
    const started = Date.now();
    this.ticking = true;
    try {
      await this.refresh(started);
      const sample = await this.sample(started);
      if (sample && this.running) {
        this.latest = sample;
        this.history.push(trendPoint(sample));
        const since = started - HISTORY_MS;
        while (this.history.length > 0 && this.history[0].at < since) {
          this.history.shift();
        }
        this.send({ sample });
      }
    } catch (e) {
      this.logger.warn(`System monitor: ${errorMessage(e)}`);
    }
    this.ticking = false;
    if (this.running) {
      this.timer = setTimeout(() => void this.tick(), Math.max(100, PERIOD_MS - (Date.now() - started)));
    }
  }

  // What changes rarely: the system's description, the sensors, the disks'
  // space
  private async refresh(now: number): Promise<void> {
    if (!this.info || now - this.infoAt >= INFO_MS) {
      this.infoAt = now;
      const info = await readInfo();
      const json = JSON.stringify({ ...info, boot: 0 });
      // Its boot time, of the uptime, moves by a second now and then
      if (json !== this.infoJson) {
        this.infoJson = json;
        this.info = info;
        this.send({ info });
      }
    }
    if (!this.sensors || now - this.sensorsAt >= DISCOVER_MS) {
      this.sensorsAt = now;
      this.sensors = await discover(this.info?.cores ?? os.cpus().length, /^Raspberry Pi/.test(this.info?.model ?? ''));
    }
    if (!this.space || now - this.spaceAt >= SPACE_MS) {
      this.spaceAt = now;
      const space = await listDisks().catch(() => []);
      const json = JSON.stringify(space);
      if (json !== this.spaceJson) {
        this.spaceJson = json;
        this.space = space;
        this.send({ space });
      }
    }
  }

  // null the first time: rates need a previous reading
  private async sample(at: number): Promise<SystemSample | null> {
    const sensors = this.sensors!;
    const [stat, meminfo, loadavg, netDev, diskstats, temperatures, fans, mhz, power, gpus, throttled] = await Promise.all([
      text('/proc/stat'),
      text('/proc/meminfo'),
      text('/proc/loadavg'),
      text('/proc/net/dev'),
      text('/proc/diskstats'),
      this.temperatures(sensors),
      this.fans(sensors),
      this.frequencies(sensors),
      this.power(sensors),
      this.gpus(sensors, at),
      this.throttled(sensors, at),
    ]);
    const times = parseCpuTimes(stat ?? '');
    const networks = parseNetDev(netDev ?? '');
    const disks = parseDiskstats(diskstats ?? '');
    const previous = this.previous;
    const seconds = previous ? (at - previous.at) / 1000 : 0;
    this.previous = { at, cpu: times.all, cores: times.cores, networks, disks, energy: power.energy };
    // Rates over a pause in sampling would be its averages
    if (!previous || seconds <= 0 || seconds > (3 * PERIOD_MS) / 1000) {
      return null;
    }

    const cores = Array.from({ length: this.info?.cores ?? 0 }, (_, core) =>
      times.cores.has(core) ? (busyShare(previous.cores.get(core), times.cores.get(core)) ?? 0) : null,
    );
    const rails: PowerRail[] = [...power.rails];
    for (const domain of sensors.rapl) {
      const watts = energyWatts(previous.energy.get(domain.energy), power.energy.get(domain.energy) ?? NaN, domain.range, seconds);
      if (watts !== null && Number.isFinite(watts)) {
        rails.push({ name: domain.name, watts, volts: null, amps: null });
      }
    }
    // A Jetson's GPU: its thermal zone and rail
    for (const gpu of gpus) {
      if (gpu.name.startsWith('Integrated GPU')) {
        gpu.celsius ??= temperatures.find((temperature) => /^gpu[-_]therm/i.test(temperature.sensor))?.celsius ?? null;
        gpu.watts ??= rails.find((rail) => /^(VDD|POM_5V)_GPU$/i.test(rail.name))?.watts ?? null;
      }
    }

    const operstates = await Promise.all(
      [...networks.keys()].map(async (name) => {
        const [state, flags, device] = await Promise.all([
          text(`/sys/class/net/${name}/operstate`),
          text(`/sys/class/net/${name}/flags`),
          exists(`/sys/class/net/${name}/device`),
        ]);
        // IFF_UP, and a carrier if the driver says
        const up = (parseInt(flags ?? '0', 16) & 1) !== 0 && ['up', 'unknown'].includes(state?.trim() ?? '');
        return { name, up, physical: device };
      }),
    );

    return {
      at,
      cpu: busyShare(previous.cpu, times.all) ?? 0,
      cores,
      mhz: cores.map((share, core) => (share === null ? null : (mhz[core] ?? null))),
      load: parseLoadavg(loadavg ?? ''),
      memory: parseMeminfo(meminfo ?? ''),
      temperatures: [
        ...temperatures,
        ...gpus.flatMap((gpu) => (gpu.celsius !== null && !gpu.name.startsWith('Integrated GPU') ? [{ sensor: 'GPU', label: gpu.name, celsius: gpu.celsius, high: null, critical: null }] : [])),
      ],
      fans,
      throttled,
      gpus,
      power: rails,
      disks: sensors.disks.flatMap((name) => {
        const [before, after] = [previous.disks.get(name), disks.get(name)];
        return after
          ? [
              {
                name,
                read: rate(before?.read, after.read, seconds),
                written: rate(before?.written, after.written, seconds),
                busy: Math.min(1, rate(before?.busyMs, after.busyMs, seconds) / 1000),
              },
            ]
          : [];
      }),
      networks: operstates
        .filter(({ name }) => name !== 'lo')
        .map(({ name, up, physical }) => {
          const [before, after] = [previous.networks.get(name), networks.get(name)!];
          return {
            name,
            received: rate(before?.received, after.received, seconds),
            sent: rate(before?.sent, after.sent, seconds),
            totalReceived: after.received,
            totalSent: after.sent,
            up,
            physical,
          };
        }),
    };
  }

  private async temperatures(sensors: Sensors): Promise<Temperature[]> {
    const [zones, chips] = await Promise.all([
      Promise.all(
        sensors.zones.map(async (zone) => {
          const value = celsius(await number(zone.input));
          return value === null ? [] : [{ sensor: zone.type, label: null, celsius: value, high: zone.high, critical: zone.critical }];
        }),
      ),
      Promise.all(
        sensors.chips.flatMap((chip) =>
          chip.temperatures.map(async (sensor) => {
            const value = celsius(await number(sensor.input));
            return value === null ? [] : [{ sensor: chip.name, label: sensor.label, celsius: value, high: sensor.high, critical: sensor.critical }];
          }),
        ),
      ),
    ]);
    return mergeTemperatures(zones.flat(), chips.flat());
  }

  private async fans(sensors: Sensors): Promise<Fan[]> {
    const fans = await Promise.all(
      sensors.chips.flatMap((chip) =>
        chip.fans.map(async (fan) => {
          const rpm = await number(fan.input);
          return rpm === null ? [] : [{ sensor: chip.name, label: fan.label, rpm }];
        }),
      ),
    );
    return fans.flat();
  }

  // MHz of each core: cpufreq's, else /proc/cpuinfo's (VMs)
  private async frequencies(sensors: Sensors): Promise<(number | null)[]> {
    if (sensors.cpufreq.size === 0) {
      const cpuinfo = await text('/proc/cpuinfo');
      return cpuinfo ? cpuinfoMhz(cpuinfo).map(Math.round) : [];
    }
    const mhz: (number | null)[] = [];
    await Promise.all(
      [...sensors.cpufreq].map(async ([core, file]) => {
        const khz = await number(file);
        mhz[core] = khz === null ? null : Math.round(khz / 1000);
      }),
    );
    return mhz;
  }

  // The rails read now; RAPL's energy counters, made watts by the sample
  private async power(sensors: Sensors): Promise<{ rails: PowerRail[]; energy: Map<string, number> }> {
    const [chips, iio, energy] = await Promise.all([
      Promise.all(
        sensors.chips.flatMap((chip) => [
          ...chip.rails.map(async (rail): Promise<PowerRail[]> => {
            const [mv, ma] = await Promise.all([number(rail.volts), number(rail.amps)]);
            return mv === null || ma === null ? [] : [{ name: rail.label, watts: (mv * ma) / 1e6, volts: mv / 1000, amps: ma / 1000 }];
          }),
          ...chip.power.map(async (sensor): Promise<PowerRail[]> => {
            const uw = await number(sensor.input);
            return uw === null ? [] : [{ name: sensor.label ? `${chip.name} ${sensor.label}` : chip.name, watts: uw / 1e6, volts: null, amps: null }];
          }),
        ]),
      ),
      Promise.all(
        sensors.iioRails.map(async (rail): Promise<PowerRail[]> => {
          const [mw, mv, ma] = await Promise.all([number(rail.power), number(rail.volts), number(rail.amps)]);
          return mw === null ? [] : [{ name: rail.name, watts: mw / 1000, volts: mv === null ? null : mv / 1000, amps: ma === null ? null : ma / 1000 }];
        }),
      ),
      Promise.all(sensors.rapl.map(async (domain) => [domain.energy, await number(domain.energy)] as const)),
    ]);
    return {
      rails: [...chips.flat(), ...iio.flat()],
      energy: new Map(energy.filter((entry): entry is [string, number] => entry[1] !== null)),
    };
  }

  private async gpus(sensors: Sensors, at: number): Promise<Gpu[]> {
    const [tegra, amd] = await Promise.all([
      Promise.all(
        sensors.tegraGpus.map(async (gpu): Promise<Gpu> => {
          const [load, hz] = await Promise.all([number(gpu.load), number(gpu.frequency)]);
          return {
            name: gpu.name,
            // Per mille
            load: load === null ? null : Math.min(1, load / 1000),
            mhz: hz === null ? null : Math.round(hz / 1e6),
            memoryUsed: null,
            memoryTotal: null,
            celsius: null,
            watts: null,
          };
        }),
      ),
      Promise.all(
        sensors.amdGpus.map(async (gpu): Promise<Gpu> => {
          const [busy, used, total] = await Promise.all([number(gpu.busy), number(gpu.used), number(gpu.total)]);
          return { name: 'AMD GPU', load: busy === null ? null : busy / 100, mhz: null, memoryUsed: used, memoryTotal: total, celsius: null, watts: null };
        }),
      ),
    ]);
    if (sensors.nvidia && !this.nvidia.running && at - this.nvidia.at >= NVIDIA_MS) {
      this.nvidia.running = true;
      run('nvidia-smi', [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'])
        .then(
          (out) => (this.nvidia.gpus = parseNvidiaSmi(out)),
          () => (this.nvidia.gpus = []),
        )
        .finally(() => {
          this.nvidia.at = Date.now();
          this.nvidia.running = false;
        });
    }
    return [...tegra, ...amd, ...(sensors.nvidia ? this.nvidia.gpus.map((gpu) => ({ ...gpu })) : [])];
  }

  private async throttled(sensors: Sensors, at: number): Promise<number | null> {
    if (sensors.throttled) {
      const read = await text(sensors.throttled);
      return read === null ? null : parseThrottled(read);
    }
    if (sensors.vcgencmd) {
      if (!this.vcgencmd.running && at - this.vcgencmd.at >= VCGENCMD_MS) {
        this.vcgencmd.running = true;
        run('vcgencmd', ['get_throttled'])
          .then(
            (out) => (this.vcgencmd.bits = parseThrottled(out)),
            () => (this.vcgencmd.bits = null),
          )
          .finally(() => {
            this.vcgencmd.at = Date.now();
            this.vcgencmd.running = false;
          });
      }
      return this.vcgencmd.bits;
    }
    const volts = sensors.chips.find((chip) => chip.underVoltage);
    if (volts?.underVoltage) {
      const now = (await number(volts.underVoltage)) === 1;
      this.underVoltageSeen ||= now;
      return (now ? 1 : 0) | (this.underVoltageSeen ? 1 << 16 : 0);
    }
    return null;
  }
}
