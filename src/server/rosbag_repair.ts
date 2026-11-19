// Rosbags whose recording did not end: rosbag2 writes a bag's metadata.yaml
// as its recording stops, and ros2 bag plays no bag without it. A repair
// writes it from what the bag's files hold, as ros2 bag reindex does, but for
// compressed bags too (Humble's reindex skips their .zstd files). Each file
// is read whole, as rosbag2 will read it: decompressed if rosbag2 compressed
// it, MCAP's chunks one after the other, SQLite's messages by batches. A file cut short counts its
// messages up to its last whole chunk, which is as far as rosbag2 plays it;
// one of which nothing can be read (empty, cut short in its first chunk,
// compressed only in part) is left out of the metadata. The file being
// recorded as a compressed bag's recording ended is compressed, as rosbag2
// would have, its .zstd made beside it; a .zstd cut short (rosbag2 fails on
// it) is made again from its file, if still there. Nothing else of the bag is
// changed.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, pipeline, type Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import zlib from 'node:zlib';

import type { BagRepair } from '../shared/rosbag.ts';
import { BAG_FILE, COMPRESSED, Cursor, MCAP_MAGIC, METADATA, bagPath, decompress, natural, withDecompressed, withSqlite } from './rosbag.ts';
import { metadataVersion, metadataYaml, type RepairedFile, type RepairedTopic } from './rosbag_format.ts';
import { errorMessage } from './util.ts';

export interface RepairProgress {
  // Of the bag's files' bytes, those read so far, and all to read
  done: number;
  total: number;
}

export interface RepairOptions {
  // The distribution of the server's ROS: of the metadata's version, when
  // the bag's files do not tell
  distro: string;
  onProgress?: (progress: RepairProgress) => void;
  signal?: AbortSignal;
  // A bag whose files were written to more recently is taken as being
  // recorded, and not repaired
  quietMs?: number;
}

const QUIET_MS = 10_000;
// SQLite's messages counted this many at a time, the server answering others
// in between
const SQLITE_BATCH = 20_000;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// MCAP's records (https://mcap.dev/spec)
const FOOTER = 0x02;
const SCHEMA = 0x03;
const CHANNEL = 0x04;
const MESSAGE = 0x05;
const CHUNK = 0x06;
const CHUNK_INDEX = 0x08;
const STATISTICS = 0x0b;
const METADATA_RECORD = 0x0c;
const FOOTER_BYTES = 1 + 8 + 8 + 8 + 4;
// Those a scan reads; the others it skips
const READ = new Set([SCHEMA, CHANNEL, MESSAGE, CHUNK, METADATA_RECORD]);

// ── What a file holds ────────────────────────────────────────────────────────

interface ScannedTopic {
  name: string;
  type: string;
  serializationFormat: string;
  qos: string;
  typeHash: string;
  count: number;
}

class FileScan {
  readonly topics = new Map<string, ScannedTopic>();
  count = 0;
  start: bigint | null = null;
  end: bigint | null = null;
  // Its first message zstd compressed: rosbag2 compressed each message
  messageCompressed: boolean | null = null;
  // Of the rosbag2 that recorded it, if it says
  distro = '';

  topic(name: string, fields: Omit<ScannedTopic, 'name' | 'count'>): ScannedTopic {
    let topic = this.topics.get(name);
    if (!topic) {
      topic = { name, count: 0, ...fields };
      this.topics.set(name, topic);
    }
    return topic;
  }

  message(topic: ScannedTopic, time: bigint, count = 1): void {
    topic.count += count;
    this.count += count;
    this.span(time, time);
  }

  span(first: bigint, last: bigint): void {
    if (this.start === null || first < this.start) {
      this.start = first;
    }
    if (this.end === null || last > this.end) {
      this.end = last;
    }
  }

  firstMessage(data: Uint8Array): void {
    this.messageCompressed ??= ZSTD_MAGIC.every((byte, i) => data[i] === byte);
  }
}

// Reads a stream by lengths, joining or splitting what it gives
class ByteStream {
  private readonly iterator: AsyncIterator<Buffer>;
  private parts: Buffer[] = [];
  private size = 0;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  // Exactly length bytes; null if the stream ends first
  async read(length: number): Promise<Buffer | null> {
    while (this.size < length) {
      const next = await this.iterator.next();
      if (next.done) {
        return null;
      }
      this.parts.push(next.value);
      this.size += next.value.length;
    }
    const joined = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
    this.parts = joined.length > length ? [joined.subarray(length)] : [];
    this.size -= length;
    return joined.subarray(0, length);
  }

  // false if the stream ends first
  async skip(length: number): Promise<boolean> {
    let left = length;
    while (left > 0) {
      if (this.parts.length === 0) {
        const next = await this.iterator.next();
        if (next.done) {
          return false;
        }
        this.parts.push(next.value);
        this.size += next.value.length;
      }
      const first = this.parts[0];
      const taken = Math.min(left, first.length);
      if (taken === first.length) {
        this.parts.shift();
      } else {
        this.parts[0] = first.subarray(taken);
      }
      this.size -= taken;
      left -= taken;
    }
    return true;
  }

  // To its end, for a compressed file to show it decompresses whole
  async drain(): Promise<void> {
    this.parts = [];
    this.size = 0;
    while (!(await this.iterator.next()).done) {
      // Read on
    }
  }
}

function readMap(cursor: Cursor): Map<string, string> {
  const map = new Map<string, string>();
  const entries = new Cursor(cursor.bytes(cursor.u32()));
  while (entries.offset < entries.data.length) {
    map.set(entries.string(), entries.string());
  }
  return map;
}

// The records of an MCAP file, as they come, into its scan
class McapScan {
  readonly scan: FileScan;
  private readonly schemas = new Map<number, string>();
  private readonly channels = new Map<number, ScannedTopic>();

  constructor(scan: FileScan) {
    this.scan = scan;
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
        const name = cursor.string();
        const serializationFormat = cursor.string();
        const metadata = readMap(cursor);
        if (!this.channels.has(id)) {
          const topic = this.scan.topic(name, {
            type: this.schemas.get(schema) ?? '',
            serializationFormat,
            qos: metadata.get('offered_qos_profiles') ?? '',
            typeHash: metadata.get('topic_type_hash') ?? '',
          });
          this.channels.set(id, topic);
        }
        break;
      }
      case MESSAGE: {
        const topic = this.channels.get(cursor.u16());
        if (!topic) {
          break;
        }
        cursor.u32();
        const time = cursor.u64();
        cursor.u64();
        this.scan.firstMessage(content.subarray(cursor.offset, cursor.offset + 4));
        this.scan.message(topic, time);
        break;
      }
      case CHUNK: {
        cursor.offset += 8 + 8 + 8 + 4;
        const compression = cursor.string();
        if (compression !== '' && compression !== 'zstd') {
          throw new Error(`Its MCAP chunks are ${compression} compressed, which Tassello does not read`);
        }
        const records = decompress(compression, cursor.bytes(cursor.size()));
        // Whole, or not at all
        const parsed: [number, Buffer][] = [];
        const inner = new Cursor(records);
        while (inner.offset + 9 <= records.length) {
          const op = inner.u8();
          parsed.push([op, inner.bytes(inner.size())]);
        }
        for (const [op, record] of parsed) {
          this.record(op, record);
        }
        break;
      }
      case METADATA_RECORD: {
        const name = cursor.string();
        const metadata = readMap(cursor);
        if (name === 'rosbag2') {
          this.scan.distro ||=
            metadata.get('ROS_DISTRO') ?? /^ros_distro:\s*(\S+)/m.exec(metadata.get('serialized_metadata') ?? '')?.[1] ?? '';
        }
        break;
      }
    }
  }
}

type ScanEnd = 'complete' | 'cut' | 'empty';

// An MCAP file from the start, record after record, as far as it goes, its
// summary too (its channels without messages are there only): complete if it
// reaches its footer
async function scanMcapStream(source: AsyncIterable<Buffer>, scan: FileScan, signal?: AbortSignal): Promise<ScanEnd> {
  const stream = new ByteStream(source);
  const magic = await stream.read(8);
  if (!magic) {
    return 'empty';
  }
  if (!MCAP_MAGIC.every((byte, i) => magic[i] === byte)) {
    throw new Error('not an MCAP file');
  }
  const records = new McapScan(scan);
  for (;;) {
    signal?.throwIfAborted();
    const header = await stream.read(9);
    if (!header) {
      return 'cut';
    }
    const opcode = header[0];
    const length = Number(header.readBigUInt64LE(1));
    if (opcode === FOOTER) {
      await stream.drain();
      return 'complete';
    }
    if (!READ.has(opcode)) {
      if (!(await stream.skip(length))) {
        return 'cut';
      }
      continue;
    }
    const content = await stream.read(length);
    if (!content) {
      return 'cut';
    }
    try {
      records.record(opcode, content);
    } catch (e) {
      if (e instanceof RangeError) {
        // A record garbled: as far as rosbag2 reads it too
        return 'cut';
      }
      throw e;
    }
  }
}

// A complete MCAP file, from its summary alone: false if it has none, or one
// without statistics
async function mcapFromSummary(file: string, scan: FileScan): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 8);
    const footerAt = size - 8 - FOOTER_BYTES;
    if (!MCAP_MAGIC.every((byte, i) => head[i] === byte) || footerAt < 8) {
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
    const summary = new Cursor(await read(summaryAt, footerAt - summaryAt));
    const records = new McapScan(new FileScan());
    let statistics: { start: bigint; end: bigint; counts: Map<number, bigint> } | null = null;
    let first: { start: bigint; at: number; length: number } | null = null;
    const channels = new Map<number, string>();
    while (summary.offset + 9 <= summary.data.length) {
      const opcode = summary.u8();
      const content = summary.bytes(summary.size());
      const cursor = new Cursor(content);
      if (opcode === STATISTICS) {
        cursor.u64();
        cursor.u16();
        cursor.offset += 4 * 4;
        const start = cursor.u64();
        const end = cursor.u64();
        const map = new Cursor(cursor.bytes(cursor.u32()));
        const counts = new Map<number, bigint>();
        while (map.offset < map.data.length) {
          counts.set(map.u16(), map.u64());
        }
        statistics = { start, end, counts };
      } else if (opcode === CHUNK_INDEX) {
        const start = cursor.u64();
        cursor.u64();
        const at = cursor.size();
        const length = cursor.size();
        if (!first || start < first.start) {
          first = { start, at, length };
        }
      } else if (opcode === CHANNEL) {
        const id = cursor.u16();
        cursor.u16();
        channels.set(id, cursor.string());
        records.record(opcode, content);
      } else if (opcode === SCHEMA) {
        records.record(opcode, content);
      }
    }
    if (!statistics) {
      return false;
    }
    for (const [id, name] of channels) {
      const known = records.scan.topics.get(name);
      if (known) {
        const { type, serializationFormat, qos, typeHash } = known;
        scan.topic(name, { type, serializationFormat, qos, typeHash }).count += Number(statistics.counts.get(id) ?? 0n);
      }
    }
    scan.count = [...scan.topics.values()].reduce((sum, topic) => sum + topic.count, 0);
    if (scan.count > 0) {
      scan.span(statistics.start, statistics.end);
    }
    // Whether rosbag2 compressed each message, from the first (of the
    // summary's channels: counted apart)
    if (first) {
      const chunk = new Cursor(await read(first.at, first.length));
      const opcode = chunk.u8();
      records.record(opcode, chunk.bytes(chunk.size()));
      scan.messageCompressed = records.scan.messageCompressed;
    }
    return true;
  } catch (e) {
    if (e instanceof RangeError) {
      return false;
    }
    throw e;
  } finally {
    await handle.close();
  }
}

// A file's bytes, decompressed if compressed, its bytes read counted
function fileStream(file: string, compressed: boolean, onBytes: (bytes: number) => void): Readable {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  const raw = createReadStream(file, { highWaterMark: 1 << 20 });
  const ignore = () => {};
  if (!compressed) {
    return pipeline(raw, counter, ignore);
  }
  if (typeof zlib.createZstdDecompress !== 'function') {
    throw new Error('Repairing zstd compressed rosbags needs Node.js 22.15 or newer');
  }
  return pipeline(raw, counter, zlib.createZstdDecompress(), ignore);
}

// The messages of a SQLite file, counted a batch at a time
async function scanSqlite(file: string, scan: FileScan, signal: AbortSignal | undefined, onFraction: (fraction: number) => void): Promise<ScanEnd> {
  const { size } = await fs.stat(file);
  if (size === 0) {
    return 'empty';
  }
  return withSqlite<ScanEnd>(file, async (db) => {
    const columns = new Set((db.prepare('PRAGMA table_info(topics)').all() as { name: string }[]).map((column) => column.name));
    const rows = db.prepare('SELECT * FROM topics').all() as Record<string, unknown>[];
    const byId = new Map<number, ScannedTopic>();
    for (const row of rows) {
      byId.set(
        Number(row.id),
        scan.topic(String(row.name), {
          type: String(row.type ?? ''),
          serializationFormat: String(row.serialization_format ?? 'cdr'),
          qos: String(row.offered_qos_profiles ?? ''),
          typeHash: columns.has('type_description_hash') ? String(row.type_description_hash ?? '') : '',
        }),
      );
    }
    try {
      scan.distro = String((db.prepare('SELECT ros_distro FROM schema LIMIT 1').get() as { ros_distro?: string } | undefined)?.ros_distro ?? '');
    } catch {
      // Before Iron: no schema table
    }
    const last = db.prepare('SELECT MAX(id) AS last FROM messages');
    last.setReadBigInts(true);
    const lastId = (last.get() as { last: bigint | null }).last ?? 0n;
    const head = db.prepare('SELECT substr(data, 1, 4) AS head FROM messages ORDER BY id LIMIT 1').get() as { head: Uint8Array } | undefined;
    if (head) {
      scan.firstMessage(head.head);
    }
    const batch = db.prepare(
      'SELECT topic_id, COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM messages WHERE id > ? AND id <= ? GROUP BY topic_id',
    );
    batch.setReadBigInts(true);
    for (let from = 0n; from < lastId; from += BigInt(SQLITE_BATCH)) {
      signal?.throwIfAborted();
      for (const row of batch.all(from, from + BigInt(SQLITE_BATCH)) as { topic_id: bigint; count: bigint; first: bigint; last: bigint }[]) {
        const topic = byId.get(Number(row.topic_id));
        if (topic) {
          topic.count += Number(row.count);
          scan.count += Number(row.count);
          scan.span(row.first, row.last);
        }
      }
      onFraction(Number(from) / Number(lastId));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return 'complete' as const;
  });
}

// ── The bag ──────────────────────────────────────────────────────────────────

// The processes with one of the folder's files open (Linux): recording it
async function writers(folder: string): Promise<string[]> {
  if (process.platform !== 'linux') {
    return [];
  }
  const found: string[] = [];
  const pids = await fs.readdir('/proc').catch(() => [] as string[]);
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
      continue;
    }
    const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      if (target.startsWith(`${folder}/`)) {
        const name = (await fs.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim();
        found.push(name ? `${name} (${pid})` : pid);
        break;
      }
    }
  }
  return found;
}

// Of one of the bag's files, compressed by rosbag2 or not: the one it has as
// a .zstd, the one it has uncompressed, or both
interface BagFileNames {
  // Uncompressed, as rosbag2 names it in its metadata's files
  base: string;
  plain: string | null;
  compressed: string | null;
}

interface Used {
  name: string;
  base: string;
  scan: FileScan;
}

// A file whose zstd compression is cut short, which rosbag2 cannot open
class Undecompressable extends Error {}

// Writes the metadata.yaml of a bag's folder without one: see the top
export async function repairBag(input: string, options: RepairOptions): Promise<BagRepair> {
  const { signal } = options;
  const location = bagPath(input);
  const name = path.basename(location);
  const stat = await fs.stat(location).catch(() => null);
  if (!stat) {
    throw new Error(`No rosbag at ${location}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${name} is a file: a repair writes the metadata.yaml of a bag’s folder`);
  }
  const entries = await fs.readdir(location);
  if (entries.includes(METADATA)) {
    throw new Error(`${name} has its ${METADATA} already`);
  }
  const names = entries.filter((entry) => BAG_FILE.test(entry));
  if (names.length === 0) {
    throw new Error(`No rosbag in ${location}: no .mcap nor .db3 file`);
  }
  const extensions = new Set(names.map((entry) => entry.replace(COMPRESSED, '').replace(/^.*\./, '').toLowerCase()));
  if (extensions.size > 1) {
    throw new Error(`${name} holds both MCAP and SQLite files: which are its own?`);
  }
  const storage = extensions.has('mcap') ? 'mcap' : 'sqlite3';

  // Not while being recorded
  const open = await writers(location);
  if (open.length > 0) {
    throw new Error(`${name} is open in ${open.join(', ')}: is it being recorded? Repair it once its recording has ended`);
  }
  const sizes = new Map<string, { size: number; modified: number }>();
  for (const entry of names) {
    const file = await fs.stat(path.join(location, entry));
    sizes.set(entry, { size: file.size, modified: file.mtimeMs });
  }
  const newest = Math.max(...[...sizes.values()].map((file) => file.modified));
  const quiet = options.quietMs ?? QUIET_MS;
  if (Date.now() - newest < quiet) {
    throw new Error(`${name} was written to ${Math.max(0, Math.round((Date.now() - newest) / 1000))} s ago: is it being recorded? Repair it once its recording has ended`);
  }

  const byBase = new Map<string, BagFileNames>();
  for (const entry of names) {
    const base = entry.replace(COMPRESSED, '');
    const known = byBase.get(base) ?? { base, plain: null, compressed: null };
    known[COMPRESSED.test(entry) ? 'compressed' : 'plain'] = entry;
    byBase.set(base, known);
  }
  const files = [...byBase.values()].sort((a, b) => natural(a.base, b.base));
  // rosbag2 compressed the bag's files: those it did not have time to, it is
  // done for
  const fileCompressed = files.some((file) => file.compressed);

  const progress: RepairProgress = { done: 0, total: 0 };
  for (const file of files) {
    const read = fileCompressed ? (file.compressed ?? file.plain) : file.plain;
    progress.total += read ? (sizes.get(read)?.size ?? 0) : 0;
  }
  const report = () => options.onProgress?.({ ...progress });
  const onBytes = (bytes: number) => {
    progress.done += bytes;
    report();
  };
  report();

  // What a file holds: null if nothing, why in skipped
  const skipped: BagRepair['skipped'] = [];
  const scanFile = async (entry: string): Promise<FileScan | null> => {
    const file = path.join(location, entry);
    const compressed = COMPRESSED.test(entry);
    const scan = new FileScan();
    const before = progress.done;
    const size = sizes.get(entry)?.size ?? 0;
    let end: ScanEnd;
    try {
      if (storage === 'sqlite3') {
        const scanPlain = (plain: string) =>
          scanSqlite(plain, scan, signal, (fraction) => {
            progress.done = before + Math.round(fraction * size);
            report();
          });
        end = compressed ? await withDecompressed(file, scanPlain, location).catch(rethrowUndecompressable) : await scanPlain(file);
      } else if (!compressed && (await mcapFromSummary(file, scan))) {
        end = 'complete';
      } else {
        const stream = fileStream(file, compressed, onBytes);
        try {
          end = await scanMcapStream(stream, scan, signal).catch((e: unknown) => {
            const code = (e as NodeJS.ErrnoException).code;
            throw compressed && typeof code === 'string' && code.startsWith('ZSTD_') ? new Undecompressable(errorMessage(e)) : e;
          });
        } finally {
          stream.destroy();
        }
        // rosbag2 compresses a file once complete: cut short, its compression
        // was (zstd's stream ends without a word), and rosbag2 fails on it
        if (compressed && end !== 'complete') {
          throw new Undecompressable('cut short');
        }
      }
    } catch (e) {
      signal?.throwIfAborted();
      if (e instanceof Undecompressable) {
        skipped.push({ name: entry, reason: `compressed only in part (${e.message})` });
        return null;
      }
      skipped.push({ name: entry, reason: errorMessage(e) });
      return null;
    } finally {
      progress.done = before + size;
      report();
    }
    if (scan.count === 0) {
      skipped.push({ name: entry, reason: end === 'empty' ? 'empty' : end === 'cut' ? 'cut short before its first message' : 'no message' });
      return null;
    }
    return scan;
  };

  const used: Used[] = [];
  const toCompress: { plain: string; compressed: string }[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (!fileCompressed) {
      const scan = await scanFile(file.plain!);
      if (scan) {
        used.push({ name: file.plain!, base: file.base, scan });
      }
      continue;
    }
    if (file.compressed) {
      const scan = await scanFile(file.compressed);
      if (scan) {
        // Its uncompressed copy, if any, left by a playback
        used.push({ name: file.compressed, base: file.base, scan });
        continue;
      }
      if (!file.plain) {
        continue;
      }
      // Its compression cut short: rosbag2 deletes the file it compresses
      // once compressed only, so that one is whole, read instead
      skipped.pop();
      progress.total += sizes.get(file.plain)?.size ?? 0;
    }
    const plain = file.plain!;
    const scan = await scanFile(plain);
    if (scan) {
      const compressed = `${plain}.zstd`;
      toCompress.push({ plain, compressed });
      used.push({ name: compressed, base: file.base, scan });
    }
  }
  if (used.length === 0) {
    const why = skipped.map((file) => `${file.name}: ${file.reason}`).join('; ');
    throw new Error(`Nothing of ${name} can be read${why ? ` (${why})` : ''}`);
  }

  for (const { plain, compressed } of toCompress) {
    signal?.throwIfAborted();
    progress.total += sizes.get(plain)?.size ?? 0;
    await compressFile(path.join(location, plain), path.join(location, compressed), onBytes, signal);
  }

  const topics = new Map<string, RepairedTopic>();
  for (const { scan } of used) {
    for (const topic of scan.topics.values()) {
      const known = topics.get(topic.name);
      if (!known) {
        topics.set(topic.name, { ...topic });
        continue;
      }
      known.count += topic.count;
      known.type ||= topic.type;
      known.qos ||= topic.qos;
      known.typeHash ||= topic.typeHash;
    }
  }
  const sorted = [...topics.values()].sort((a, b) => a.name.localeCompare(b.name));
  const start = used.reduce((min, { scan }) => (scan.start! < min ? scan.start! : min), used[0].scan.start!);
  const end = used.reduce((max, { scan }) => (scan.end! > max ? scan.end! : max), used[0].scan.end!);
  const count = used.reduce((sum, { scan }) => sum + scan.count, 0);
  const recordedBy = used.find(({ scan }) => scan.distro)?.scan.distro ?? '';
  const messageCompressed = !fileCompressed && used[0].scan.messageCompressed === true;
  const version = metadataVersion(sorted, recordedBy || options.distro);
  // The server's distribution, unless older than the metadata (Jazzy's then)
  const distro = recordedBy || (version >= 9 && /^(foxy|galactic|humble|iron)$/i.test(options.distro) ? '' : options.distro);
  const yaml = metadataYaml(
    {
      storage,
      start,
      duration: end - start,
      count,
      topics: sorted,
      compression: fileCompressed ? { mode: 'FILE', format: 'zstd' } : messageCompressed ? { mode: 'MESSAGE', format: 'zstd' } : null,
      relativePaths: used.map((file) => file.name),
      files: used.map(
        ({ base, scan }): RepairedFile => ({ path: base, start: scan.start!, duration: scan.end! - scan.start!, count: scan.count }),
      ),
      distro,
    },
    version,
  );
  signal?.throwIfAborted();
  // Not over one written meanwhile, as its recording ended
  await fs.writeFile(path.join(location, METADATA), yaml, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    throw new Error(e.code === 'EEXIST' ? `${name} has its ${METADATA} already` : `Cannot write ${METADATA} into ${location}: ${e.code ?? errorMessage(e)}`);
  });
  return {
    path: location,
    version,
    messages: count,
    duration: Number((end - start) / 1000n) / 1000,
    files: used.map((file) => file.name),
    skipped,
    compressed: toCompress.map((file) => file.compressed),
  };
}

function rethrowUndecompressable(e: unknown): never {
  if (e instanceof Error && /Cannot decompress/.test(e.message)) {
    throw new Undecompressable(e.message.replace(/^Cannot decompress [^:]*: /, ''));
  }
  throw e;
}

// As rosbag2 compresses a bag's file (zstd, its fastest level): beside it,
// under another name until done
async function compressFile(plain: string, compressed: string, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  const part = path.join(path.dirname(compressed), `.${path.basename(compressed)}.part`);
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  try {
    await pipelineAsync(
      createReadStream(plain, { highWaterMark: 1 << 20 }),
      counter,
      zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } }),
      createWriteStream(part),
      { signal },
    );
    await fs.rename(part, compressed);
  } catch (e) {
    await fs.rm(part, { force: true });
    signal?.throwIfAborted();
    throw new Error(`Cannot compress ${path.basename(plain)}: ${errorMessage(e)}`);
  }
}
