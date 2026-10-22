// Rosbags (rosbag2) as files: what the Rosbags widget lists of a folder's
// bags (rosbags.ts), and the messages of some of a bag's topics, which the
// behavior tree inspectors play back. Either storage is read (MCAP, Jazzy's
// default, or SQLite, Humble's), compressed by rosbag2 or not (zstd, of each
// file or of each message); messages come serialized as recorded. Recording
// and playing them is ros2 bag's (rosbag_process.ts).

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import type { BagInfo, BagTopic as BagTopicInfo } from '../shared/rosbag.ts';
import { parseMetadata, type BagMetadata } from './rosbag_format.ts';
import { errorMessage } from './util.ts';

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

// A bag to read: its files in order, and how rosbag2 compressed its messages
export interface BagSource {
  files: string[];
  // zstd, or '' if not
  messageCompression: string;
}

// The files of a bag, compressed by rosbag2 (.zstd) or not
const BAG_FILE = /\.(mcap|db3)(\.zstd)?$/i;
const COMPRESSED = /\.zstd$/i;
const METADATA = 'metadata.yaml';
// SQLite bags without metadata are counted only up to this size: node:sqlite
// blocks the server while it reads
const SQLITE_SCAN_BYTES = 64 * 1024 * 1024;

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// An absolute path from /… or ~/…
export function bagPath(input: string, home = os.homedir()): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`Not a path: "${input}" (/…, ~/…)`);
  }
  return path.resolve(expanded);
}

const nsToMs = (ns: bigint) => Number(ns / 1000n) / 1000;

async function readMetadata(folder: string): Promise<BagMetadata | null> {
  const text = await fs.readFile(path.join(folder, METADATA), 'utf8').catch(() => null);
  return text === null ? null : parseMetadata(text);
}

// A bag: its folder (its files those its metadata names, else those it has,
// split bags' in order), or one of its files
export async function openBag(input: string, home = os.homedir()): Promise<BagSource> {
  const location = bagPath(input, home);
  const stat = await fs.stat(location).catch(() => null);
  if (!stat) {
    throw new Error(`No rosbag at ${location}`);
  }
  if (!stat.isDirectory()) {
    if (!BAG_FILE.test(location)) {
      throw new Error(`Not a rosbag: ${location} (a bag’s folder, an .mcap or .db3 file)`);
    }
    return { files: [location], messageCompression: '' };
  }
  let metadata: BagMetadata | null = null;
  try {
    metadata = await readMetadata(location);
  } catch {
    // Its files are read without it
  }
  const names = await fs.readdir(location);
  let files = metadata?.files.filter((name) => names.includes(name)) ?? [];
  if (files.length === 0) {
    const found = names.filter((name) => BAG_FILE.test(name)).sort(natural);
    // A compressed bag played leaves its files uncompressed beside them
    const plain = found.filter((name) => !COMPRESSED.test(name));
    files = plain.length ? plain : found;
  }
  if (files.length === 0) {
    throw new Error(`No rosbag in ${location}: no .mcap nor .db3 file`);
  }
  return {
    files: files.map((name) => path.join(location, name)),
    messageCompression: metadata?.compression?.mode === 'message' ? metadata.compression.format : '',
  };
}

// The files of a bag: see openBag
export async function bagFiles(input: string, home = os.homedir()): Promise<string[]> {
  return (await openBag(input, home)).files;
}

// The messages of the topics accepted, by topic, in the order recorded
export async function readBag(bag: BagSource | string[], accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  const { files, messageCompression } = Array.isArray(bag) ? { files: bag, messageCompression: '' } : bag;
  const topics: BagTopics = new Map();
  for (const file of files) {
    const read = await readFile(file, accept);
    for (const [name, found] of read) {
      if (messageCompression) {
        for (const message of found.messages) {
          message.data = decompress(messageCompression, Buffer.from(message.data));
        }
      }
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

function readFile(file: string, accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  if (COMPRESSED.test(file)) {
    return withDecompressed(file, (plain) => readFile(plain, accept));
  }
  return /\.mcap$/i.test(file) ? readMcap(file, accept) : readSqlite(file, accept);
}

// A file rosbag2 compressed whole, decompressed into a folder of its own for
// the time of use
async function withDecompressed<T>(file: string, use: (plain: string) => Promise<T>): Promise<T> {
  if (typeof zlib.createZstdDecompress !== 'function') {
    throw new Error('Reading zstd compressed rosbags needs Node.js 22.15 or newer');
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tassello-bag-'));
  try {
    const plain = path.join(folder, path.basename(file).replace(COMPRESSED, ''));
    await pipeline(createReadStream(file), zlib.createZstdDecompress(), createWriteStream(plain)).catch((e: unknown) => {
      throw new Error(`Cannot decompress ${file}: ${errorMessage(e)}`);
    });
    return await use(plain);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

// ── What a bag holds ─────────────────────────────────────────────────────────

// Of a file without reading its messages: its topics, with their counts and
// its time span if known; null if it cannot tell (e.g. an MCAP file without
// its summary, being recorded)
interface FileSummary {
  storage: string;
  topics: BagTopicInfo[];
  start: number | null;
  end: number | null;
}

async function fileSummary(file: string, size: number): Promise<FileSummary | null> {
  if (COMPRESSED.test(file)) {
    return null;
  }
  return /\.mcap$/i.test(file) ? mcapSummary(file) : sqliteSummary(file, size);
}

// A bag's folder, or one of its files, as listed: its metadata, else its
// files' summaries. Throws if it is not a bag.
export async function bagInfo(input: string, home = os.homedir()): Promise<BagInfo> {
  const location = bagPath(input, home);
  const stat = await fs.stat(location).catch(() => null);
  if (!stat) {
    throw new Error(`No rosbag at ${location}`);
  }
  const info: BagInfo = {
    path: location,
    name: path.basename(location),
    size: 0,
    modified: stat.mtimeMs,
    storage: '',
    start: null,
    duration: null,
    messages: null,
    topics: [],
    files: [],
    compression: null,
    recording: false,
    problem: null,
  };
  let metadata: BagMetadata | null = null;
  let names: string[];
  if (stat.isDirectory()) {
    try {
      metadata = await readMetadata(location);
    } catch (e) {
      info.problem = `Its ${METADATA} cannot be read: ${errorMessage(e)}`;
    }
    const entries = await fs.readdir(location);
    names = metadata?.files.filter((name) => entries.includes(name)) ?? [];
    if (names.length === 0) {
      names = entries.filter((name) => BAG_FILE.test(name)).sort(natural);
    }
    if (!metadata && names.length === 0) {
      throw new Error(`No rosbag in ${location}`);
    }
  } else if (BAG_FILE.test(location)) {
    names = [path.basename(location)];
  } else {
    throw new Error(`Not a rosbag: ${location}`);
  }
  const folder = stat.isDirectory() ? location : path.dirname(location);
  for (const name of names) {
    const file = await fs.stat(path.join(folder, name)).catch(() => null);
    if (file) {
      info.files.push({ name, size: file.size });
      info.size += file.size;
      info.modified = Math.max(info.modified, file.mtimeMs);
    }
  }
  if (metadata) {
    Object.assign(info, {
      storage: metadata.storage,
      start: metadata.start,
      duration: metadata.duration,
      messages: metadata.messages,
      topics: metadata.topics,
      compression: metadata.compression,
    });
    if (info.files.length < names.length) {
      info.problem = `${names.length - info.files.length} of its files missing`;
    }
    return info;
  }
  // Without metadata: what its files say of themselves
  const topics = new Map<string, BagTopicInfo>();
  let start = Infinity;
  let end = -Infinity;
  let known = true;
  for (const { name, size } of info.files) {
    let summary: FileSummary | null = null;
    try {
      summary = await fileSummary(path.join(folder, name), size);
    } catch {
      // As if it said nothing
    }
    if (!summary) {
      known = false;
      continue;
    }
    info.storage ||= summary.storage;
    for (const topic of summary.topics) {
      const seen = topics.get(topic.name);
      if (!seen) {
        topics.set(topic.name, { ...topic });
      } else if (seen.count !== null) {
        seen.count = topic.count === null ? null : seen.count + topic.count;
      }
    }
    if (summary.start === null || summary.end === null) {
      known = false;
    } else {
      start = Math.min(start, summary.start);
      end = Math.max(end, summary.end);
    }
  }
  info.storage ||= /\.mcap/i.test(names[0] ?? '') ? 'mcap' : 'sqlite3';
  info.topics = [...topics.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (known && Number.isFinite(start)) {
    info.start = start;
    info.duration = end - start;
    info.messages = info.topics.every((topic) => topic.count !== null)
      ? info.topics.reduce((sum, topic) => sum + (topic.count ?? 0), 0)
      : null;
  }
  if (stat.isDirectory() && !info.problem) {
    info.problem = `No ${METADATA}: being recorded, or its recording did not end (ros2 bag reindex makes it)`;
  }
  return info;
}

// The version of a bag as files: its files' names, sizes and times
async function bagVersion(location: string, directory: boolean): Promise<string> {
  const names = directory ? await fs.readdir(location) : [''];
  const parts = await Promise.all(
    names.map(async (name) => {
      const stat = await fs.stat(path.join(location, name)).catch(() => null);
      return stat ? `${name}:${stat.size}:${stat.mtimeMs}` : name;
    }),
  );
  return parts.sort().join('|');
}

export type BagCache = Map<string, { version: string; info: BagInfo }>;

// The bags of a folder (its folders that are bags, and its lone bag files),
// the newest first. A folder not there yet has none. Bags read before are
// read again only if their files changed.
export async function listBags(folder: string, cache: BagCache = new Map(), home = os.homedir()): Promise<BagInfo[]> {
  const location = bagPath(folder, home);
  const entries = await fs.readdir(location, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Cannot read ${location}: ${e.code ?? errorMessage(e)}`);
  });
  const bags: BagInfo[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(location, entry.name);
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      directory = (await fs.stat(full).catch(() => null))?.isDirectory() ?? false;
    }
    if (directory) {
      const inside = await fs.readdir(full).catch(() => [] as string[]);
      if (!inside.some((name) => name === METADATA || BAG_FILE.test(name))) {
        continue;
      }
    } else if (!/\.(mcap|db3)$/i.test(entry.name)) {
      continue;
    }
    seen.add(full);
    const version = await bagVersion(full, directory);
    const cached = cache.get(full);
    if (cached?.version === version) {
      bags.push(cached.info);
      continue;
    }
    let info: BagInfo;
    try {
      info = await bagInfo(full, home);
    } catch {
      // Gone while read, or not a bag after all
      continue;
    }
    cache.set(full, { version, info });
    bags.push(info);
  }
  for (const key of cache.keys()) {
    if (path.dirname(key) === location && !seen.has(key)) {
      cache.delete(key);
    }
  }
  return bags.sort((a, b) => (b.start ?? b.modified) - (a.start ?? a.modified));
}

// The folder a recording makes: a new one, absolute or ~/…, its parent made
export async function newBagFolder(input: string, home = os.homedir()): Promise<string> {
  const folder = bagPath(input.trim().replace(/(.)\/+$/, '$1'), home);
  if (await fs.stat(folder).catch(() => null)) {
    throw new Error(`${folder} exists already: a recording makes a new folder`);
  }
  await fs.mkdir(path.dirname(folder), { recursive: true });
  return folder;
}

// Of a folder's files, bytes
export async function folderSize(folder: string): Promise<number> {
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map((name) => fs.stat(path.join(folder, name)).then((s) => (s.isFile() ? s.size : 0), () => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
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
const STATISTICS = 0x0b;
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

// MCAP's chunks, and rosbag2's messages
function decompress(compression: string, data: Buffer): Buffer {
  if (!compression) {
    return data;
  }
  if (compression === 'zstd') {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('Reading zstd compressed rosbags needs Node.js 22.15 or newer');
    }
    return zlib.zstdDecompressSync(data);
  }
  throw new Error(`Rosbags compressed with ${compression} are not read: record with zstd, or without compression`);
}

interface McapStatistics {
  start: number;
  end: number;
  // By channel
  counts: Map<number, number>;
}

// What the records of a file say: its schemas and channels, its statistics,
// and the messages of the channels accepted
class McapRecords {
  readonly topics: BagTopics = new Map();
  // Every channel, and those whose messages are read
  readonly channels = new Map<number, BagTopic>();
  readonly accepted = new Set<number>();
  statistics: McapStatistics | null = null;
  private readonly schemas = new Map<number, string>();
  private readonly accept: (topic: BagTopic) => boolean;

  constructor(accept: (topic: BagTopic) => boolean) {
    this.accept = accept;
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
          this.channels.set(id, topic);
          if (this.accept(topic)) {
            this.accepted.add(id);
          }
        }
        break;
      }
      case MESSAGE: {
        const id = cursor.u16();
        const topic = this.accepted.has(id) ? this.channels.get(id) : undefined;
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
      case STATISTICS: {
        cursor.u64();
        cursor.u16();
        cursor.offset += 4 * 4;
        const start = nsToMs(cursor.u64());
        const end = nsToMs(cursor.u64());
        const map = new Cursor(cursor.bytes(cursor.u32()));
        const counts = new Map<number, number>();
        while (map.offset < map.data.length) {
          counts.set(map.u16(), Number(map.u64()));
        }
        this.statistics = { start, end, counts };
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

type Read = (position: number, length: number) => Promise<Buffer>;

// Opens an MCAP file for use: throws if it is not one
async function withMcap<T>(file: string, use: (read: Read, size: number) => Promise<T>): Promise<T> {
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
    return await use(read, size);
  } finally {
    await handle.close();
  }
}

async function readMcap(file: string, accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  return withMcap(file, async (read, size) => {
    const records = new McapRecords(accept);
    if (!(await readIndexed(records, read, size, true))) {
      await readSequentially(records, read, size);
    }
    return records.topics;
  });
}

// Its channels and statistics, from its summary
async function mcapSummary(file: string): Promise<FileSummary | null> {
  return withMcap(file, async (read, size) => {
    const records = new McapRecords(() => false);
    await readIndexed(records, read, size, false);
    const { statistics } = records;
    if (records.channels.size === 0 && !statistics) {
      return null;
    }
    const topics = [...records.channels].map(([id, topic]) => ({ ...topic, count: statistics?.counts.get(id) ?? (statistics ? 0 : null) }));
    // Statistics of a file without messages say 0 for both
    const timed = statistics && statistics.end >= statistics.start && statistics.end > 0;
    return { storage: 'mcap', topics, start: timed ? statistics.start : null, end: timed ? statistics.end : null };
  });
}

// From the summary at the end of the file: the channels, the statistics, and
// (chunks) where the chunks with messages of those accepted are, which alone
// are read. false if the file has no summary (unfinished, or written without
// chunks).
async function readIndexed(records: McapRecords, read: Read, size: number, chunks: boolean): Promise<boolean> {
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
  const indexes: { at: number; length: number; start: bigint; channels: number[] }[] = [];
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
    indexes.push({ at, length, start, channels });
  }
  if (!chunks) {
    return true;
  }
  if (indexes.length === 0) {
    return false;
  }
  indexes.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (const chunk of indexes.filter((c) => c.channels.some((id) => records.accepted.has(id)))) {
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

async function withSqlite<T>(file: string, use: (db: import('node:sqlite').DatabaseSync) => T): Promise<T> {
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
    return use(db);
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${errorMessage(e)}`);
  } finally {
    db.close();
  }
}

type TopicRow = { id: number; name: string; type: string };

async function readSqlite(file: string, accept: (topic: BagTopic) => boolean): Promise<BagTopics> {
  return withSqlite(file, (db) => {
    const topics: BagTopics = new Map();
    const rows = db.prepare('SELECT id, name, type FROM topics').all() as TopicRow[];
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
  });
}

// Its topics; their counts and its time span if small enough to count
async function sqliteSummary(file: string, size: number): Promise<FileSummary> {
  return withSqlite(file, (db) => {
    const rows = db.prepare('SELECT id, name, type FROM topics').all() as TopicRow[];
    if (size > SQLITE_SCAN_BYTES) {
      return { storage: 'sqlite3', topics: rows.map((row) => ({ name: row.name, type: row.type, count: null })), start: null, end: null };
    }
    const select = db.prepare('SELECT topic_id, COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM messages GROUP BY topic_id');
    select.setReadBigInts(true);
    const counts = new Map<number, { count: bigint; first: bigint; last: bigint }>();
    for (const row of select.all() as { topic_id: bigint; count: bigint; first: bigint; last: bigint }[]) {
      counts.set(Number(row.topic_id), row);
    }
    const spans = [...counts.values()];
    return {
      storage: 'sqlite3',
      topics: rows.map((row) => ({ name: row.name, type: row.type, count: Number(counts.get(row.id)?.count ?? 0n) })),
      start: spans.length ? Math.min(...spans.map((s) => nsToMs(s.first))) : null,
      end: spans.length ? Math.max(...spans.map((s) => nsToMs(s.last))) : null,
    };
  });
}
