import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { bagInfo, openBag, readBag } from './rosbag.ts';
import { parseMetadata, parseYaml } from './rosbag_format.ts';
import { repairBag, type RepairProgress } from './rosbag_repair.ts';

// ── MCAP as rosbag2 writes it: its channels with their QoS, in chunks ──

const u16 = (value: number) => Buffer.from(Uint16Array.of(value).buffer);
const u32 = (value: number) => Buffer.from(Uint32Array.of(value).buffer);
const u64 = (value: bigint | number) => Buffer.from(BigUint64Array.of(BigInt(value)).buffer);
const str = (text: string) => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)]);
const map = (entries: Record<string, string>) => {
  const body = Buffer.concat(Object.entries(entries).flatMap(([key, value]) => [str(key), str(value)]));
  return Buffer.concat([u32(body.length), body]);
};
const record = (opcode: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.of(opcode), u64(body.length), body]);
};
const MAGIC = Buffer.of(0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a);
const HUMBLE_QOS = '- history: 3\n  depth: 0\n  reliability: 1\n  durability: 2';
const JAZZY_QOS = '- history: unknown\n  depth: 0\n  reliability: reliable\n  durability: volatile';

const schema = (id: number, name: string) => record(0x03, u16(id), str(name), str('ros2msg'), u32(0));
const channel = (id: number, schemaId: number, topic: string, metadata: Record<string, string>) =>
  record(0x04, u16(id), u16(schemaId), str(topic), str('cdr'), map(metadata));
// At s seconds of the bag's clock
const T0 = 1_794_990_000_000_000_000n;
const at = (s: number) => T0 + BigInt(Math.round(s * 1e9));
const message = (channelId: number, s: number, data: Uint8Array = Uint8Array.of(0, 1, 0, 0, 7)) =>
  record(0x05, u16(channelId), u32(0), u64(at(s)), u64(at(s)), Buffer.from(data));
const chunk = (records: Buffer[], compression = '') => {
  const raw = Buffer.concat(records);
  const data = compression === 'zstd' ? zlib.zstdCompressSync(raw) : raw;
  return record(0x06, u64(0), u64(0), u64(raw.length), u32(0), str(compression), u64(data.length), data);
};
const rosbag2 = (distro: string) => record(0x0c, str('rosbag2'), map({ ROS_DISTRO: distro }));
const statistics = (first: number, last: number, counts: [number, number][]) => {
  const body = Buffer.concat(counts.map(([id, count]) => Buffer.concat([u16(id), u64(count)])));
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  return record(0x0b, u64(total), u16(2), u32(counts.length), u32(0), u32(1), u32(1), u64(at(first)), u64(at(last)), u32(body.length), body);
};

const humbleTopics = [
  schema(1, 'std_msgs/msg/String'),
  channel(1, 1, '/chatter', { offered_qos_profiles: HUMBLE_QOS }),
  schema(2, 'geometry_msgs/msg/Twist'),
  channel(2, 2, '/cmd', { offered_qos_profiles: HUMBLE_QOS }),
];

// A file: its header, its data (the records given), then if complete its end
// and a summary (with statistics if given)
function mcap(data: Buffer[], options: { complete?: boolean; summary?: Buffer[] } = {}) {
  const parts = [MAGIC, record(0x01, str('ros2'), str('libmcap 0.8.0')), ...data];
  if (options.complete === false) {
    return Buffer.concat(parts);
  }
  parts.push(record(0x0f, u32(0)));
  const summaryAt = parts.reduce((sum, part) => sum + part.length, 0);
  const summary = options.summary ?? [];
  parts.push(...summary, record(0x02, u64(summary.length ? summaryAt : 0), u64(0), u32(0)), MAGIC);
  return Buffer.concat(parts);
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tassello-repair-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NOW = { distro: 'humble', quietMs: 0 };

function metadataOf(folder: string) {
  return readFile(path.join(folder, 'metadata.yaml'), 'utf8');
}

test('a compressed bag whose recording was killed: its files read whole, the one being recorded compressed', async () => {
  await withDir(async (bag) => {
    // Two files compressed as the bag was split, the third being recorded:
    // two whole chunks, then one cut short
    await writeFile(
      path.join(bag, 'run_0.mcap.zstd'),
      zlib.zstdCompressSync(mcap([rosbag2('humble'), chunk([...humbleTopics, message(1, 0), message(2, 0.5), message(1, 1)])])),
    );
    // Subscribed to, never published on: in its summary only
    const docked = [schema(3, 'geometry_msgs/msg/PoseStamped'), channel(3, 3, '/docked', { offered_qos_profiles: HUMBLE_QOS })];
    await writeFile(
      path.join(bag, 'run_1.mcap.zstd'),
      zlib.zstdCompressSync(mcap([chunk([...humbleTopics, message(1, 2), message(1, 3)], 'zstd')], { summary: [...humbleTopics, ...docked] })),
    );
    const cut = mcap([chunk([...humbleTopics, message(1, 4)]), chunk([message(2, 4.5), message(1, 5)]), chunk([message(1, 6), message(1, 7)])], {
      complete: false,
    });
    await writeFile(path.join(bag, 'run_2.mcap'), cut.subarray(0, cut.length - 20));

    assert.equal((await bagInfo(bag)).repairable, true);
    const progress: RepairProgress[] = [];
    const repair = await repairBag(bag, { ...NOW, onProgress: (p) => progress.push(p) });
    assert.deepEqual(repair, {
      path: bag,
      version: 5,
      messages: 8,
      duration: 5000,
      files: ['run_0.mcap.zstd', 'run_1.mcap.zstd', 'run_2.mcap.zstd'],
      skipped: [],
      compressed: ['run_2.mcap.zstd'],
    });
    assert.ok(progress.length > 2);
    assert.deepEqual(progress.at(-1)!.done, progress.at(-1)!.total);
    // Compressed beside it, which stays
    assert.deepEqual(await readdir(bag).then((names) => names.sort()), [
      'metadata.yaml',
      'run_0.mcap.zstd',
      'run_1.mcap.zstd',
      'run_2.mcap',
      'run_2.mcap.zstd',
    ]);
    assert.deepEqual(zlib.zstdDecompressSync(await readFile(path.join(bag, 'run_2.mcap.zstd'))), cut.subarray(0, cut.length - 20));

    const yaml = await metadataOf(bag);
    const metadata = parseMetadata(yaml);
    assert.equal(metadata.version, 5);
    assert.deepEqual(metadata.compression, { mode: 'file', format: 'zstd' });
    assert.deepEqual(metadata.topics, [
      { name: '/chatter', type: 'std_msgs/msg/String', count: 6 },
      { name: '/cmd', type: 'geometry_msgs/msg/Twist', count: 2 },
      { name: '/docked', type: 'geometry_msgs/msg/PoseStamped', count: 0 },
    ]);
    const info = (parseYaml(yaml) as any).rosbag2_bagfile_information;
    assert.equal(info.starting_time.nanoseconds_since_epoch, String(T0));
    assert.equal(info.duration.nanoseconds, '5000000000');
    assert.equal(info.topics_with_message_count[0].topic_metadata.offered_qos_profiles, HUMBLE_QOS);
    assert.deepEqual(
      info.files.map((file: any) => [file.path, file.message_count, file.duration.nanoseconds]),
      [
        ['run_0.mcap', '3', '1000000000'],
        ['run_1.mcap', '2', '1000000000'],
        ['run_2.mcap', '3', '1000000000'],
      ],
    );

    // Listed as whole, and read as one
    const repaired = await bagInfo(bag);
    assert.deepEqual([repaired.problem, repaired.repairable, repaired.messages], [null, false, 8]);
    const read = await readBag(await openBag(bag), () => true);
    assert.equal(read.get('/chatter')?.messages.length, 6);
    await assert.rejects(repairBag(bag, NOW), /has its metadata.yaml already/);
  });
});

test('files of which nothing can be read are left out; a compression cut short is made again', async () => {
  await withDir(async (dir) => {
    const whole = mcap([chunk([...humbleTopics, message(1, 0), message(1, 1)])]);
    const bag = path.join(dir, 'bag');
    await mkdir(bag);
    // Its compression cut short, the file it compressed still there
    await writeFile(path.join(bag, 'run_0.mcap'), whole);
    await writeFile(path.join(bag, 'run_0.mcap.zstd'), zlib.zstdCompressSync(whole).subarray(0, 30));
    // Cut short with no original: rosbag2 would fail on it
    await writeFile(path.join(bag, 'run_1.mcap.zstd'), zlib.zstdCompressSync(mcap([chunk([...humbleTopics, message(1, 2)])])).subarray(0, 40));
    // What a playback leaves: the file decompressed beside its .zstd
    await writeFile(path.join(bag, 'run_2.mcap.zstd'), zlib.zstdCompressSync(mcap([chunk([...humbleTopics, message(1, 3)])])));
    await writeFile(path.join(bag, 'run_2.mcap'), 'left over');
    // Being recorded: cut short in its first chunk, and the next not begun
    await writeFile(path.join(bag, 'run_3.mcap'), mcap([chunk([...humbleTopics, message(1, 4)])], { complete: false }).subarray(0, 60));
    await writeFile(path.join(bag, 'run_4.mcap'), '');

    const repair = await repairBag(bag, NOW);
    assert.deepEqual(repair.files, ['run_0.mcap.zstd', 'run_2.mcap.zstd']);
    assert.deepEqual(repair.compressed, ['run_0.mcap.zstd']);
    assert.deepEqual(repair.skipped, [
      { name: 'run_1.mcap.zstd', reason: 'compressed only in part (cut short)' },
      { name: 'run_3.mcap', reason: 'cut short before its first message' },
      { name: 'run_4.mcap', reason: 'empty' },
    ]);
    assert.equal(repair.messages, 3);
    assert.deepEqual(zlib.zstdDecompressSync(await readFile(path.join(bag, 'run_0.mcap.zstd'))), whole);
    assert.equal(parseMetadata(await metadataOf(bag)).messages, 3);

    // Nothing at all
    const nothing = path.join(dir, 'nothing');
    await mkdir(nothing);
    await writeFile(path.join(nothing, 'run_0.mcap'), '');
    await writeFile(path.join(nothing, 'run_1.mcap'), 'not an mcap');
    await assert.rejects(repairBag(nothing, NOW), /Nothing of nothing can be read \(run_0.mcap: empty; run_1.mcap: not an MCAP file\)/);
    assert.deepEqual(await readdir(nothing), ['run_0.mcap', 'run_1.mcap']);
  });
});

test('an uncompressed bag: complete files from their summary, its distribution’s metadata', async () => {
  await withDir(async (bag) => {
    const jazzyTopics = [
      schema(1, 'std_msgs/msg/String'),
      channel(1, 1, '/chatter', { offered_qos_profiles: JAZZY_QOS, topic_type_hash: 'RIHS01_df66' }),
    ];
    // Its summary says what it holds: its messages are not read (there are
    // none here but in the statistics)
    await writeFile(
      path.join(bag, 'run_0.mcap'),
      mcap([chunk([...jazzyTopics, message(1, 0)])], { summary: [...jazzyTopics, statistics(0, 9, [[1, 40]])] }),
    );
    await writeFile(path.join(bag, 'run_1.mcap'), mcap([chunk([...jazzyTopics, message(1, 10), message(1, 12)])], { complete: false }));
    const repair = await repairBag(bag, { ...NOW, distro: 'humble' });
    assert.deepEqual([repair.version, repair.messages, repair.duration, repair.compressed], [9, 42, 12_000, []]);
    const yaml = await metadataOf(bag);
    const info = (parseYaml(yaml) as any).rosbag2_bagfile_information;
    assert.equal(info.compression_mode, '');
    assert.deepEqual(info.relative_file_paths, ['run_0.mcap', 'run_1.mcap']);
    assert.equal(info.topics_with_message_count[0].topic_metadata.type_description_hash, 'RIHS01_df66');
    assert.equal(info.topics_with_message_count[0].topic_metadata.offered_qos_profiles[0].history, 'unknown');
    assert.equal(info.ros_distro, 'jazzy');
  });
});

test('SQLite bags: their messages counted; compressed each, said so', async (t) => {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    t.skip('node:sqlite is not available');
    return;
  }
  await withDir(async (bag) => {
    // As Jazzy records them
    const db = new sqlite.DatabaseSync(path.join(bag, 'run_0.db3'));
    db.exec(`CREATE TABLE schema(schema_version INTEGER PRIMARY KEY, ros_distro TEXT NOT NULL);
             INSERT INTO schema VALUES (4, 'jazzy');
             CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, serialization_format TEXT NOT NULL,
               offered_qos_profiles TEXT NOT NULL, type_description_hash TEXT NOT NULL);
             CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);`);
    db.prepare('INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)').run(1, '/scan', 'sensor_msgs/msg/LaserScan', 'cdr', JAZZY_QOS, 'RIHS01_aa');
    db.prepare('INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)').run(2, '/idle', 'std_msgs/msg/Empty', 'cdr', JAZZY_QOS, 'RIHS01_bb');
    const insert = db.prepare('INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    // Over several batches
    for (let i = 0; i < 45_000; i++) {
      insert.run(1, at(i / 1000), zlib.zstdCompressSync(Uint8Array.of(0, 1, 0, 0, i % 256)));
    }
    db.exec('COMMIT');
    db.close();
    const repair = await repairBag(bag, NOW);
    assert.deepEqual([repair.version, repair.messages, repair.duration], [9, 45_000, 44_999]);
    const metadata = parseMetadata(await metadataOf(bag));
    assert.deepEqual(metadata.compression, { mode: 'message', format: 'zstd' });
    assert.deepEqual(metadata.topics, [
      { name: '/idle', type: 'std_msgs/msg/Empty', count: 0 },
      { name: '/scan', type: 'sensor_msgs/msg/LaserScan', count: 45_000 },
    ]);
    assert.equal(metadata.storage, 'sqlite3');
  });
});

test('not while being recorded, nor a file, nor stopped half way', async () => {
  await withDir(async (dir) => {
    const bag = path.join(dir, 'bag');
    await mkdir(bag);
    const file = path.join(bag, 'run_0.mcap');
    await writeFile(file, mcap([chunk([...humbleTopics, message(1, 0)])]));
    await assert.rejects(repairBag(file, NOW), /is a file/);
    await assert.rejects(repairBag(path.join(dir, 'missing'), NOW), /No rosbag at/);
    // Written to just now
    await assert.rejects(repairBag(bag, { distro: 'humble' }), /written to 0 s ago: is it being recorded/);
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // Open in another process, as by ros2 bag record
    if (process.platform === 'linux') {
      const handle = await open(file, 'r');
      const holder = spawn('sleep', ['10'], { stdio: ['ignore', handle.fd, 'ignore'] });
      await handle.close();
      try {
        await assert.rejects(repairBag(bag, { distro: 'humble' }), /is open in sleep \(\d+\): is it being recorded/);
      } finally {
        holder.kill();
      }
    }
    // Cancelled: nothing written
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(repairBag(bag, { ...NOW, signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(await readdir(bag), ['run_0.mcap']);
    assert.equal((await repairBag(bag, NOW)).messages, 1);
  });
});
