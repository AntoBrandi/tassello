// The ROS log (rcl_interfaces/msg/Log) as the server keeps it for the logs
// widgets (rosout.ts): its latest messages, numbered as they come, shared
// fairly among their loggers (../shared/log_share.ts), and those its pages
// have yet to get.

import { keepFairly } from '../shared/log_share.ts';
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

// The latest messages, at most capacity, shared fairly among their loggers:
// a node flooding the log drops its own oldest, not a quiet one's. And the
// batches of those not yet sent.
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
      this.entries = keepFairly(this.entries, this.capacity);
    }
  }

  // The messages kept, oldest first: what a new page gets
  snapshot(): LogEntry[] {
    return keepFairly(this.entries, this.capacity).slice();
  }

  // Those added since the last batch, at most max, shared fairly as the
  // history is (a burst of one node skips its own); null if none
  takeBatch(max: number): LogBatch | null {
    const fresh = this.last - this.taken;
    if (fresh === 0) {
      return null;
    }
    // Those still kept: a flood may have dropped some already
    let first = this.entries.length;
    while (first > 0 && this.entries[first - 1].seq > this.taken) {
      first--;
    }
    this.taken = this.last;
    const entries = keepFairly(this.entries.slice(first), Math.min(max, this.capacity));
    return { entries, skipped: fresh - entries.length };
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
