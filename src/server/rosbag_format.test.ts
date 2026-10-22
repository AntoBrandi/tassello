import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_RECORD_OPTIONS, playbackPosition, type Playback, type RecordRequest } from '../shared/rosbag.ts';
import {
  checkBagsRequest,
  checkPlayRequest,
  checkRecordOptions,
  checkRecordRequest,
  parseMetadata,
  parseYaml,
  playArguments,
  pluginNames,
  recordArguments,
} from './rosbag_format.ts';

// As Humble writes it, its files compressed whole
const HUMBLE = `rosbag2_bagfile_information:
  version: 5
  storage_identifier: sqlite3
  duration:
    nanoseconds: 3199956195
  starting_time:
    nanoseconds_since_epoch: 1792660059552105986
  message_count: 65
  topics_with_message_count:
    - topic_metadata:
        name: /chatter
        type: std_msgs/msg/String
        serialization_format: cdr
        offered_qos_profiles: "- history: 3\\n  depth: 0\\n  reliability: 1\\n  avoid_ros_namespace_conventions: false"
      message_count: 65
  compression_format: zstd
  compression_mode: FILE
  relative_file_paths:
    - fz_0.db3.zstd
    - fz_1.db3.zstd
  files:
    - path: fz_0.db3
      starting_time:
        nanoseconds_since_epoch: 1792660059552105986
      duration:
        nanoseconds: 950083732
      message_count: 20
    - path: fz_1.db3
      starting_time:
        nanoseconds_since_epoch: 1792660060552152596
      duration:
        nanoseconds: 950050628
      message_count: 45`;

// As Jazzy writes it: its QoS a sequence, a hash, custom data
const JAZZY = `rosbag2_bagfile_information:
  version: 9
  storage_identifier: mcap
  duration:
    nanoseconds: 9907656483
  starting_time:
    nanoseconds_since_epoch: 1715680406185338166
  message_count: 99
  topics_with_message_count:
    - topic_metadata:
        name: /scan
        type: sensor_msgs/msg/LaserScan
        serialization_format: cdr
        offered_qos_profiles:
          - history: keep_last
            depth: 7
            reliability: best_effort
            deadline:
              sec: 9223372036
              nsec: 854775807
        type_description_hash: RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18
      message_count: 90
    - topic_metadata:
        name: /tf_static
        type: tf2_msgs/msg/TFMessage
        serialization_format: cdr
        offered_qos_profiles: []
        type_description_hash: RIHS01_e369d0f05f5ad9f2e5d7a5e1f8c0d6b4
      message_count: 9
  compression_format: ""
  compression_mode: ""
  relative_file_paths:
    - run_0.mcap
  files:
    - path: run_0.mcap
      starting_time:
        nanoseconds_since_epoch: 1715680406185338166
      duration:
        nanoseconds: 9907656483
      message_count: 99
  custom_data: ~
  ros_distro: jazzy`;

test('block YAML: mappings, sequences of mappings, quoted and plain scalars', () => {
  assert.deepEqual(parseYaml('a:\n  b: 1\n  c: "x\\ny \\"z\\""\nd:\n- one\n- \'it\'\'s\'\ne: ~\nf: []\ng:\n  - k: v\n    l:\n      - 2\n'), {
    a: { b: '1', c: 'x\ny "z"' },
    d: ['one', "it's"],
    e: null,
    f: [],
    g: [{ k: 'v', l: ['2'] }],
  });
  assert.deepEqual(parseYaml('topics:\n    []\nnext: 1'), { topics: [], next: '1' });
  assert.equal(parseYaml(''), null);
  assert.deepEqual(parseYaml('# comment\nurl: http://robot:8080/x\n'), { url: 'http://robot:8080/x' });
});

test('a bag’s metadata, as Humble and Jazzy write it', () => {
  const humble = parseMetadata(HUMBLE);
  assert.equal(humble.version, 5);
  assert.equal(humble.storage, 'sqlite3');
  // Nanoseconds beyond a number's integers: to the microsecond
  assert.equal(humble.start, 1792660059552.105);
  assert.equal(humble.duration, 3199.956);
  assert.equal(humble.messages, 65);
  assert.deepEqual(humble.topics, [{ name: '/chatter', type: 'std_msgs/msg/String', count: 65 }]);
  assert.deepEqual(humble.compression, { mode: 'file', format: 'zstd' });
  // The files as they are on disk, not as they were recorded
  assert.deepEqual(humble.files, ['fz_0.db3.zstd', 'fz_1.db3.zstd']);

  const jazzy = parseMetadata(JAZZY);
  assert.equal(jazzy.storage, 'mcap');
  assert.deepEqual(jazzy.topics, [
    { name: '/scan', type: 'sensor_msgs/msg/LaserScan', count: 90 },
    { name: '/tf_static', type: 'tf2_msgs/msg/TFMessage', count: 9 },
  ]);
  assert.equal(jazzy.compression, null);
  assert.deepEqual(jazzy.files, ['run_0.mcap']);
  // Without messages: no start, which rosbag2 says is in 2262
  const empty = parseMetadata(HUMBLE.replace('message_count: 65', 'message_count: 0').replace('1792660059552105986', '9223372036854775807'));
  assert.deepEqual([empty.start, empty.duration, empty.messages], [null, 0, 0]);
  assert.throws(() => parseMetadata('version: 5'), /Not a rosbag’s metadata/);
});

const request = (changes: Partial<RecordRequest> = {}, options: Partial<RecordRequest['options']> = {}): RecordRequest => ({
  path: '/bags/run',
  topics: ['/scan', '/odom'],
  all: false,
  regex: '',
  exclude: '',
  options: { ...DEFAULT_RECORD_OPTIONS, ...options },
  ...changes,
});

test('ros2 bag record’s arguments: topics as each distribution takes them, the options', () => {
  assert.deepEqual(recordArguments(request(), 'humble'), ['bag', 'record', '-o', '/bags/run', '/scan', '/odom']);
  assert.deepEqual(recordArguments(request(), 'jazzy'), ['bag', 'record', '-o', '/bags/run', '--topics', '/scan', '/odom']);
  // All topics, not the services' events Jazzy's -a records too
  assert.deepEqual(recordArguments(request({ all: true, topics: [], exclude: '/camera' }), 'jazzy'), [
    'bag', 'record', '-o', '/bags/run', '--all-topics', '-x', '/camera',
  ]);
  assert.deepEqual(recordArguments(request({ all: true, topics: [] }), 'humble').slice(4), ['-a']);
  assert.deepEqual(
    recordArguments(
      request(
        { topics: [], regex: '^/tf' },
        {
          storage: 'sqlite3',
          preset: 'resilient',
          maxBagSize: 1e9,
          maxBagDuration: 600,
          compressionMode: 'file',
          compressionFormat: 'zstd',
          maxCacheSize: 50e6,
          includeHidden: true,
          useSimTime: true,
        },
      ),
      'kilted',
    ).slice(4),
    [
      '-e', '^/tf',
      '-s', 'sqlite3',
      '--storage-preset-profile', 'resilient',
      '-b', '1000000000',
      '-d', '600',
      '--compression-mode', 'file',
      '--compression-format', 'zstd',
      '--max-cache-size', '50000000',
      '--include-hidden-topics',
      '--use-sim-time',
    ],
  );
});

test('ros2 bag play’s arguments, its topics last', () => {
  const play = { path: '/bags/run', rate: 2, loop: true, topics: ['/scan'], startOffset: 4.5, clock: true, startPaused: true };
  assert.deepEqual(playArguments(play), [
    'bag', 'play', '/bags/run', '-r', '2', '-l', '--start-offset', '4.5', '--clock', '-p', '--topics', '/scan',
  ]);
  assert.deepEqual(playArguments({ ...play, loop: false, topics: [], startOffset: 0, clock: false, startPaused: false }), [
    'bag', 'play', '/bags/run', '-r', '2',
  ]);
});

test('what a page asks is checked: what rosbag2 would refuse, refused first', () => {
  assert.deepEqual(checkRecordOptions(undefined), DEFAULT_RECORD_OPTIONS);
  assert.deepEqual(checkRecordOptions({ maxBagSize: -5, maxBagDuration: 'x', includeHidden: 'yes', compressionMode: 'zip' }), DEFAULT_RECORD_OPTIONS);
  assert.throws(() => checkRecordOptions({ storage: 'mcap', compressionMode: 'message' }), /MCAP does not compress each message/);
  assert.throws(() => checkRecordOptions({ storage: 'mcap', preset: 'resilient' }), /mcap has no preset resilient/);
  assert.throws(() => checkRecordOptions({ storage: 'mcap; rm -rf ~' }), /Invalid storage/);
  // An unknown plugin's presets are its own
  assert.equal(checkRecordOptions({ storage: 'my_storage', preset: 'fast' }).preset, 'fast');

  assert.throws(() => checkRecordRequest({ path: '~/bags/a', topics: [] }), /Nothing to record/);
  assert.throws(() => checkRecordRequest({ path: '~/bags/a', topics: ['/ok', 'not a topic'] }), /Not a topic name: not a topic/);
  assert.throws(() => checkRecordRequest({ path: ' ', all: true }), /path/);
  assert.deepEqual(checkRecordRequest({ path: ' ~/bags/a ', topics: ['/scan', ' /scan', 'odom'] }).topics, ['/scan', 'odom']);

  assert.deepEqual(checkPlayRequest({ path: '/b', rate: 1000, startOffset: -3 }), {
    path: '/b', rate: 100, loop: false, topics: [], startOffset: 0, clock: false, startPaused: false,
  });
  assert.deepEqual(checkBagsRequest({ action: 'seek', position: -10 }), { action: 'seek', position: 0 });
  assert.deepEqual(checkBagsRequest({ action: 'pause', extra: 1 }), { action: 'pause' });
  assert.equal(checkBagsRequest({ action: 'record', path: '/b', all: true }).action, 'record');
  assert.throws(() => checkBagsRequest({ action: 'delete', paths: [] }), /paths/);
  assert.throws(() => checkBagsRequest({ action: 'format' }), /Unknown rosbag action/);
});

test('ros2 bag list: the plugins, but rosbag2’s test ones', () => {
  assert.deepEqual(pluginNames('mcap\nsqlite3\nmy_test_plugin\nmy_read_only_test_plugin\n'), ['mcap', 'sqlite3']);
  assert.deepEqual(pluginNames('zstd\nfake_comp\n'), ['zstd']);
});

test('where a playback is: on at its rate while playing, looping or stopping at its end', () => {
  const playback: Playback = {
    path: '/b', rate: 2, loop: false, topics: [], startOffset: 0, clock: false, startPaused: false,
    state: 'playing', start: 1000, duration: 10_000, position: 1000, at: 5000, error: null,
  };
  assert.equal(playbackPosition(playback, 7000), 5000);
  assert.equal(playbackPosition(playback, 60_000), 10_000);
  assert.equal(playbackPosition({ ...playback, loop: true }, 10_000), 1000);
  assert.equal(playbackPosition({ ...playback, state: 'paused' }, 60_000), 1000);
});
