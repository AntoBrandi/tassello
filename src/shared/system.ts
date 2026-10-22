// What the system monitor reads of the robot's computer, every second (see
// src/server/system.ts): its processor's cores, memory, temperatures and
// fans, GPUs, power rails, disks and networks, and a Raspberry Pi's
// throttling; with what the charts draw of the last minutes.

export interface SystemInfo {
  hostname: string;
  // The board's or the computer's: "Raspberry Pi 5 Model B Rev 1.0"
  model: string | null;
  // The processor's: "13th Gen Intel(R) Core(TM) i7-13700H"
  cpu: string | null;
  // Online or not
  cores: number;
  // Bytes
  memory: number;
  // "Ubuntu 22.04.5 LTS"
  os: string | null;
  kernel: string;
  // ms since the epoch
  boot: number;
  // A Jetson's L4T release ("R36.4.3") and power mode (nvpmodel's: "15W")
  jetson: { release: string | null; powerMode: string | null } | null;
}

export interface Temperature {
  // The chip (coretemp, nvme, cpu-thermal) and its sensor, if it has several
  sensor: string;
  label: string | null;
  celsius: number;
  // Where it is hot (passive cooling, the sensor's max) and too hot
  high: number | null;
  critical: number | null;
}

export interface Fan {
  sensor: string;
  label: string | null;
  rpm: number;
}

export interface Gpu {
  name: string;
  // 0..1
  load: number | null;
  mhz: number | null;
  // Bytes
  memoryUsed: number | null;
  memoryTotal: number | null;
  celsius: number | null;
  watts: number | null;
}

// A power monitor's channel (a Jetson's INA3221: VDD_IN, VDD_CPU_GPU_CV), or
// a chip's own estimate (a CPU package's)
export interface PowerRail {
  name: string;
  watts: number;
  volts: number | null;
  amps: number | null;
}

// Bytes per second
export interface DiskIo {
  // nvme0n1, mmcblk0, sda
  name: string;
  read: number;
  written: number;
  // Of the time, 0..1
  busy: number;
}

export interface NetworkIo {
  name: string;
  // Bytes per second
  received: number;
  sent: number;
  // Since the interface came up
  totalReceived: number;
  totalSent: number;
  up: boolean;
  // A device's (eth0, wlan0), not software's (docker0, wg0, tailscale0)
  physical: boolean;
}

export interface SystemSample {
  // ms since the epoch
  at: number;
  // Busy share, 0..1, over the last second: of all the cores, then of each by
  // its number (null if offline, as a Jetson's power modes make them)
  cpu: number;
  cores: (number | null)[];
  // Of each core, if known
  mhz: (number | null)[];
  load: [number, number, number];
  // Bytes; used is what is not available (cached memory is)
  memory: { total: number; used: number; cached: number; swapTotal: number; swapUsed: number };
  temperatures: Temperature[];
  fans: Fan[];
  // A Raspberry Pi's throttling bits (vcgencmd get_throttled, see
  // THROTTLING); null elsewhere
  throttled: number | null;
  gpus: Gpu[];
  power: PowerRail[];
  disks: DiskIo[];
  networks: NetworkIo[];
}

// What the charts draw of a sample
export interface TrendPoint {
  at: number;
  cpu: number;
  // Bytes
  memory: number;
  // The hottest
  temperature: number | null;
  // Each GPU's load
  gpus: (number | null)[];
  // The main rail's (see mainRail)
  watts: number | null;
  // Bytes per second, by name: received and sent, read and written
  networks: Record<string, [number, number]>;
  disks: Record<string, [number, number]>;
}

// The bits of vcgencmd get_throttled: each now, and since boot 16 bits higher
export const THROTTLING = [
  { bit: 0, label: 'Under-voltage', help: 'The supply’s voltage is too low: a weak power supply or cable' },
  { bit: 1, label: 'Frequency capped', help: 'The ARM cores’ frequency is capped' },
  { bit: 2, label: 'Throttled', help: 'The ARM cores are slowed down' },
  { bit: 3, label: 'Soft temperature limit', help: 'Hot enough for the frequency to be lowered' },
] as const;

export function throttlingFlags(bits: number): { label: string; help: string; now: boolean; occurred: boolean }[] {
  return THROTTLING.map(({ bit, label, help }) => ({
    label,
    help,
    now: (bits & (1 << bit)) !== 0,
    occurred: (bits & (1 << (bit + 16))) !== 0,
  }));
}

// The rail the whole board's power goes through (a Jetson's VDD_IN,
// POM_5V_IN), or a CPU package's; else the only one
export function mainRail(rails: PowerRail[]): PowerRail | null {
  return rails.find((rail) => /_IN$|^total|package/i.test(rail.name)) ?? (rails.length === 1 ? rails[0] : null);
}

export function hottest(temperatures: Temperature[]): Temperature | null {
  let found: Temperature | null = null;
  for (const temperature of temperatures) {
    if (!found || temperature.celsius > found.celsius) {
      found = temperature;
    }
  }
  return found;
}

export function trendPoint(sample: SystemSample): TrendPoint {
  return {
    at: sample.at,
    cpu: sample.cpu,
    memory: sample.memory.used,
    temperature: hottest(sample.temperatures)?.celsius ?? null,
    gpus: sample.gpus.map((gpu) => gpu.load),
    watts: mainRail(sample.power)?.watts ?? null,
    networks: Object.fromEntries(sample.networks.map((network) => [network.name, [network.received, network.sent]])),
    disks: Object.fromEntries(sample.disks.map((disk) => [disk.name, [disk.read, disk.written]])),
  };
}
