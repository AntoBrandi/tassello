// Rosbags as text: a bag's metadata.yaml, as rosbag2 writes it; the command
// lines of ros2 bag record and ros2 bag play, from what a page asks; and what
// a page asks, checked.

import {
  COMPRESSION_MODES,
  DEFAULT_RECORD_OPTIONS,
  MAX_PLAY_RATE,
  MIN_PLAY_RATE,
  STORAGE_PRESETS,
  type BagsRequest,
  type BagTopic,
  type CompressionMode,
  type PlayRequest,
  type RecordOptions,
  type RecordRequest,
} from '../shared/rosbag.ts';

// ── metadata.yaml ────────────────────────────────────────────────────────────
// Block YAML as yaml-cpp writes it: mappings, sequences (of mappings too),
// plain and quoted scalars, empty flow collections. Plain scalars stay text:
// a time in nanoseconds is beyond a number's integers.

type Yaml = string | null | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ' };

function scalar(text: string): Yaml {
  const value = text.trim();
  if (value.startsWith('"')) {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      const c = value[i];
      if (c === '"') {
        break;
      }
      if (c !== '\\') {
        out += c;
        continue;
      }
      const next = value[++i];
      if (next === 'u' || next === 'x') {
        const size = next === 'u' ? 4 : 2;
        out += String.fromCharCode(parseInt(value.slice(i + 1, i + 1 + size), 16));
        i += size;
      } else {
        out += ESCAPES[next] ?? next;
      }
    }
    return out;
  }
  if (value.startsWith("'")) {
    return value.slice(1, value.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  }
  if (value === '~' || value === 'null' || value === '') {
    return null;
  }
  if (value === '[]') {
    return [];
  }
  if (value === '{}') {
    return {};
  }
  return value;
}

// key: value, a quoted key too; null if the line is not one
function keyValue(text: string): [string, string] | null {
  const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#][^:#]*?)\s*:(?:\s+(.*)|$)/.exec(text);
  if (!match) {
    return null;
  }
  return [String(scalar(match[1])), match[2] ?? ''];
}

export function parseYaml(text: string): Yaml {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trimEnd();
    const content = trimmed.trimStart();
    if (content && !content.startsWith('#') && content !== '---' && content !== '...') {
      lines.push({ indent: trimmed.length - content.length, text: content });
    }
  }
  let at = 0;

  // The value of a key whose text was empty: the block below it, if any
  function nested(parent: number): Yaml {
    const line = lines[at];
    if (!line) {
      return null;
    }
    // A scalar of its own, e.g. the [] of an empty bag's topics
    if (line.indent > parent && !line.text.startsWith('-') && !keyValue(line.text)) {
      at++;
      return scalar(line.text);
    }
    // A sequence may sit at its key's indent
    if (line.indent > parent || (line.indent === parent && line.text.startsWith('-'))) {
      return block(line.indent);
    }
    return null;
  }

  function block(indent: number): Yaml {
    return lines[at]?.text.startsWith('-') ? sequence(indent) : mapping(indent);
  }

  function mapping(indent: number): Yaml {
    const map: { [key: string]: Yaml } = {};
    while (at < lines.length && lines[at].indent === indent && !lines[at].text.startsWith('- ') && lines[at].text !== '-') {
      const pair = keyValue(lines[at].text);
      at++;
      if (!pair) {
        continue;
      }
      const [key, value] = pair;
      map[key] = value.trim() ? scalar(value) : nested(indent);
    }
    return map;
  }

  function sequence(indent: number): Yaml {
    const list: Yaml[] = [];
    while (at < lines.length && lines[at].indent === indent && (lines[at].text.startsWith('- ') || lines[at].text === '-')) {
      const rest = lines[at].text.slice(1).trimStart();
      const column = indent + (lines[at].text.length - rest.length);
      if (!rest) {
        at++;
        list.push(nested(indent));
      } else if (keyValue(rest)) {
        // - key: value, the item a mapping whose keys line up with this one
        lines[at] = { indent: column, text: rest };
        list.push(mapping(column));
      } else {
        at++;
        list.push(scalar(rest));
      }
    }
    return list;
  }

  return lines.length ? block(lines[0].indent) : null;
}

export interface BagMetadata {
  // e.g. 5 (Humble), 9 (Jazzy)
  version: number;
  storage: string;
  // ms since the epoch, and ms
  start: number | null;
  duration: number | null;
  messages: number | null;
  topics: BagTopic[];
  compression: { mode: 'file' | 'message'; format: string } | null;
  // Its files, within its folder: compressed ones as they are on disk
  files: string[];
}

const object = (value: Yaml | undefined): { [key: string]: Yaml } =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value: Yaml | undefined): Yaml[] => (Array.isArray(value) ? value : []);
const text = (value: Yaml | undefined): string => (typeof value === 'string' ? value : '');

// Nanoseconds, as text: ms
export function nanoseconds(value: Yaml | undefined): number | null {
  const digits = text(value);
  return /^-?\d+$/.test(digits) ? Number(BigInt(digits) / 1000n) / 1000 : null;
}

function count(value: Yaml | undefined): number | null {
  const digits = text(value);
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

// A metadata.yaml; throws if it is not one
export function parseMetadata(yaml: string): BagMetadata {
  const root = object(object(parseYaml(yaml)).rosbag2_bagfile_information);
  if (Object.keys(root).length === 0) {
    throw new Error('Not a rosbag’s metadata: no rosbag2_bagfile_information');
  }
  const mode = text(root.compression_mode).toLowerCase();
  const format = text(root.compression_format);
  const messages = count(root.message_count);
  return {
    version: count(root.version) ?? 0,
    storage: text(root.storage_identifier),
    // Without messages, rosbag2 starts it at the end of time (2262)
    start: messages === 0 ? null : nanoseconds(object(root.starting_time).nanoseconds_since_epoch),
    duration: messages === 0 ? 0 : nanoseconds(object(root.duration).nanoseconds),
    messages,
    topics: list(root.topics_with_message_count).map((entry) => {
      const topic = object(object(entry).topic_metadata);
      return { name: text(topic.name), type: text(topic.type), count: count(object(entry).message_count) };
    }),
    compression: (mode === 'file' || mode === 'message') && format ? { mode, format } : null,
    files: list(root.relative_file_paths).map(text).filter(Boolean),
  };
}

// ── Command lines ────────────────────────────────────────────────────────────

// Before Jazzy, ros2 bag record took its topics as arguments, and -a was all
// the topics: since, --topics, and -a also records the services' events
function olderRosbag2(distro: string): boolean {
  return ['foxy', 'galactic', 'humble', 'iron'].includes(distro.toLowerCase());
}

// ros2 bag record's arguments (after ros2)
export function recordArguments(request: RecordRequest, distro: string): string[] {
  const { options } = request;
  const older = olderRosbag2(distro);
  const args = ['bag', 'record', '-o', request.path];
  if (request.all) {
    args.push(older ? '-a' : '--all-topics');
  }
  if (request.regex) {
    args.push('-e', request.regex);
  }
  if (request.exclude) {
    args.push('-x', request.exclude);
  }
  if (options.storage) {
    args.push('-s', options.storage);
  }
  if (options.preset) {
    args.push('--storage-preset-profile', options.preset);
  }
  if (options.maxBagSize > 0) {
    args.push('-b', String(Math.round(options.maxBagSize)));
  }
  if (options.maxBagDuration > 0) {
    args.push('-d', String(Math.round(options.maxBagDuration)));
  }
  if (options.compressionMode !== 'none') {
    args.push('--compression-mode', options.compressionMode, '--compression-format', options.compressionFormat);
  }
  if (options.maxCacheSize > 0) {
    args.push('--max-cache-size', String(Math.round(options.maxCacheSize)));
  }
  if (options.includeHidden) {
    args.push('--include-hidden-topics');
  }
  if (options.useSimTime) {
    args.push('--use-sim-time');
  }
  if (request.topics.length > 0) {
    args.push(...(older ? [] : ['--topics']), ...request.topics);
  }
  return args;
}

// ros2 bag play's arguments (after ros2): the topics last, as --topics takes
// all that follow
export function playArguments(request: PlayRequest): string[] {
  const args = ['bag', 'play', request.path, '-r', String(request.rate)];
  if (request.loop) {
    args.push('-l');
  }
  if (request.startOffset > 0) {
    args.push('--start-offset', String(request.startOffset));
  }
  if (request.clock) {
    args.push('--clock');
  }
  if (request.startPaused) {
    args.push('-p');
  }
  if (request.topics.length > 0) {
    args.push('--topics', ...request.topics);
  }
  return args;
}

// What ros2 bag list prints: the plugins' names, but rosbag2's test ones
export function pluginNames(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => /^[A-Za-z][\w-]*$/.test(name) && !/^(my_|fake_)/.test(name));
}

// ── Requests ─────────────────────────────────────────────────────────────────

const TOPIC = /^~?\/?[A-Za-z_{][\w/{}~]*$/;
const NAME = /^[A-Za-z][\w-]*$/;

function record(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function pathOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A rosbag’s path: /…, ~/…');
  }
  return value.trim();
}

function topicsOf(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((topic) => typeof topic === 'string')) {
    throw new Error('topics must be a list of topic names');
  }
  const topics = [...new Set(value.map((topic: string) => topic.trim()).filter(Boolean))];
  const invalid = topics.find((topic) => !TOPIC.test(topic));
  if (invalid) {
    throw new Error(`Not a topic name: ${invalid}`);
  }
  return topics;
}

function amount(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;
}

// What the page asks for, made safe to pass to ros2 bag record; refused if
// rosbag2 would refuse it
export function checkRecordOptions(value: unknown): RecordOptions {
  const options = record(value);
  const name = (field: string, given: unknown) => {
    if (given === undefined || given === '') {
      return '';
    }
    if (typeof given !== 'string' || !NAME.test(given)) {
      throw new Error(`Invalid ${field}: ${String(given)}`);
    }
    return given;
  };
  const storage = name('storage', options.storage);
  const preset = name('storage preset', options.preset);
  const compressionMode: CompressionMode = COMPRESSION_MODES.includes(options.compressionMode as CompressionMode)
    ? (options.compressionMode as CompressionMode)
    : 'none';
  const compressionFormat = name('compression format', options.compressionFormat) || DEFAULT_RECORD_OPTIONS.compressionFormat;
  if (storage && preset && STORAGE_PRESETS[storage] && !STORAGE_PRESETS[storage].includes(preset)) {
    throw new Error(`${storage} has no preset ${preset}: ${STORAGE_PRESETS[storage].join(', ')}`);
  }
  if (storage === 'mcap' && compressionMode === 'message') {
    throw new Error('MCAP does not compress each message: compress its chunks with the zstd_fast or zstd_small preset');
  }
  return {
    storage,
    preset,
    maxBagSize: amount(options.maxBagSize, 2 ** 50),
    maxBagDuration: amount(options.maxBagDuration, 10 * 365 * 86400),
    compressionMode,
    compressionFormat,
    maxCacheSize: amount(options.maxCacheSize, 2 ** 40),
    includeHidden: options.includeHidden === true,
    useSimTime: options.useSimTime === true,
  };
}

export function checkRecordRequest(value: unknown): RecordRequest {
  const request = record(value);
  const text = (field: string, given: unknown) => {
    if (given !== undefined && typeof given !== 'string') {
      throw new Error(`${field} must be text`);
    }
    return (given ?? '').trim();
  };
  const checked: RecordRequest = {
    path: pathOf(request.path),
    topics: topicsOf(request.topics),
    all: request.all === true,
    regex: text('regex', request.regex),
    exclude: text('exclude', request.exclude),
    options: checkRecordOptions(request.options),
  };
  if (!checked.all && checked.topics.length === 0 && !checked.regex) {
    throw new Error('Nothing to record: choose topics, all of them, or a regular expression');
  }
  return checked;
}

export function checkPlayRequest(value: unknown): PlayRequest {
  const request = record(value);
  const rate = typeof request.rate === 'number' && Number.isFinite(request.rate) ? request.rate : 1;
  return {
    path: pathOf(request.path),
    rate: Math.min(MAX_PLAY_RATE, Math.max(MIN_PLAY_RATE, rate)),
    loop: request.loop === true,
    topics: topicsOf(request.topics),
    startOffset: amount(request.startOffset, 1e9),
    clock: request.clock === true,
    startPaused: request.startPaused === true,
  };
}

export function checkBagsRequest(value: unknown): BagsRequest {
  const request = record(value);
  switch (request.action) {
    case 'record':
      return { action: 'record', ...checkRecordRequest(request) };
    case 'stop':
      return { action: 'stop', path: pathOf(request.path) };
    case 'delete': {
      if (!Array.isArray(request.paths) || request.paths.length === 0) {
        throw new Error('paths must be a list of rosbags’ paths');
      }
      return { action: 'delete', paths: request.paths.map(pathOf) };
    }
    case 'play':
      return { action: 'play', ...checkPlayRequest(request) };
    case 'pause':
      return { action: 'pause' };
    case 'resume':
      return { action: 'resume' };
    case 'stop-playback':
      return { action: 'stop-playback' };
    case 'seek':
      if (typeof request.position !== 'number' || !Number.isFinite(request.position)) {
        throw new Error('position must be a number of ms');
      }
      return { action: 'seek', position: Math.max(0, request.position) };
    case 'rate':
      if (typeof request.rate !== 'number' || !Number.isFinite(request.rate)) {
        throw new Error('rate must be a number');
      }
      return { action: 'rate', rate: Math.min(MAX_PLAY_RATE, Math.max(MIN_PLAY_RATE, request.rate)) };
    default:
      throw new Error(`Unknown rosbag action ${JSON.stringify(request.action)}`);
  }
}
