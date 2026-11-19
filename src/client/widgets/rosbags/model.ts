// What the rosbags' views compute, the Rosbags widget's and the behavior tree
// inspector's: names and paths of new bags, durations, rates, what a bag or a
// recording holds in a few words, and the units of the record options.

import type { BagInfo, BagRepair, BagTopic, Recording, RecordOptions } from '../../../shared/rosbag.ts';
import { formatSize } from '../file_manager/model.ts';

// 1:05, 1:02:09
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// A bag's length: 850 ms, 12.4 s, 1:05, 1:02:09
export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '?';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return elapsed(ms);
}

// The last part of a path
export function baseName(path: string): string {
  return path.replace(/\/+$/, '').replace(/^.*\//, '') || path;
}

// <folder>/<prefix>_2026-10-20_14-03-27: sorted by time
export function newBagPath(folder: string, prefix: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${folder.trim().replace(/\/+$/, '') || '~'}/${prefix}_${date}_${time}`;
}

// Messages a second over the bag
export function topicRate(topic: BagTopic, duration: number | null): string {
  if (topic.count === null || !duration) {
    return '';
  }
  const rate = topic.count / (duration / 1000);
  return rate >= 100 ? `${Math.round(rate)} Hz` : rate >= 1 ? `${rate.toFixed(1)} Hz` : `${rate.toFixed(2)} Hz`;
}

export function storageLabel(storage: string): string {
  return storage === 'mcap' ? 'MCAP' : storage === 'sqlite3' ? 'SQLite' : storage || '?';
}

// /scan, /odom and 3 more
export function topicList(names: readonly string[], shown = 2): string {
  if (names.length <= shown + 1) {
    return names.join(', ');
  }
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

// What a recording records, in a few words
export function recordingWhat(recording: Pick<Recording, 'all' | 'topics' | 'regex' | 'exclude'>): string {
  const parts: string[] = [];
  if (recording.all) {
    parts.push('all topics');
  } else if (recording.topics.length) {
    parts.push(topicList(recording.topics));
  }
  if (recording.regex) {
    parts.push(`those matching ${recording.regex}`);
  }
  if (recording.exclude) {
    parts.push(`but ${recording.exclude}`);
  }
  return parts.join(', ');
}

// The options that are not rosbag2's defaults, in a few words
export function optionsSummary(options: RecordOptions, defaultStorage: string): string {
  const parts = [storageLabel(options.storage || defaultStorage)];
  if (options.preset) {
    parts.push(options.preset);
  }
  if (options.compressionMode !== 'none') {
    parts.push(`${options.compressionFormat} by ${options.compressionMode}`);
  }
  const splits = [
    options.maxBagSize > 0 ? sizeText(options.maxBagSize) : '',
    options.maxBagDuration > 0 ? durationText(options.maxBagDuration) : '',
  ].filter(Boolean);
  if (splits.length) {
    parts.push(`split at ${splits.join(' or ')}`);
  }
  if (options.includeHidden) {
    parts.push('hidden topics');
  }
  if (options.useSimTime) {
    parts.push('sim time');
  }
  return parts.join(' · ');
}

// The units of the size and duration fields, by their factor
export const SIZE_UNITS = [
  { label: 'MB', factor: 1e6 },
  { label: 'GB', factor: 1e9 },
] as const;

export const DURATION_UNITS = [
  { label: 's', factor: 1 },
  { label: 'min', factor: 60 },
  { label: 'h', factor: 3600 },
] as const;

const thousandths = (value: number) => Math.round(value * 1000) / 1000;

// A value in the largest unit it is a whole number of, else in the smallest
export function inUnit(value: number, units: readonly { label: string; factor: number }[]): { amount: number; factor: number } {
  const unit = [...units].reverse().find((u) => value >= u.factor && Number.isInteger(thousandths(value / u.factor))) ?? units[0];
  return { amount: thousandths(value / unit.factor), factor: unit.factor };
}

function sizeText(bytes: number): string {
  const { amount, factor } = inUnit(bytes, SIZE_UNITS);
  return `${amount} ${SIZE_UNITS.find((u) => u.factor === factor)?.label}`;
}

function durationText(seconds: number): string {
  const { amount, factor } = inUnit(seconds, DURATION_UNITS);
  return `${amount} ${DURATION_UNITS.find((u) => u.factor === factor)?.label}`;
}

// Whose name, or one of whose topics, contains any of the terms (;)
export function filterBags(bags: readonly BagInfo[], text: string): BagInfo[] {
  const terms = text
    .split(';')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) {
    return [...bags];
  }
  return bags.filter((bag) =>
    terms.some((term) => bag.name.toLowerCase().includes(term) || bag.topics.some((topic) => topic.name.toLowerCase().includes(term))),
  );
}

// How far a repair is: 0 to 100
export function repairPercent(progress: { done: number; total: number }): number {
  return progress.total > 0 ? Math.min(100, Math.floor((progress.done / progress.total) * 100)) : 0;
}

// Reading its files, 45% (1.2 GB of 2.6 GB)
export function repairStatus(progress: { done: number; total: number }): string {
  if (progress.total === 0) {
    return 'Repairing: looking at its files…';
  }
  return `Repairing: reading its files, ${repairPercent(progress)}% (${formatSize(progress.done)} of ${formatSize(progress.total)})`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// What a repair did, in a sentence
export function repairSummary(repair: BagRepair): string {
  const parts = [
    `Repaired ${baseName(repair.path)}: ${plural(repair.messages, 'message')} over ${formatDuration(repair.duration)}, in ${plural(repair.files.length, 'file')}`,
  ];
  if (repair.compressed.length > 0) {
    parts.push(`${repair.compressed.map((name) => name.replace(/\.zstd$/i, '')).join(', ')} compressed, as its recording would have`);
  }
  if (repair.skipped.length > 0) {
    parts.push(`left out, as nothing of them can be read: ${repair.skipped.map((file) => `${file.name} (${file.reason})`).join(', ')}`);
  }
  return parts.join('; ');
}
