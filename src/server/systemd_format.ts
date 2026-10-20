// What systemctl and journalctl print, read: for systemd.ts, kept apart to
// be tested without a service manager

import type { ServiceInfo, ServiceScope } from '../shared/protocol.ts';

const PATTERN = /^[A-Za-z0-9:_.@*?[\]-]+$/;
const UNIT = /^[A-Za-z0-9:_.@-]+\.service$/;

// "myrobot": myrobot*.service; a glob as it is, .service added
export function serviceGlob(pattern: string): string {
  const trimmed = pattern.trim();
  if (!PATTERN.test(trimmed)) {
    throw new Error(`Invalid service name "${pattern}": letters, digits, - _ . : @ and wildcards`);
  }
  if (trimmed.endsWith('.service')) {
    return trimmed;
  }
  return /[*?[]/.test(trimmed) ? `${trimmed}.service` : `${trimmed}*.service`;
}

export function checkUnit(unit: string): string {
  if (!UNIT.test(unit)) {
    throw new Error(`Invalid service "${unit}"`);
  }
  return unit;
}

// systemctl list-unit-files --plain --no-legend: "unit state preset". Not
// the aliases, listed with their unit, nor the templates (name@.service).
export function unitFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([unit, state]) => unit?.endsWith('.service') && state !== 'alias' && !unit.includes('@.'))
    .map(([unit]) => unit);
}

// systemctl list-units --plain --no-legend: "unit load active sub description"
export function loadedUnits(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit?.endsWith('.service'));
}

// A timestamp of systemctl show, in ms: --timestamp=utc's "Tue 2026-10-20
// 10:46:16 UTC" (systemd 244 on, as Ubuntu 22.04's 249: --timestamp=unix's
// "@1792500000" needs 251), or --timestamp=unix's; null if none ("", "n/a")
export function showTimestamp(value: string | undefined): number | null {
  const unix = /^@(\d+)$/.exec(value ?? '');
  if (unix) {
    return Number(unix[1]) * 1000;
  }
  const utc = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? UTC$/.exec(value ?? '');
  if (!utc) {
    return null;
  }
  const [year, month, day, hours, minutes, seconds] = utc.slice(1, 7).map(Number);
  // us+utc's microseconds
  const ms = Math.floor(Number(`0.${utc[7] ?? '0'}`) * 1000);
  return Date.UTC(year, month - 1, day, hours, minutes, seconds, ms);
}

// systemctl show --timestamp=utc: a block of key=value lines per unit
export function shownServices(output: string, scope: ServiceScope, self: string | null): ServiceInfo[] {
  return output
    .split(/\n\s*\n/)
    .map((block) => {
      const properties = new Map<string, string>();
      for (const line of block.split('\n')) {
        const equals = line.indexOf('=');
        if (equals > 0) {
          properties.set(line.slice(0, equals), line.slice(equals + 1));
        }
      }
      return properties;
    })
    .filter((properties) => properties.has('Id'))
    .map((p) => {
      return {
        unit: p.get('Id')!,
        scope,
        description: p.get('Description') ?? '',
        load: p.get('LoadState') ?? '',
        active: p.get('ActiveState') ?? '',
        sub: p.get('SubState') ?? '',
        result: p.get('Result') ?? '',
        enabled: p.get('UnitFileState') ?? '',
        since: showTimestamp(p.get('StateChangeTimestamp')),
        self: p.get('Id') === self,
      };
    });
}

// The unit the process runs in, from its cgroup (the last .service of the
// path), or null
export function ownUnit(cgroup: string): string | null {
  const units = cgroup.match(/[^/]+\.service/g);
  return units ? units[units.length - 1] : null;
}

// journalctl -o short-iso: "2026-10-14T08:31:02+02:00 host name[pid]: message",
// shown as "08:31:02 message"; other lines (-- No entries --, ...) as they are
export function journalLine(line: string): string {
  const entry = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)\S*\s+\S+\s+[^:\s]+:\s?(.*)$/.exec(line);
  return entry ? `${entry[1]} ${entry[2]}` : line;
}
