// The messages of a behavior tree's log (nav2_msgs/msg/BehaviorTreeLog): as
// rclnodejs gives them, live, and as rosbags keep them, CDR serialized. Their
// transitions in either case.
//
//   builtin_interfaces/Time timestamp
//   BehaviorTreeStatusChange[] event_log
//     builtin_interfaces/Time timestamp
//     string node_name
//     uint16 uid               (since Jazzy)
//     string previous_status
//     string current_status

// A transition, as the log gives it
export interface LogTransition {
  // null when the log has none (before Nav2 Jazzy)
  uid: number | null;
  name: string;
  from: string;
  to: string;
  // The robot's, ms since the epoch
  time: number;
}

interface RosTime {
  sec?: number;
  nanosec?: number;
}

interface RawLog {
  timestamp?: RosTime;
  event_log?: {
    timestamp?: RosTime;
    node_name?: string;
    uid?: number;
    previous_status?: string;
    current_status?: string;
  }[];
}

const STATUSES = new Set(['IDLE', 'RUNNING', 'SUCCESS', 'FAILURE', 'SKIPPED']);

const toMs = (time: RosTime | undefined) => (time?.sec ? time.sec * 1000 + (time.nanosec ?? 0) / 1e6 : 0);

// A message's transitions, as rclnodejs gives it; throws if it is not a log
export function logTransitions(raw: unknown): LogTransition[] {
  const log = raw as RawLog;
  if (!Array.isArray(log?.event_log)) {
    throw new Error('not a log of transitions (nav2_msgs/msg/BehaviorTreeLog)');
  }
  const sent = toMs(log.timestamp) || Date.now();
  return log.event_log.map((event) => ({
    uid: typeof event.uid === 'number' && event.uid > 0 ? event.uid : null,
    name: String(event.node_name ?? ''),
    from: String(event.previous_status ?? '').toUpperCase(),
    to: String(event.current_status ?? '').toUpperCase(),
    time: toMs(event.timestamp) || sent,
  }));
}

const utf8 = new TextDecoder();

// Reads CDR (XCDR 1 or 2, of final types: the same here) after its 4 byte
// encapsulation header, which says its endianness; aligned from after it
class CdrReader {
  private offset = 4;
  private readonly view: DataView;
  private readonly little: boolean;

  constructor(data: Uint8Array) {
    if (data.length < 4) {
      throw new Error('Truncated message');
    }
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.little = (data[1] & 1) === 1;
  }

  private take(size: number): number {
    this.offset += (size - ((this.offset - 4) % size)) % size;
    const at = this.offset;
    if (at + size > this.view.byteLength) {
      throw new Error('Truncated message');
    }
    this.offset += size;
    return at;
  }

  int32(): number {
    return this.view.getInt32(this.take(4), this.little);
  }

  uint32(): number {
    return this.view.getUint32(this.take(4), this.little);
  }

  uint16(): number {
    return this.view.getUint16(this.take(2), this.little);
  }

  // Its length counts the terminating null
  string(): string {
    const length = this.uint32();
    if (length === 0) {
      return '';
    }
    if (this.offset + length > this.view.byteLength) {
      throw new Error('Truncated message');
    }
    const text = utf8.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length - 1));
    this.offset += length;
    return text;
  }

  time(): number {
    const sec = this.int32();
    return sec * 1000 + this.uint32() / 1e6;
  }
}

// A serialized log's transitions, with UIDs (Jazzy's) or without; throws if
// it is not a log of that layout
export function decodeLog(data: Uint8Array, uids: boolean): LogTransition[] {
  const reader = new CdrReader(data);
  const sent = reader.time();
  const count = reader.uint32();
  const transitions: LogTransition[] = [];
  for (let i = 0; i < count; i++) {
    const time = reader.time();
    const name = reader.string();
    const uid = uids ? reader.uint16() : 0;
    const from = reader.string();
    const to = reader.string();
    if (!STATUSES.has(from) || !STATUSES.has(to)) {
      throw new Error(`not a log of transitions: statuses “${from}”, “${to}”`);
    }
    transitions.push({ uid: uid > 0 ? uid : null, name, from, to, time: time || sent });
  }
  return transitions;
}

// How many messages tell the layout
const LAYOUT_SAMPLES = 200;

// Whether the serialized logs have UIDs, from their first transitions; null
// if neither layout reads them. Either may read the other's, the UIDs in the
// strings' padding: with UIDs, those of a log without them read 0, which
// BT.CPP never numbers.
export function logLayout(messages: Iterable<Uint8Array>): boolean | null {
  const samples: Uint8Array[] = [];
  for (const data of messages) {
    if (samples.length === LAYOUT_SAMPLES) {
      break;
    }
    // Not empty: an empty log reads either way
    if (data.length > 16) {
      samples.push(data);
    }
  }
  const read = (uids: boolean) => {
    const transitions: LogTransition[] = [];
    try {
      for (const data of samples) {
        transitions.push(...decodeLog(data, uids));
      }
    } catch {
      return null;
    }
    return transitions;
  };
  if (read(true)?.some((transition) => transition.uid !== null)) {
    return true;
  }
  return read(false)?.length ? false : null;
}
