// The ROS log (rcl_interfaces/msg/Log) as the server keeps it for the logs
// widgets (rosout.ts): its latest messages, numbered as they come, and those
// its pages have yet to get.

import type { LogEntry } from '../shared/protocol.ts';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// A message of the log, from rclnodejs's (the fields of rcl_interfaces/msg/Log)
export function logEntry(raw: unknown, seq: number): LogEntry {
  const fields = (raw ?? {}) as Record<string, unknown>;
  const stamp = (fields.stamp ?? {}) as Record<string, unknown>;
  return {
    seq,
    stamp: count(stamp.sec) * 1000 + count(stamp.nanosec) / 1e6,
    level: count(fields.level),
    name: text(fields.name),
    msg: text(fields.msg),
    file: text(fields.file),
    function: text(fields.function),
    line: count(fields.line),
  };
}

export interface LogBatch {
  // Oldest first
  entries: LogEntry[];
  // Left out before them
  skipped: number;
}

// The latest messages, at most capacity, and the batches of those not yet sent
export class LogHistory {
  private readonly capacity: number;
  // Oldest first, with up to an eighth of capacity more: dropped in chunks,
  // not one by one
  private entries: LogEntry[] = [];
  // The seq of the latest, and of the latest taken in a batch
  private last = 0;
  private taken = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  add(raw: unknown): void {
    this.entries.push(logEntry(raw, ++this.last));
    if (this.entries.length >= this.capacity + Math.ceil(this.capacity / 8)) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  // The messages kept, oldest first: what a new page gets
  snapshot(): LogEntry[] {
    return this.entries.slice(-this.capacity);
  }

  // Those added since the last batch, at most max (the latest); null if none
  takeBatch(max: number): LogBatch | null {
    const fresh = this.last - this.taken;
    if (fresh === 0) {
      return null;
    }
    this.taken = this.last;
    const kept = Math.min(fresh, max, this.capacity);
    return { entries: kept > 0 ? this.entries.slice(-kept) : [], skipped: fresh - kept };
  }
}

// The nodes of the ROS graph by their full names (/robot1/amcl), sorted,
// without the hidden ones (_name), as ros2 node list has them
export function nodeNames(nodes: { name: string; namespace: string }[]): string[] {
  const names = nodes
    .filter((node) => node.name && !node.name.startsWith('_'))
    .map((node) => `${node.namespace.replace(/\/+$/, '')}/${node.name}`);
  return [...new Set(names)].sort();
}
