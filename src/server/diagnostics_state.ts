// The robot's diagnostics as the server keeps them for the diagnostics widgets
// (diagnostics.ts): the latest status of each name, stale once no longer
// received, their latest changes of level, and what the pages have yet to get.

import type { DiagnosticChange, DiagnosticEntry } from '../shared/protocol.ts';

// diagnostic_msgs/msg/DiagnosticStatus's levels
const OK = 0;
const STALE = 3;
// A status not received for this long, nor for this many of its periods, is
// stale: the aggregator's default timeout, and room for slower publishers
// (diagnostic_updater publishes once a second by default)
export const STALE_AFTER_MS = 5000;
const STALE_PERIODS = 3;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function keyValues(value: unknown): DiagnosticEntry['values'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((pair: unknown) => {
    const fields = (pair ?? {}) as Record<string, unknown>;
    return { key: text(fields.key), value: text(fields.value) };
  });
}

function sameValues(a: DiagnosticEntry['values'], b: DiagnosticEntry['values']): boolean {
  return a.length === b.length && a.every((pair, i) => pair.key === b[i].key && pair.value === b[i].value);
}

// The level a status is at: STALE when stale, else as published
export function levelOf(entry: Pick<DiagnosticEntry, 'level' | 'stale'>): number {
  return entry.stale ? STALE : entry.level;
}

interface Kept {
  // Changed in place: copied when sent
  entry: DiagnosticEntry;
  // Between its latest two receptions, ms
  period: number;
}

export interface DiagnosticsBatch {
  statuses: DiagnosticEntry[];
  // Oldest first
  changes: DiagnosticChange[];
}

export class DiagnosticsState {
  private readonly capacity: number;
  // By name
  private readonly statuses = new Map<string, Kept>();
  // Oldest first, with up to an eighth of capacity more: dropped in chunks,
  // not one by one
  private changes: DiagnosticChange[] = [];
  private lastId = 0;
  // The seq of the latest change, and of the latest taken in a batch
  private lastSeq = 0;
  private taken = 0;
  // Changed since the last batch
  private readonly dirty = new Set<Kept>();

  // Of the changes kept
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  // A diagnostic_msgs/msg/DiagnosticArray, from rclnodejs, received at now
  add(raw: unknown, now: number): void {
    const { status } = (raw ?? {}) as Record<string, unknown>;
    if (Array.isArray(status)) {
      for (const fields of status) {
        if (fields && typeof fields === 'object') {
          this.addStatus(fields as Record<string, unknown>, now);
        }
      }
    }
  }

  // Marks stale the statuses no longer received
  checkStale(now: number): void {
    for (const kept of this.statuses.values()) {
      const { entry } = kept;
      if (entry.stale || now - entry.updated <= Math.max(STALE_AFTER_MS, STALE_PERIODS * kept.period)) {
        continue;
      }
      const before = levelOf(entry);
      entry.stale = true;
      this.dirty.add(kept);
      if (before !== STALE) {
        this.change(entry, now);
      }
    }
  }

  // All the statuses and changes kept: what a new page gets
  snapshot(): DiagnosticsBatch {
    return {
      statuses: [...this.statuses.values()].map((kept) => ({ ...kept.entry })),
      changes: this.changes.slice(-this.capacity),
    };
  }

  // The statuses changed and the changes since the last batch; null if none
  takeBatch(): DiagnosticsBatch | null {
    const fresh = this.lastSeq - this.taken;
    if (this.dirty.size === 0 && fresh === 0) {
      return null;
    }
    const statuses = [...this.dirty].map((kept) => ({ ...kept.entry }));
    this.dirty.clear();
    this.taken = this.lastSeq;
    const kept = Math.min(fresh, this.capacity);
    return { statuses, changes: kept > 0 ? this.changes.slice(-kept) : [] };
  }

  private addStatus(fields: Record<string, unknown>, now: number): void {
    const next = {
      name: text(fields.name),
      level: count(fields.level),
      message: text(fields.message),
      hardwareId: text(fields.hardware_id),
      values: keyValues(fields.values),
    };
    const kept = this.statuses.get(next.name);
    if (!kept) {
      const entry: DiagnosticEntry = { id: ++this.lastId, ...next, stale: false, updated: now, since: now };
      const added = { entry, period: 0 };
      this.statuses.set(next.name, added);
      this.dirty.add(added);
      if (entry.level !== OK) {
        this.change(entry, now);
      }
      return;
    }
    const { entry } = kept;
    kept.period = now - entry.updated;
    entry.updated = now;
    if (
      !entry.stale &&
      entry.level === next.level &&
      entry.message === next.message &&
      entry.hardwareId === next.hardwareId &&
      sameValues(entry.values, next.values)
    ) {
      return;
    }
    const before = levelOf(entry);
    Object.assign(entry, next, { stale: false });
    this.dirty.add(kept);
    if (levelOf(entry) !== before) {
      this.change(entry, now);
    }
  }

  private change(entry: DiagnosticEntry, now: number): void {
    entry.since = now;
    this.changes.push({
      seq: ++this.lastSeq,
      time: now,
      status: entry.id,
      level: levelOf(entry),
      message: entry.message,
    });
    if (this.changes.length >= this.capacity + Math.ceil(this.capacity / 8)) {
      this.changes.splice(0, this.changes.length - this.capacity);
    }
  }
}
