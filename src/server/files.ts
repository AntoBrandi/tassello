// Images for the image viewer widgets, and behavior trees (XML) for the
// behavior tree inspectors: files of the robot, which a page picks by
// browsing its directories, and files uploaded from a page, kept by the
// server next to the panels. Only those: the dashboard does not hand out any
// file of the robot. A page also browses for rosbags, and for folders.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpError } from './panels.ts';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
// The files a page browses for, by kind: folders only for 'folder'. Bags are
// folders (with their metadata.yaml) or their files.
export type FileKind = 'image' | 'behavior-tree' | 'bag' | 'folder';
const EXTENSIONS: Record<FileKind, Set<string>> = {
  image: IMAGE_EXTENSIONS,
  'behavior-tree': new Set(['.xml']),
  bag: new Set(['.mcap', '.db3']),
  folder: new Set(),
};
const FILE_KINDS = new Set(Object.keys(EXTENSIONS));
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// Uploaded files are named after their content: no clash, no duplicate
const UPLOAD_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp|bmp|svg|xml)$/;
// BT.CPP's XML, whose root element is <root>
const BEHAVIOR_TREE = /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<root[\s>]/;

export function fileKind(value: string | null): FileKind {
  return value && FILE_KINDS.has(value) ? (value as FileKind) : 'image';
}

// A robot path (absolute or ~/...) to an image file; throws for anything else
export function resolveImagePath(input: string, home = os.homedir()): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new HttpError(400, `Not an absolute path: "${input}"`);
  }
  const resolved = path.resolve(expanded);
  if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new HttpError(403, `Not an image: "${input}" (${[...IMAGE_EXTENSIONS].join(' ')})`);
  }
  return resolved;
}

// The image's extension, from its first bytes, or null if not an image
export function imageType(data: Buffer): string | null {
  const starts = (bytes: number[], offset = 0) => bytes.every((b, i) => data[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47])) {
    return 'png';
  }
  if (starts([0xff, 0xd8, 0xff])) {
    return 'jpg';
  }
  if (starts([0x47, 0x49, 0x46, 0x38])) {
    return 'gif';
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  if (starts([0x42, 0x4d])) {
    return 'bmp';
  }
  const head = data.subarray(0, 1024).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'svg';
  }
  return null;
}

export interface DirectoryListing {
  dir: string;
  // null at the root
  parent: string | null;
  // Directories first, then the files of the kind listed; hidden ones left out
  entries: { name: string; kind: 'dir' | FileKind }[];
}

// Of the directory (~ by default): its directories and files of that kind
export async function listDirectory(
  input: string,
  kind: FileKind = 'image',
  home = os.homedir(),
): Promise<DirectoryListing> {
  const trimmed = input.trim() || '~';
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new HttpError(400, `Not an absolute path: "${input}"`);
  }
  const dir = path.resolve(expanded);
  let found;
  try {
    found = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new HttpError(code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 403, `Cannot read ${dir}: ${code}`);
  }
  const entries: DirectoryListing['entries'] = [];
  for (const entry of found) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    // Links count as what they point to
    const target = entry.isSymbolicLink()
      ? await fs.stat(path.join(dir, entry.name)).catch(() => null)
      : entry;
    if (target?.isDirectory()) {
      const bag = kind === 'bag' && (await fs.stat(path.join(dir, entry.name, 'metadata.yaml')).catch(() => null));
      entries.push({ name: entry.name, kind: bag ? 'bag' : 'dir' });
    } else if (target?.isFile() && EXTENSIONS[kind].has(path.extname(entry.name).toLowerCase())) {
      entries.push({ name: entry.name, kind });
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return { dir, parent: dir === path.parse(dir).root ? null : path.dirname(dir), entries };
}

// Saves an uploaded image or behavior tree; returns its name in the uploads
// directory
export async function saveUpload(uploadsDir: string, data: Buffer): Promise<string> {
  const head = data.subarray(0, 64 * 1024).toString('utf8').trimStart();
  const type = imageType(data) ?? (BEHAVIOR_TREE.test(head) ? 'xml' : null);
  if (!type) {
    throw new HttpError(415, 'Not an image (PNG, JPEG, GIF, WebP, BMP, SVG) nor a behavior tree (XML)');
  }
  const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${type}`;
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(path.join(uploadsDir, name), data);
  return name;
}

export function isUploadName(name: string): boolean {
  return UPLOAD_NAME.test(name);
}
