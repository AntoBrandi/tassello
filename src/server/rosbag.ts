// Rosbags (rosbag2), for the behavior tree inspectors' record and playback:
// the messages of some of their topics, read from either storage (MCAP,
// Jazzy's default, or SQLite, Humble's), serialized as recorded; and topics
// recorded into a new one by ros2 bag record, the robot's own tool.

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { errorMessage, stripAnsi } from './util.ts';

export interface BagTopic {
  name: string;
  // e.g. nav2_msgs/msg/BehaviorTreeLog
  type: string;
}

export interface BagMessage {
  // When it was recorded, ms since the epoch
  time: number;
  // CDR
  data: Uint8Array;
}

export type BagTopics = Map<string, { topic: BagTopic; messages: BagMessage[] }>;

const BAG_FILE = /\.(mcap|db3)$/i;

function absolute(input: string, home: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`Not a path: "${input}" (/…, ~/…)`);
  }
  return path.resolve(expanded);
}

const nsToMs = (ns: bigint) => Number(ns / 1000n) / 1000;

// The files of a bag: its folder's (split bags' in order), or one of them
export async function bagFiles(input: string, home = os.homedir()): Promise<string[]> {
  const location = absolute(input, home);
  const stat = await fs.stat(location).catch(() => null);
  if (!stat) {
    throw new Error(`No rosbag at ${location}`);
  }
  if (stat.isDirectory()) {
    const names = await fs.readdir(location);
    const files = names.filter((name) => BAG_FILE.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (files.length === 0) {
      const compressed = names.some((name) => /\.(mcap|db3)\.\w+$/i.test(name));
      throw new Error(`No rosbag in ${location}: no .mcap nor .db3 file${compressed ? ' (compressed files are not read)' : ''}`);
    }
    return files.map((name) => path.join(location, name));
  }
  if (!BAG_FILE.test(location)) {
    throw new Error(`Not a rosbag: ${location} (a bag's folder, an .mcap or .db3 file)`);
  }
  return [location];
}

// The messages of the topics accepted, by topic, in the order recorded
export async function readBag(files: string[], accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  const topics: BagTopics = new Map();
  for (const file of files) {
    const read = /\.mcap$/i.test(file) ? await readMcap(file, accept) : await readSqlite(file, accept);
    for (const [name, found] of read) {
      const known = topics.get(name);
      if (known) {
        known.messages = known.messages.concat(found.messages);
      } else {
        topics.set(name, found);
      }
    }
  }
  for (const { messages } of topics.values()) {
    messages.sort((a, b) => a.time - b.time);
  }
  return topics;
}

// ── MCAP ─────────────────────────────────────────────────────────────────────
// Records: opcode (u8), length (u64), content; little endian, strings and
// maps prefixed with their u32 byte length (https://mcap.dev/spec)

const MCAP_MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];
const FOOTER = 0x02;
const SCHEMA = 0x03;
const CHANNEL = 0x04;
const MESSAGE = 0x05;
const CHUNK = 0x06;
const CHUNK_INDEX = 0x08;
const DATA_END = 0x0f;
// Opcode, length, summary start, summary offset start, summary CRC
const FOOTER_BYTES = 1 + 8 + 8 + 8 + 4;

// Reads a buffer; past its end throws (RangeError)
class Cursor {
  offset = 0;
  readonly data: Buffer;

  constructor(data: Buffer) {
    this.data = data;
  }

  u8(): number {
    return this.data.readUInt8(this.offset++);
  }

  u16(): number {
    const value = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  // Offsets and lengths: well within a number
  size(): number {
    return Number(this.u64());
  }

  bytes(length: number): Buffer {
    if (this.offset + length > this.data.length) {
      throw new RangeError('Truncated record');
    }
    const bytes = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  string(): string {
    return this.bytes(this.u32()).toString('utf8');
  }
}

function decompress(compression: string, data: Buffer): Buffer {
  if (!compression) {
    return data;
  }
  if (compression === 'zstd') {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('Reading zstd compressed MCAP needs Node.js 22.15 or newer');
    }
    return zlib.zstdDecompressSync(data);
  }
  throw new Error(`MCAP compressed with ${compression} is not read: record with zstd, or without compression`);
}

// What the records of a file say: its schemas and channels, and the messages
// of those accepted
class McapRecords {
  readonly topics: BagTopics = new Map();
  readonly channels = new Map<number, BagTopic | null>();
  private readonly schemas = new Map<number, string>();
  private readonly accept: (topic: BagTopic) => boolean;

  constructor(accept: (topic: BagTopic) => boolean) {
    this.accept = accept;
  }

  // The channels whose messages are read
  wanted(): Set<number> {
    return new Set([...this.channels].flatMap(([id, topic]) => (topic ? [id] : [])));
  }

  record(opcode: number, content: Buffer): void {
    const cursor = new Cursor(content);
    switch (opcode) {
      case SCHEMA:
        this.schemas.set(cursor.u16(), cursor.string());
        break;
      case CHANNEL: {
        const id = cursor.u16();
        const schema = cursor.u16();
        const topic = { name: cursor.string(), type: this.schemas.get(schema) ?? '' };
        if (!this.channels.has(id)) {
          this.channels.set(id, this.accept(topic) ? topic : null);
        }
        break;
      }
      case MESSAGE: {
        const topic = this.channels.get(cursor.u16());
        if (!topic) {
          break;
        }
        cursor.u32();
        const time = nsToMs(cursor.u64());
        cursor.u64();
        // A copy: not to keep the whole chunk
        const data = Uint8Array.prototype.slice.call(content, cursor.offset);
        const known = this.topics.get(topic.name);
        if (known) {
          known.messages.push({ time, data });
        } else {
          this.topics.set(topic.name, { topic, messages: [{ time, data }] });
        }
        break;
      }
      case CHUNK: {
        cursor.offset += 8 + 8 + 8 + 4;
        const compression = cursor.string();
        this.records(decompress(compression, cursor.bytes(cursor.size())));
        break;
      }
    }
  }

  // A sequence of records, e.g. a chunk's
  records(data: Buffer): void {
    const cursor = new Cursor(data);
    while (cursor.offset + 9 <= data.length) {
      const opcode = cursor.u8();
      this.record(opcode, cursor.bytes(cursor.size()));
    }
  }
}

async function readMcap(file: string, accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  const handle = await fs.open(file, 'r').catch((e: NodeJS.ErrnoException) => {
    throw new Error(`Cannot read ${file}: ${e.code ?? errorMessage(e)}`);
  });
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 8);
    if (!MCAP_MAGIC.every((byte, i) => head[i] === byte)) {
      throw new Error(`${file} is not an MCAP file`);
    }
    const records = new McapRecords(accept);
    if (!(await readIndexed(records, read, size))) {
      await readSequentially(records, read, size);
    }
    return records.topics;
  } finally {
    await handle.close();
  }
}

type Read = (position: number, length: number) => Promise<Buffer>;

// From the summary at the end of the file: the channels, and where the
// chunks with messages of those accepted are, which alone are read. false if
// the file has no summary (unfinished, or written without chunks).
async function readIndexed(records: McapRecords, read: Read, size: number): Promise<boolean> {
  const footerAt = size - 8 - FOOTER_BYTES;
  if (footerAt < 8) {
    return false;
  }
  const footer = new Cursor(await read(footerAt, FOOTER_BYTES));
  if (footer.u8() !== FOOTER) {
    return false;
  }
  footer.size();
  const summaryAt = footer.size();
  if (summaryAt === 0 || summaryAt >= footerAt) {
    return false;
  }
  const chunks: { at: number; length: number; start: bigint; channels: number[] }[] = [];
  const summary = new Cursor(await read(summaryAt, footerAt - summaryAt));
  while (summary.offset + 9 <= summary.data.length) {
    const opcode = summary.u8();
    const content = summary.bytes(summary.size());
    if (opcode !== CHUNK_INDEX) {
      records.record(opcode, content);
      continue;
    }
    const index = new Cursor(content);
    const start = index.u64();
    index.u64();
    const at = index.size();
    const length = index.size();
    const map = new Cursor(index.bytes(index.u32()));
    const channels: number[] = [];
    while (map.offset < map.data.length) {
      channels.push(map.u16());
      map.u64();
    }
    chunks.push({ at, length, start, channels });
  }
  if (chunks.length === 0) {
    return false;
  }
  const wanted = records.wanted();
  chunks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (const chunk of chunks.filter((c) => c.channels.some((id) => wanted.has(id)))) {
    const record = new Cursor(await read(chunk.at, chunk.length));
    const opcode = record.u8();
    records.record(opcode, record.bytes(record.size()));
  }
  return true;
}

// Record after record from the start, as far as the file goes
async function readSequentially(records: McapRecords, read: Read, size: number): Promise<void> {
  let position = 8;
  while (position + 9 <= size) {
    const header = new Cursor(await read(position, 9));
    const opcode = header.u8();
    const length = header.size();
    if (opcode === FOOTER || opcode === DATA_END) {
      break;
    }
    if ([SCHEMA, CHANNEL, MESSAGE, CHUNK].includes(opcode)) {
      const content = await read(position + 9, length);
      if (content.length < length) {
        // Cut short: a recording that did not end
        break;
      }
      records.record(opcode, content);
    }
    position += 9 + length;
  }
}

// ── SQLite ───────────────────────────────────────────────────────────────────

async function readSqlite(file: string, accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('Reading SQLite rosbags (.db3) needs Node.js 22.13 or newer');
  }
  let db: InstanceType<typeof sqlite.DatabaseSync>;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${errorMessage(e)}`);
  }
  try {
    const topics: BagTopics = new Map();
    const rows = db.prepare('SELECT id, name, type FROM topics').all() as { id: number; name: string; type: string }[];
    const select = db.prepare('SELECT timestamp, data FROM messages WHERE topic_id = ? ORDER BY timestamp');
    // Nanoseconds since the epoch: beyond a number's integers
    select.setReadBigInts(true);
    for (const row of rows) {
      const topic = { name: row.name, type: row.type };
      if (accept(topic)) {
        const messages = (select.all(row.id) as { timestamp: bigint; data: Uint8Array }[]).map((m) => ({
          time: nsToMs(m.timestamp),
          data: m.data,
        }));
        topics.set(topic.name, { topic, messages });
      }
    }
    return topics;
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${errorMessage(e)}`);
  } finally {
    db.close();
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

// Waited for ros2 bag record to say it records; quiet, it is taken as doing so
const START_TIMEOUT_MS = 8000;
// Then it is killed: the bag may lack its metadata
const STOP_TIMEOUT_MS = 10_000;
const READY = /Subscribed to topic|Listening for topics|Recording\.\.\./;
const OUTPUT_LIMIT = 4000;

// The folder a recording makes: a new one, absolute or ~/…, its parent made
export async function newBagFolder(input: string, home = os.homedir()): Promise<string> {
  const folder = absolute(input.trim().replace(/(.)\/+$/, '$1'), home);
  if (await fs.stat(folder).catch(() => null)) {
    throw new Error(`${folder} exists already: a recording makes a new folder`);
  }
  await fs.mkdir(path.dirname(folder), { recursive: true });
  return folder;
}

// ros2 bag record of topics into a new folder, until stopped
export class BagRecorder {
  readonly folder: string;
  // Called if it stops by itself, with why
  onExit: ((reason: string) => void) | null = null;
  private readonly child: ChildProcess;
  private output = '';
  private stopping = false;

  private constructor(child: ChildProcess, folder: string) {
    this.child = child;
    this.folder = folder;
  }

  // Resolves once it records, rejects with why it could not
  static start(folder: string, topics: string[]): Promise<BagRecorder> {
    return new Promise((resolve, reject) => {
      const child = spawn('ros2', ['bag', 'record', '-o', folder, ...topics], {
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const recorder = new BagRecorder(child, folder);
      let settled = false;
      const ready = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(recorder);
        }
      };
      const timer = setTimeout(ready, START_TIMEOUT_MS);
      const onOutput = (chunk: Buffer) => {
        recorder.output = (recorder.output + stripAnsi(chunk.toString())).slice(-OUTPUT_LIMIT);
        if (READY.test(recorder.output)) {
          ready();
        }
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      child.on('error', (e: NodeJS.ErrnoException) => {
        recorder.output = e.code === 'ENOENT' ? 'ros2 not found: is ROS sourced?' : errorMessage(e);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(recorder.output));
        }
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const lines = recorder.output.trim().split('\n').slice(-2).join(' ').trim();
        const reason = lines || `ros2 bag record exited (${signal ?? code})`;
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        } else if (!recorder.stopping) {
          recorder.onExit?.(reason);
        }
      });
    });
  }

  // As Ctrl+C does, which completes the bag
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.kill('SIGINT');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await closed;
    clearTimeout(timer);
  }
}
