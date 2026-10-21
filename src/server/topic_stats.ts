// A topic's figures, as ros2 topic hz, bw and delay compute them: over the
// latest messages (the window), their rate and the spread of the intervals
// between them, their bandwidth and sizes, and the delay from their header's
// stamp to their arrival. Kept apart from topic_monitor.ts to be tested
// without ROS.

import type { Spread, TopicStats } from '../shared/monitor.ts';

// The stamp of a serialized message that begins with a std_msgs/msg/Header,
// in seconds: after CDR's 4 byte encapsulation header (its second byte odd
// for little endian), the stamp's sec (int32) and nanosec (uint32). null if
// the buffer is too short.
export function headerStamp(buffer: Uint8Array): number | null {
  if (buffer.length < 12) {
    return null;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const little = (buffer[1] & 1) === 1;
  return view.getInt32(4, little) + view.getUint32(8, little) / 1e9;
}

function spread(values: Float64Array, start: number, count: number, capacity: number): Spread | null {
  if (count === 0) {
    return null;
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = values[(start + i) % capacity];
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const mean = sum / count;
  let squares = 0;
  for (let i = 0; i < count; i++) {
    const d = values[(start + i) % capacity] - mean;
    squares += d * d;
  }
  return { mean, min, max, stdDev: Math.sqrt(squares / count) };
}

// The latest arrivals, at most capacity, in rings
export class TopicStatsWindow {
  // Messages received
  count = 0;
  // On the server's clock, ms since the epoch
  lastAt: number | null = null;
  private readonly capacity: number;
  // Monotonic, in seconds
  private readonly times: Float64Array;
  private readonly sizes: Float64Array;
  // NaN: not known
  private readonly delays: Float64Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.sizes = new Float64Array(capacity);
    this.delays = new Float64Array(capacity);
  }

  // A message of size bytes arrived at time (monotonic s), delay s after its
  // stamp (null: no stamp)
  add(time: number, size: number, delay: number | null, now: number): void {
    const i = this.count % this.capacity;
    this.times[i] = time;
    this.sizes[i] = size;
    this.delays[i] = delay ?? NaN;
    this.count++;
    this.lastAt = now;
  }

  // Of the latest window messages, received since the count since
  stats(window: number, since: number): TopicStats {
    const n = Math.min(window, this.capacity, this.count - since);
    const start = (this.count - n) % this.capacity;
    const at = (k: number) => (start + k) % this.capacity;
    const stats: TopicStats = {
      received: this.count - since,
      window: n,
      rate: null,
      interval: null,
      bandwidth: null,
      size: spread(this.sizes, start, n, this.capacity),
      delay: null,
      lastAt: n > 0 ? this.lastAt : null,
    };
    if (n >= 2) {
      const intervals = new Float64Array(n - 1);
      let bytes = 0;
      for (let k = 1; k < n; k++) {
        intervals[k - 1] = this.times[at(k)] - this.times[at(k - 1)];
        bytes += this.sizes[at(k)];
      }
      const span = this.times[at(n - 1)] - this.times[at(0)];
      stats.interval = spread(intervals, 0, n - 1, n - 1);
      if (span > 0) {
        stats.rate = (n - 1) / span;
        stats.bandwidth = bytes / span;
      }
    }
    const delays: number[] = [];
    for (let k = 0; k < n; k++) {
      const d = this.delays[at(k)];
      if (!Number.isNaN(d)) {
        delays.push(d);
      }
    }
    stats.delay = spread(Float64Array.from(delays), 0, delays.length, Math.max(1, delays.length));
    return stats;
  }
}
