import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
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

// Whether the page that opened a WebSocket is one of the dashboard's own.
// Browsers say which site a page is from (Origin), and another site's page
// cannot change it; the dashboard's is the host the page reached: the Host
// header, or the X-Forwarded-Host of a reverse proxy. Programs other than
// browsers send no Origin.
export function ownPage(headers: IncomingHttpHeaders): boolean {
  if (headers.origin === undefined) {
    return true;
  }
  let host: string;
  try {
    host = new URL(headers.origin).host.toLowerCase();
  } catch {
    // "null": a sandboxed frame, a file
    return false;
  }
  const forwarded = headers['x-forwarded-host'];
  const proxied = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return [headers.host, proxied].some((reached) => reached?.toLowerCase() === host);
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

// Of a file's content
export function contentVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Writes the file anew, at once: a temporary file renamed over it, keeping
// its mode; in place if that cannot be (a folder the server cannot write in,
// a file of another user's)
export async function replaceFile(file: string, text: string): Promise<void> {
  const stat = await fs.stat(file);
  if (stat.uid === process.getuid?.()) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporary, text, { mode: stat.mode & 0o7777, flag: 'wx' });
      await fs.rename(temporary, file);
      return;
    } catch {
      await fs.rm(temporary, { force: true });
    }
  }
  await fs.writeFile(file, text);
}
