import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// What the server logs through: the ROS node's logger (rosout and stdout)
export interface Logger {
  debug(message: string): unknown;
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

// The share directory of a ROS package, from the ament index of the sourced
// workspaces (like `ros2 pkg prefix --share`); null if not installed.
export function packageShareDirectory(name: string): string | null {
  for (const prefix of (process.env.AMENT_PREFIX_PATH ?? '').split(':')) {
    if (prefix && existsSync(path.join(prefix, 'share/ament_index/resource_index/packages', name))) {
      return path.join(prefix, 'share', name);
    }
  }
  return null;
}

// ~/.local/share/tassello/panels
export function defaultPanelsDirectory(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'tassello', 'panels');
}

// Tassello's package folder, where its package.json is: the server runs from
// src/server (development) or dist/server (built), both two levels down
export function tasselloRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}

// Topic names as the ROS graph reports them: absolute, no trailing slash
export function absoluteTopic(topic: string): string {
  const trimmed = topic.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Colours and cursor movements of terminal output
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPES, '');
}

// A ROS message as JSON: rclnodejs gives numeric arrays as typed arrays, which
// JSON.stringify writes as objects, and 64 bit integers as BigInt, which it
// refuses
export function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number | bigint>, (v) => (typeof v === 'bigint' ? Number(v) : v));
  }
  if (Array.isArray(value)) {
    return value.map(toJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, toJson(v)]));
  }
  return value;
}
