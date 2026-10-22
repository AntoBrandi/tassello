import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { decodeLog, logLayout } from './behavior_tree_log.ts';
import { BehaviorTreePlayback, readLog, type PlaybackState } from './behavior_tree_playback.ts';
import { bagFiles, bagInfo, listBags, newBagFolder, openBag, readBag, type BagCache } from './rosbag.ts';

const LOG_TYPE = 'nav2_msgs/msg/BehaviorTreeLog';

interface Event {
  sec: number;
  name: string;
  uid?: number;
  from: string;
  to: string;
}

// A BehaviorTreeLog, CDR serialized: with UIDs (Jazzy's), or without
function cdr(events: Event[], uids: boolean, little = true): Uint8Array {
  const bytes: number[] = [0, little ? 1 : 0, 0, 0];
  const align = (size: number) => {
    while ((bytes.length - 4) % size) {
      bytes.push(0);
    }
  };
  const integer = (value: number, size: 2 | 4) => {
    align(size);
    const buffer = Buffer.alloc(size);
    if (size === 2) {
      little ? buffer.writeUInt16LE(value) : buffer.writeUInt16BE(value);
    } else {
      little ? buffer.writeInt32LE(value) : buffer.writeInt32BE(value);
    }
    bytes.push(...buffer);
  };
  const string = (text: string) => {
    const buffer = Buffer.from(`${text}\0`);
    integer(buffer.length, 4);
    bytes.push(...buffer);
  };
  integer(100, 4);
  integer(0, 4);
  integer(events.length, 4);
  for (const event of events) {
    integer(event.sec, 4);
    integer(500_000_000, 4);
    string(event.name);
    if (uids) {
      integer(event.uid ?? 0, 2);
    }
    string(event.from);
    string(event.to);
  }
  return Uint8Array.from(bytes);
}

const SPIN: Event = { sec: 7, name: 'Spin', uid: 15, from: 'IDLE', to: 'RUNNING' };
const WAIT: Event = { sec: 8, name: 'Wait', uid: 16, from: 'RUNNING', to: 'SUCCESS' };

test('serialized logs are read, their layout found', () => {
  assert.deepEqual(decodeLog(cdr([SPIN], false), false), [
    { uid: null, name: 'Spin', from: 'IDLE', to: 'RUNNING', time: 7500 },
  ]);
  assert.deepEqual(decodeLog(cdr([SPIN, WAIT], true, false), true), [
    { uid: 15, name: 'Spin', from: 'IDLE', to: 'RUNNING', time: 7500 },
    { uid: 16, name: 'Wait', from: 'RUNNING', to: 'SUCCESS', time: 8500 },
  ]);
  assert.throws(() => decodeLog(cdr([SPIN], false).subarray(0, 30), false), /Truncated/);
  // Names of every length: some read in the other layout, the UIDs in the
  // strings' padding
  const names = ['A', 'Ab', 'Abc', 'Abcd'].map((name, i) => ({ ...SPIN, name, uid: i + 1 }));
  assert.equal(logLayout([cdr([], true), ...names.map((event) => cdr([event], true))]), true);
  assert.equal(logLayout(names.map((event) => cdr([event], false))), false);
  // Where both read, the UIDs tell
  assert.equal(logLayout([cdr([SPIN], true)]), true);
  assert.equal(logLayout([cdr([SPIN], false)]), false);
  assert.equal(logLayout([cdr([], false)]), null);
  assert.equal(logLayout([Uint8Array.of(0, 1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9)]), null);
});

// ── A small MCAP writer ──

const u16 = (value: number) => Buffer.from(Uint16Array.of(value).buffer);
const u32 = (value: number) => Buffer.from(Uint32Array.of(value).buffer);
const u64 = (value: bigint | number) => Buffer.from(BigUint64Array.of(BigInt(value)).buffer);
const str = (text: string) => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)]);
const record = (opcode: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.of(opcode), u64(body.length), body]);
};
const MAGIC = Buffer.of(0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a);
const schema = (id: number, name: string) => record(0x03, u16(id), str(name), str('ros2msg'), u32(0));
const channel = (id: number, schemaId: number, topic: string) => record(0x04, u16(id), u16(schemaId), str(topic), str('cdr'), u32(0));
const message = (channelId: number, ms: number, data: Uint8Array) =>
  record(0x05, u16(channelId), u32(0), u64(BigInt(ms) * 1_000_000n), u64(0), Buffer.from(data));

function chunk(records: Buffer[], compression: string) {
  const raw = Buffer.concat(records);
  const data = compression === 'zstd' ? zlib.zstdCompressSync(raw) : raw;
  return record(0x06, u64(0), u64(0), u64(raw.length), u32(0), str(compression), u64(data.length), data);
}

// Chunks of the given channels, then (if indexed) the summary
function mcap(chunks: { records: Buffer[]; compression: string; channels: number[] }[], summary: Buffer[], indexed: boolean) {
  const parts: Buffer[] = [MAGIC, record(0x01, str(''), str('test'))];
  const index: Buffer[] = [];
  let offset = parts.reduce((sum, part) => sum + part.length, 0);
  for (const [i, c] of chunks.entries()) {
    const written = chunk(c.records, c.compression);
    const map = Buffer.concat(c.channels.map((id) => Buffer.concat([u16(id), u64(0)])));
    index.push(record(0x08, u64(i), u64(i), u64(offset), u64(written.length), u32(map.length), map, u64(0), str(c.compression), u64(0), u64(0)));
    parts.push(written);
    offset += written.length;
  }
  parts.push(record(0x0f, u32(0)));
  offset += parts.at(-1)!.length;
  if (indexed) {
    parts.push(...summary, ...index);
  }
  parts.push(record(0x02, u64(indexed ? offset : 0), u64(0), u32(0)), MAGIC);
  return Buffer.concat(parts);
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-bag-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const logChunk = {
  records: [schema(1, LOG_TYPE), channel(1, 1, '/behavior_tree_log'), message(1, 2000, cdr([SPIN], true)), message(1, 1000, cdr([WAIT], true))],
  compression: 'zstd',
  channels: [1],
};
// Of another topic, compressed as not read: the index must skip it
const imageChunk = {
  records: [schema(2, 'sensor_msgs/msg/Image'), channel(2, 2, '/camera'), message(2, 1500, Uint8Array.of(1, 2, 3))],
  compression: 'lz4',
  channels: [2],
};

test('MCAP: the chunks of the topics wanted, from the index', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'run_0.mcap');
    const summary = [schema(1, LOG_TYPE), channel(1, 1, '/behavior_tree_log'), schema(2, 'sensor_msgs/msg/Image'), channel(2, 2, '/camera')];
    await writeFile(file, mcap([logChunk, imageChunk], summary, true));
    const topics = await readBag([file], (topic) => topic.type === LOG_TYPE);
    assert.deepEqual([...topics.keys()], ['/behavior_tree_log']);
    const { topic, messages } = topics.get('/behavior_tree_log')!;
    assert.deepEqual(topic, { name: '/behavior_tree_log', type: LOG_TYPE });
    // In the order recorded
    assert.deepEqual(messages.map((m) => m.time), [1000, 2000]);
    assert.deepEqual(decodeLog(messages[1].data, true)[0].name, 'Spin');
  });
});

test('MCAP without a summary, or cut short, is read from the start', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'unindexed.mcap');
    const bag = mcap([logChunk, { ...logChunk, compression: '', records: [message(1, 3000, cdr([SPIN], true))] }], [], false);
    await writeFile(file, bag);
    assert.deepEqual((await readBag([file], () => true)).get('/behavior_tree_log')?.messages.length, 3);
    // A recording that did not end: its last chunk incomplete
    await writeFile(file, bag.subarray(0, bag.length - 60));
    assert.deepEqual((await readBag([file], () => true)).get('/behavior_tree_log')?.messages.length, 2);
    await writeFile(file, 'not an mcap');
    await assert.rejects(readBag([file], () => true), /not an MCAP file/);
  });
});

test('SQLite bags, as Humble records them', async (t) => {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    t.skip('node:sqlite is not available');
    return;
  }
  await withDir(async (dir) => {
    const file = path.join(dir, 'run_0.db3');
    const db = new sqlite.DatabaseSync(file);
    db.exec(`CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
               serialization_format TEXT NOT NULL, offered_qos_profiles TEXT NOT NULL);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
             INSERT INTO topics VALUES (1, '/behavior_tree_log', '${LOG_TYPE}', 'cdr', ''), (2, '/camera', 'sensor_msgs/msg/Image', 'cdr', '');`);
    const insert = db.prepare('INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)');
    insert.run(1, 1_792_484_340_123_456_789n, cdr([SPIN], false));
    insert.run(2, 1_792_484_340_200_000_000n, Uint8Array.of(1));
    insert.run(1, 1_792_484_341_000_000_000n, cdr([WAIT], false));
    db.close();
    const topics = await readBag(await bagFiles(dir), (topic) => topic.type === LOG_TYPE);
    assert.deepEqual(
      topics.get('/behavior_tree_log')?.messages.map((m) => m.time),
      [1_792_484_340_123.456, 1_792_484_341_000],
    );
    assert.equal(topics.has('/camera'), false);
  });
});

test('a bag is its folder or one of its files; recordings make new folders', async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, 'run_10.mcap'), '');
    await writeFile(path.join(dir, 'run_2.mcap'), '');
    await writeFile(path.join(dir, 'metadata.yaml'), '');
    assert.deepEqual(await bagFiles(dir), [path.join(dir, 'run_2.mcap'), path.join(dir, 'run_10.mcap')]);
    assert.deepEqual(await bagFiles(path.join(dir, 'run_2.mcap')), [path.join(dir, 'run_2.mcap')]);
    await assert.rejects(bagFiles(path.join(dir, 'metadata.yaml')), /Not a rosbag/);
    await assert.rejects(bagFiles(path.join(dir, 'missing')), /No rosbag at/);
    await assert.rejects(bagFiles('relative/bag'), /Not a path/);
    await mkdir(path.join(dir, 'empty'));
    await assert.rejects(bagFiles(path.join(dir, 'empty')), /no .mcap nor .db3/);
    assert.equal(await newBagFolder(`${dir}/new/bag/`), path.join(dir, 'new', 'bag'));
    await assert.rejects(newBagFolder(dir), /exists already/);
  });
});

test('a bag is played back: seeked, at its speed, to its end', async () => {
  await withDir(async (dir) => {
    const events = (sec: number, name: string, from: string, to: string) => cdr([{ sec, name, from, to }], false);
    const records = [
      schema(1, LOG_TYPE),
      channel(1, 1, '/behavior_tree_log'),
      message(1, 1000, events(1, 'Spin', 'IDLE', 'RUNNING')),
      message(1, 1200, events(1, 'Spin', 'RUNNING', 'SUCCESS')),
      message(1, 1400, events(1, 'Wait', 'IDLE', 'RUNNING')),
    ];
    await writeFile(path.join(dir, 'b.mcap'), mcap([{ records, compression: '', channels: [1] }], [], false));
    assert.equal((await readLog(dir, '/other')).topic, '/behavior_tree_log');

    const updates: { reset: boolean; states: { node: number; status: string | null }[] }[] = [];
    const states: PlaybackState[] = [];
    let opened: () => void;
    const ready = new Promise<void>((resolve) => (opened = resolve));
    const playback = new BehaviorTreePlayback(
      { bag: dir, topic: '', tree: '', uploadsDir: dir, logger: { debug() {}, info() {}, warn() {}, error() {} } },
      {
        onStatus: () => {},
        onTree: () => {},
        onUpdate: (update) => updates.push(update),
        onPlayback: (state) => {
          states.push(state);
          opened();
        },
      },
    );
    await ready;
    assert.deepEqual(states.at(-1), { topic: '/behavior_tree_log', start: 1000, end: 1400, time: 1000, playing: true, speed: 1, error: null });
    // Seeking forward, then back: the state is that of the time sought
    playback.control({ playing: false, time: 1300 });
    assert.deepEqual(updates.at(-1)?.states.map((s) => s.status), ['SUCCESS']);
    playback.control({ time: 1100 });
    assert.equal(updates.at(-1)?.reset, true);
    assert.deepEqual(updates.at(-1)?.states.map((s) => s.status), ['RUNNING']);
    // Fast, to the end
    playback.control({ speed: 64, playing: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(states.at(-1)?.playing, false);
    assert.equal(states.at(-1)?.time, 1400);
    assert.equal(states.at(-1)?.speed, 64);
    playback.close();
  });
});

// ── Listing, metadata, compression ──

const statistics = (start: number, end: number, counts: [number, number][]) => {
  const map = Buffer.concat(counts.map(([id, count]) => Buffer.concat([u16(id), u64(count)])));
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  return record(0x0b, u64(total), u16(1), u32(counts.length), u32(0), u32(0), u32(1), u64(BigInt(start) * 1_000_000n), u64(BigInt(end) * 1_000_000n), u32(map.length), map);
};

function metadata({ storage, files, start, count, mode = '' }: { storage: string; files: string[]; start: number; count: number; mode?: string }) {
  return [
    'rosbag2_bagfile_information:',
    '  version: 5',
    `  storage_identifier: ${storage}`,
    '  duration:',
    '    nanoseconds: 2000000000',
    '  starting_time:',
    `    nanoseconds_since_epoch: ${start}000000`,
    `  message_count: ${count}`,
    '  topics_with_message_count:',
    '    - topic_metadata:',
    '        name: /behavior_tree_log',
    `        type: ${LOG_TYPE}`,
    '        serialization_format: cdr',
    '        offered_qos_profiles: ""',
    `      message_count: ${count}`,
    `  compression_format: ${mode ? 'zstd' : '""'}`,
    `  compression_mode: ${mode || '""'}`,
    '  relative_file_paths:',
    ...files.map((file) => `    - ${file}`),
    '',
  ].join('\n');
}

test('a folder’s bags: what their metadata says, else their files', async () => {
  await withDir(async (dir) => {
    const summary = [schema(1, LOG_TYPE), channel(1, 1, '/behavior_tree_log'), schema(2, 'sensor_msgs/msg/Image'), channel(2, 2, '/camera')];
    await mkdir(path.join(dir, 'described'));
    await writeFile(path.join(dir, 'described', 'run_0.mcap'), mcap([logChunk], summary, true));
    await writeFile(path.join(dir, 'described', 'metadata.yaml'), metadata({ storage: 'mcap', files: ['run_0.mcap'], start: 3000, count: 2 }));
    // Its recording killed: no metadata, but MCAP's summary
    await mkdir(path.join(dir, 'killed'));
    await writeFile(path.join(dir, 'killed', 'run_0.mcap'), mcap([logChunk, imageChunk], [...summary, statistics(1000, 2000, [[1, 2], [2, 1]])], true));
    // Cut short: not even a summary
    await writeFile(path.join(dir, 'lone.mcap'), mcap([logChunk], [], false).subarray(0, 40));
    await mkdir(path.join(dir, 'notes'));
    await writeFile(path.join(dir, 'notes', 'todo.txt'), 'nothing');
    await mkdir(path.join(dir, '.hidden'));
    await writeFile(path.join(dir, '.hidden', 'metadata.yaml'), '');

    const cache: BagCache = new Map();
    const bags = await listBags(dir, cache);
    // The newest first: by their first message, else by their files' time
    assert.deepEqual(bags.map((bag) => bag.name), ['lone.mcap', 'described', 'killed']);
    const [lone, described, killed] = bags;
    assert.equal(described.storage, 'mcap');
    assert.equal(described.start, 3000);
    assert.equal(described.duration, 2000);
    assert.deepEqual(described.topics, [{ name: '/behavior_tree_log', type: LOG_TYPE, count: 2 }]);
    assert.deepEqual(described.files.map((file) => file.name), ['run_0.mcap']);
    assert.equal(described.problem, null);
    assert.deepEqual(killed.topics, [
      { name: '/behavior_tree_log', type: LOG_TYPE, count: 2 },
      { name: '/camera', type: 'sensor_msgs/msg/Image', count: 1 },
    ]);
    assert.deepEqual([killed.start, killed.duration, killed.messages], [1000, 1000, 3]);
    assert.match(killed.problem ?? '', /No metadata.yaml/);
    assert.deepEqual([lone.path, lone.start, lone.topics], [path.join(dir, 'lone.mcap'), null, []]);
    assert.equal(lone.size, 40);

    // Read again only when their files change
    assert.equal((await listBags(dir, cache))[1], described);
    await utimes(path.join(dir, 'described', 'metadata.yaml'), new Date(), new Date(Date.now() + 5000));
    assert.notEqual((await listBags(dir, cache))[1], described);
    await assert.rejects(bagInfo(path.join(dir, 'notes')), /No rosbag in/);
    assert.deepEqual(await listBags(path.join(dir, 'missing')), []);
  });
});

test('bags compressed by rosbag2: each file, or each message', async (t) => {
  await withDir(async (dir) => {
    const records = [schema(1, LOG_TYPE), channel(1, 1, '/behavior_tree_log'), message(1, 1000, cdr([SPIN], true))];
    const file = path.join(dir, 'files');
    await mkdir(file);
    await writeFile(path.join(file, 'run_0.mcap.zstd'), zlib.zstdCompressSync(mcap([{ records, compression: '', channels: [1] }], [], false)));
    // What a playback of it leaves: not what is read
    await writeFile(path.join(file, 'run_0.mcap'), 'left over');
    await writeFile(path.join(file, 'metadata.yaml'), metadata({ storage: 'mcap', files: ['run_0.mcap.zstd'], start: 1000, count: 1, mode: 'FILE' }));
    assert.deepEqual(await bagFiles(file), [path.join(file, 'run_0.mcap.zstd')]);
    const read = await readBag(await openBag(file), () => true);
    assert.equal(decodeLog(read.get('/behavior_tree_log')!.messages[0].data, true)[0].name, 'Spin');
    assert.deepEqual((await bagInfo(file)).compression, { mode: 'file', format: 'zstd' });

    let sqlite: typeof import('node:sqlite');
    try {
      sqlite = await import('node:sqlite');
    } catch {
      t.skip('node:sqlite is not available');
      return;
    }
    const messages = path.join(dir, 'messages');
    await mkdir(messages);
    const db = new sqlite.DatabaseSync(path.join(messages, 'run_0.db3'));
    db.exec(`CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
               serialization_format TEXT NOT NULL, offered_qos_profiles TEXT NOT NULL);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
             INSERT INTO topics VALUES (1, '/behavior_tree_log', '${LOG_TYPE}', 'cdr', '');`);
    db.prepare('INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)').run(1, 2_000_000_000n, zlib.zstdCompressSync(cdr([WAIT], true)));
    db.close();
    await writeFile(path.join(messages, 'metadata.yaml'), metadata({ storage: 'sqlite3', files: ['run_0.db3'], start: 2000, count: 1, mode: 'MESSAGE' }));
    const log = (await readBag(await openBag(messages), () => true)).get('/behavior_tree_log')!;
    assert.deepEqual(decodeLog(log.messages[0].data, true).map((transition) => transition.name), ['Wait']);
    // Without its metadata, what the database says: counted
    await rm(path.join(messages, 'metadata.yaml'));
    const info = await bagInfo(messages);
    assert.deepEqual([info.storage, info.start, info.duration, info.messages], ['sqlite3', 2000, 0, 1]);
  });
});
