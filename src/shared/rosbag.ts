// Rosbags (rosbag2), as the page and the server share them: the bags of a
// folder, with what their metadata says; what ros2 bag record is asked to
// record, and with which options; the recordings going on, and the playback
// (ros2 bag play) on the robot. See src/server/rosbags.ts.

// What ros2 bag record makes. A storage, preset or compression format the
// robot's rosbag2 lacks is refused by it, with its reason.
export interface RecordOptions {
  // mcap, sqlite3; '' the distribution's default (MCAP since Iron, SQLite
  // on Humble)
  storage: string;
  // --storage-preset-profile: MCAP's fastwrite, zstd_fast, zstd_small,
  // SQLite's resilient; '' none
  preset: string;
  // A new file of the bag when one reaches this size (bytes) or covers this
  // long (s); 0: never
  maxBagSize: number;
  maxBagDuration: number;
  // rosbag2's compression, of each file once written or of each message;
  // MCAP compresses its chunks instead, with a zstd preset
  compressionMode: CompressionMode;
  compressionFormat: string;
  // Of the messages held before written, bytes; 0: rosbag2's default
  maxCacheSize: number;
  // Topics ROS keeps to itself, e.g. /_action/status
  includeHidden: boolean;
  // The messages' times by /clock
  useSimTime: boolean;
}

export type CompressionMode = 'none' | 'file' | 'message';
export const COMPRESSION_MODES: readonly CompressionMode[] = ['none', 'file', 'message'];

export const DEFAULT_RECORD_OPTIONS: RecordOptions = {
  storage: '',
  preset: '',
  maxBagSize: 0,
  maxBagDuration: 0,
  compressionMode: 'none',
  compressionFormat: 'zstd',
  maxCacheSize: 0,
  includeHidden: false,
  useSimTime: false,
};

// The storage presets of rosbag2's plugins
export const STORAGE_PRESETS: Readonly<Record<string, readonly string[]>> = {
  mcap: ['fastwrite', 'zstd_fast', 'zstd_small'],
  sqlite3: ['resilient'],
};

// What to record: the topics named, or all of them (but those excluded),
// those matching a regular expression too
export interface RecordRequest {
  // The bag's folder, which the recording makes: /…, ~/…
  path: string;
  topics: string[];
  all: boolean;
  // ECMAScript-like, as rosbag2 reads them (std::regex); '' none
  regex: string;
  exclude: string;
  options: RecordOptions;
}

export interface Recording extends RecordRequest {
  // When it started, on the server's clock
  since: number;
  // Of its files so far
  size: number;
  // Who started it: the Rosbags widget, or a behavior tree inspector
  by: 'rosbags' | 'behavior-tree';
}

export interface BagTopic {
  name: string;
  // e.g. sensor_msgs/msg/LaserScan
  type: string;
  // null if unknown: a bag without metadata
  count: number | null;
}

export interface BagFile {
  // Within the bag's folder
  name: string;
  size: number;
}

export interface BagInfo {
  // Its folder, or its file if it is a lone .mcap or .db3
  path: string;
  name: string;
  // Of its files
  size: number;
  // Of its newest file, ms since the epoch
  modified: number;
  // mcap, sqlite3; '' if unknown
  storage: string;
  // Of its first message, ms since the epoch; null if unknown
  start: number | null;
  // ms; null if unknown
  duration: number | null;
  messages: number | null;
  topics: BagTopic[];
  files: BagFile[];
  // rosbag2's compression (not MCAP's chunks'): file or message, zstd
  compression: { mode: 'file' | 'message'; format: string } | null;
  // Being recorded now
  recording: boolean;
  // What is wrong with it, e.g. it has no metadata: its recording did not end
  problem: string | null;
}

// ros2 bag play
export interface PlayRequest {
  path: string;
  // 1: as recorded
  rate: number;
  loop: boolean;
  // Only these; all if empty
  topics: string[];
  // From this far into the bag, s
  startOffset: number;
  // Publishes the bag's time on /clock, for nodes using sim time
  clock: boolean;
  startPaused: boolean;
}

// The playback on the robot, one at a time, whichever page started it
export interface Playback extends PlayRequest {
  // starting: ros2 bag play is opening the bag; ended: it played it whole
  // (or failed, see error) and exited
  state: 'starting' | 'playing' | 'paused' | 'ended';
  // The bag's clock: when it starts, ms since the epoch; and how long
  start: number;
  duration: number;
  // Where the playback is, ms into the bag, at the server's time `at`: it
  // moves on at its rate while playing
  position: number;
  at: number;
  error: string | null;
}

// Where a playback is at the server's time now, ms into the bag
export function playbackPosition(playback: Playback, now: number): number {
  if (playback.state !== 'playing') {
    return playback.position;
  }
  const position = playback.position + Math.max(0, now - playback.at) * playback.rate;
  if (playback.loop && playback.duration > 0) {
    return position % playback.duration;
  }
  return Math.min(playback.duration, position);
}

// What the robot's rosbag2 offers, as ros2 bag list says
export interface BagCapabilities {
  storages: string[];
  compressors: string[];
  // Of this distribution, used when the options name none
  defaultStorage: string;
  distro: string;
}

// What a page asks of the rosbags (BagsAction), answered with:
//   record         the Recording, once it records
//   stop           the bag's path, null if it was not being recorded
//   delete         the paths deleted: bags only, neither recorded nor played
//   play           the Playback, once ros2 bag play has opened the bag
//   pause, resume, seek (ms into the bag), rate, stop-playback: null
export type BagsRequest =
  | ({ action: 'record' } & RecordRequest)
  | { action: 'stop'; path: string }
  | { action: 'delete'; paths: string[] }
  | ({ action: 'play' } & PlayRequest)
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'stop-playback' }
  | { action: 'seek'; position: number }
  | { action: 'rate'; rate: number };

// The rates a playback goes at, 1 as recorded
export const MIN_PLAY_RATE = 0.01;
export const MAX_PLAY_RATE = 100;
