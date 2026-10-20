// The robot's files, for the file manager widgets (see
// src/shared/file_manager.ts): folders listed with their entries' sizes,
// times, owners and permissions; text files read, and saved only over the
// version read; entries made, renamed, moved, copied, deleted and their
// permissions changed; uploads received; folders analyzed, what takes their
// space. As the server's user, wherever it may: but the root, the home folder
// and the system's top folders are never deleted nor moved.

import { randomBytes } from 'node:crypto';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FS_MAX_ENTRIES,
  FS_MAX_TEXT_BYTES,
  type FsAnalysis,
  type FsConflict,
  type FsDetails,
  type FsEntry,
  type FsListing,
  type FsPlaces,
  type FsResult,
  type FsSaved,
  type FsText,
} from '../shared/file_manager.ts';
import { spaceOf } from './disks.ts';
import { HttpError } from './panels.ts';
import { contentVersion, errorMessage, packageShareDirectory, replaceFile } from './util.ts';

// The users' and groups' names change rarely: read again after this
const NAMES_TTL_MS = 60_000;
// A folder analyzed is read for this long at most, this many entries at most
const ANALYSIS_MS = 15_000;
const ANALYSIS_ENTRIES = 1_000_000;
// Folders read at once, and entries of one stat'ed at once
const ANALYSIS_FOLDERS = 16;
const STAT_BATCH = 256;
// Of the analysis's lists
const ANALYSIS_TOP = 10;
const ANALYSIS_TYPES = 12;
const ANALYSIS_CHILDREN = 50;
// Of an upload's folders, a folder dropped
const MAX_UPLOAD_DEPTH = 32;
// A binary file has a NUL in its first bytes
const BINARY_PROBE = 8000;
// .tar.gz, of the names numbered as a whole
const COMPOUND_EXTENSION = /\.tar\.(gz|bz2|xz|zst)$/i;

// Natural order: file2 before file10, case aside
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const REASONS: Record<string, [number, string]> = {
  ENOENT: [404, 'no such file or folder'],
  ENOTDIR: [400, 'not a folder'],
  EISDIR: [400, 'it is a folder'],
  EACCES: [403, 'permission denied'],
  EPERM: [403, 'not permitted'],
  EROFS: [403, 'read-only file system'],
  EEXIST: [409, 'it exists already'],
  ENOTEMPTY: [409, 'the folder is not empty'],
  EBUSY: [409, 'in use'],
  ETXTBSY: [409, 'in use'],
  ENOSPC: [507, 'no space left on the disk'],
  EDQUOT: [507, 'disk quota exceeded'],
  ENAMETOOLONG: [400, 'name too long'],
  ELOOP: [400, 'too many levels of links'],
  EINVAL: [400, 'invalid'],
};

// A failure of the file system, for the page: what failed, and why in words
export function fsError(e: unknown, what: string): HttpError {
  if (e instanceof HttpError) {
    return e;
  }
  const code = (e as NodeJS.ErrnoException).code ?? '';
  const [status, reason] = REASONS[code] ?? [500, errorMessage(e)];
  return new HttpError(status, `${what}: ${reason}`);
}

// A robot path (/…, ~/…, package://<package>/…): absolute, normalized, links
// not resolved
export function resolvePath(input: unknown, home = os.homedir()): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new HttpError(400, 'No path');
  }
  const trimmed = input.trim();
  const packaged = /^package:\/\/([^/]+)(\/.*)?$/.exec(trimmed);
  if (packaged) {
    const share = packageShareDirectory(packaged[1]);
    if (!share) {
      throw new HttpError(404, `No package "${packaged[1]}"`);
    }
    return path.resolve(share, `.${packaged[2] ?? ''}`);
  }
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new HttpError(400, `Not an absolute path: "${input}"`);
  }
  return path.resolve(expanded);
}

// The name of an entry, as typed: not empty, nor . or .., no separator
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name)) {
    throw new HttpError(400, `Not a valid name: ${JSON.stringify(name)}`);
  }
  if (Buffer.byteLength(name) > 255) {
    throw new HttpError(400, 'Name too long: 255 bytes at most');
  }
  return name;
}

// Never deleted nor moved, whatever the permissions: the root, the home
// folder, the system's top folders (/usr, /etc, /home)
function protectedPath(file: string, home: string): string | null {
  const root = path.parse(file).root;
  if (file === root || path.dirname(file) === root) {
    return 'a folder of the system';
  }
  return file === home ? 'the home folder' : null;
}

function under(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);
}

function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
}

// "map (2).yaml": numbered before its extension, "logs (2).tar.gz" before both
export function numberedName(name: string, n: number): string {
  const compound = COMPOUND_EXTENSION.exec(name);
  const dot = compound ? compound.index : name.lastIndexOf('.');
  const split = dot > 0 ? dot : name.length;
  const stem = name.slice(0, split).replace(/ \(\d+\)$/, '');
  return `${stem} (${n})${name.slice(split)}`;
}

// The first numbered name free in the folder
async function freeName(folder: string, name: string): Promise<string> {
  for (let n = 2; n < 10_000; n++) {
    const candidate = numberedName(name, n);
    if (!(await exists(path.join(folder, candidate)))) {
      return candidate;
    }
  }
  throw new HttpError(409, `No free name for ${name}`);
}

let accounts: { at: number; users: Map<number, string>; groups: Map<number, string> } | null = null;

async function accountNames(): Promise<NonNullable<typeof accounts>> {
  if (!accounts || Date.now() - accounts.at > NAMES_TTL_MS) {
    const read = async (file: string) => {
      const names = new Map<number, string>();
      for (const line of (await fs.readFile(file, 'utf8').catch(() => '')).split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id && /^\d+$/.test(id)) {
          names.set(Number(id), name);
        }
      }
      return names;
    };
    accounts = { at: Date.now(), users: await read('/etc/passwd'), groups: await read('/etc/group') };
  }
  return accounts;
}

// What the server's user may do with it, by its permission bits (ACLs aside)
function access(stat: Stats): { readable: boolean; writable: boolean } {
  const uid = process.getuid?.() ?? -1;
  if (uid === 0) {
    return { readable: true, writable: true };
  }
  const groups = new Set([process.getgid?.(), ...(process.getgroups?.() ?? [])]);
  const shift = stat.uid === uid ? 6 : groups.has(stat.gid) ? 3 : 0;
  const bits = (stat.mode >> shift) & 7;
  // Folders are gone into to read or change their entries
  const enter = !stat.isDirectory() || (bits & 1) !== 0;
  return { readable: (bits & 4) !== 0 && enter, writable: (bits & 2) !== 0 && enter };
}

async function readEntry(file: string, names: NonNullable<typeof accounts>): Promise<FsEntry | null> {
  const own = await fs.lstat(file).catch(() => null);
  if (!own) {
    return null;
  }
  let stat = own;
  let link: string | null = null;
  let broken = false;
  if (own.isSymbolicLink()) {
    link = await fs.readlink(file).catch(() => '');
    const target = await fs.stat(file).catch(() => null);
    broken = !target;
    stat = target ?? own;
  }
  const kind = broken ? 'other' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
  return {
    name: path.basename(file) || file,
    kind,
    link,
    size: stat.size,
    modified: Math.round(stat.mtimeMs),
    mode: stat.mode & 0o7777,
    owner: names.users.get(stat.uid) ?? String(stat.uid),
    group: names.groups.get(stat.gid) ?? String(stat.gid),
    ...access(stat),
    bag: kind === 'dir' && (await exists(path.join(file, 'metadata.yaml'))),
  };
}

function byKindAndName(a: { name: string; kind: string }, b: { name: string; kind: string }): number {
  return Number(b.kind === 'dir') - Number(a.kind === 'dir') || collator.compare(a.name, b.name);
}

// Of a folder: its entries (FS_MAX_ENTRIES at most), its permissions, the
// space left on its file system
export async function listFolder(folder: string): Promise<FsListing> {
  let found;
  try {
    found = await fs.readdir(folder, { withFileTypes: true });
  } catch (e) {
    throw fsError(e, `Cannot list ${folder}`);
  }
  // Those kept, if not all: folders first (links to folders are told only
  // once followed)
  const kindOf = (dirent: Dirent) => ({ name: dirent.name, kind: dirent.isDirectory() ? 'dir' : 'file' });
  found.sort((a, b) => byKindAndName(kindOf(a), kindOf(b)));
  const kept = found.slice(0, FS_MAX_ENTRIES);
  const names = await accountNames();
  const entries = (await Promise.all(kept.map((dirent) => readEntry(path.join(folder, dirent.name), names)))).filter(
    (entry) => entry !== null,
  );
  entries.sort(byKindAndName);
  const [stat, space] = await Promise.all([fs.stat(folder), spaceOf(folder)]);
  const truncated = found.length - kept.length;
  const { writable } = access(stat);
  // The space to three digits, as shown: a disk being written changes it a little all the time
  const version = contentVersion(
    JSON.stringify([entries, truncated, writable, space && Number(space.free.toPrecision(3))]),
  );
  const root = path.parse(folder).root;
  return { path: folder, parent: folder === root ? null : path.dirname(folder), entries, truncated, writable, version, space };
}

export async function entryDetails(file: string): Promise<FsDetails> {
  const entry = await readEntry(file, await accountNames());
  if (!entry) {
    throw new HttpError(404, `No such file or folder: ${file}`);
  }
  const stat = await fs.stat(file).catch(() => fs.lstat(file));
  const real = await fs.realpath(file).catch(() => null);
  let items: number | null = null;
  let hidden: number | null = null;
  if (entry.kind === 'dir') {
    const names = await fs.readdir(file).catch(() => null);
    if (names) {
      items = names.length;
      hidden = names.filter((name) => name.startsWith('.')).length;
    }
  }
  return {
    ...entry,
    path: file,
    realPath: real && real !== file ? real : null,
    created: stat.birthtimeMs > 0 ? Math.round(stat.birthtimeMs) : null,
    accessed: Math.round(stat.atimeMs),
    changed: Math.round(stat.ctimeMs),
    inode: stat.ino,
    links: stat.nlink,
    items,
    hidden,
    space: await spaceOf(entry.kind === 'dir' ? file : path.dirname(file)),
  };
}

// Where the file manager offers to go: home, and the ROS installations and
// workspaces sourced, overlays first
export function listPlaces(home = os.homedir(), prefixes = process.env.AMENT_PREFIX_PATH ?? ''): FsPlaces {
  const ros = new Map<string, string>();
  for (const prefix of prefixes.split(':').filter(Boolean)) {
    const distribution = /^\/opt\/ros\/([^/]+)/.exec(prefix);
    if (distribution) {
      ros.set(`/opt/ros/${distribution[1]}`, `ROS 2 ${distribution[1]}`);
      continue;
    }
    // A workspace's install folder (merged), or one of its packages' (isolated)
    const parts = prefix.split('/');
    const install = parts.lastIndexOf('install');
    const workspace = install > 0 ? parts.slice(0, install).join('/') || '/' : prefix;
    if (!ros.has(workspace)) {
      ros.set(workspace, path.basename(workspace) || workspace);
    }
  }
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // A user without a name: none shown
  }
  return { home, user, ros: [...ros].map(([folder, name]) => ({ name, path: folder })) };
}

export async function makeFolder(folder: string): Promise<FsResult> {
  checkName(path.basename(folder));
  try {
    await fs.mkdir(folder);
  } catch (e) {
    throw fsError(e, `Cannot make the folder ${path.basename(folder)}`);
  }
  return { paths: [folder], conflicts: [] };
}

export async function makeFile(file: string): Promise<FsResult> {
  checkName(path.basename(file));
  try {
    await fs.writeFile(file, '', { flag: 'wx' });
  } catch (e) {
    throw fsError(e, `Cannot make the file ${path.basename(file)}`);
  }
  return { paths: [file], conflicts: [] };
}

export async function renameEntry(file: string, name: string, home = os.homedir()): Promise<FsResult> {
  checkName(name);
  const reason = protectedPath(file, home);
  if (reason) {
    throw new HttpError(403, `Not renamed: ${file} is ${reason}`);
  }
  const target = path.join(path.dirname(file), name);
  if (target !== file) {
    if (await exists(target)) {
      throw new HttpError(409, `Not renamed: ${name} exists already`);
    }
    try {
      await fs.rename(file, target);
    } catch (e) {
      throw fsError(e, `Cannot rename ${path.basename(file)}`);
    }
  }
  return { paths: [target], conflicts: [] };
}

async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (e) {
    // To another file system: copied, then deleted
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw e;
    }
    await copyEntry(source, target);
    await fs.rm(source, { recursive: true });
  }
}

function copyEntry(source: string, target: string): Promise<void> {
  return fs.cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

// Moves or copies entries into a folder. Into their own folder, a move does
// nothing and a copy duplicates them. With conflict 'ask', nothing is done
// while any name is taken: the result says which.
export async function transfer(
  op: 'move' | 'copy',
  sources: string[],
  to: string,
  conflict: FsConflict,
  home = os.homedir(),
): Promise<FsResult> {
  const folder = await fs.stat(to).catch((e: unknown) => {
    throw fsError(e, `Cannot ${op} into ${to}`);
  });
  if (!folder.isDirectory()) {
    throw new HttpError(400, `Cannot ${op} into ${to}: not a folder`);
  }
  const realTo = await fs.realpath(to);
  const plan: { source: string; target: string; replace: boolean }[] = [];
  const conflicts: string[] = [];
  const names = new Set<string>();
  for (const source of sources) {
    const name = path.basename(source);
    if (names.has(name)) {
      throw new HttpError(400, `Two of them are named ${name}`);
    }
    names.add(name);
    const reason = op === 'move' ? protectedPath(source, home) : null;
    if (reason) {
      throw new HttpError(403, `Not moved: ${source} is ${reason}`);
    }
    const stat = await fs.lstat(source).catch((e: unknown) => {
      throw fsError(e, `Cannot ${op} ${name}`);
    });
    // The entry itself, its folder's links resolved
    const real = path.join(await fs.realpath(path.dirname(source)), name);
    if (stat.isDirectory() && under(realTo, real)) {
      throw new HttpError(400, `Cannot ${op} ${name} into itself`);
    }
    if (path.dirname(real) === realTo) {
      if (op === 'copy') {
        plan.push({ source, target: path.join(to, await freeName(to, name)), replace: false });
      }
      continue;
    }
    const target = path.join(to, name);
    if (!(await exists(target))) {
      plan.push({ source, target, replace: false });
    } else if (conflict === 'ask') {
      conflicts.push(name);
    } else if (conflict === 'keep-both') {
      plan.push({ source, target: path.join(to, await freeName(to, name)), replace: false });
    } else if (conflict === 'replace') {
      plan.push({ source, target, replace: true });
    }
  }
  if (conflicts.length > 0) {
    return { paths: [], conflicts };
  }
  const done: string[] = [];
  for (const { source, target, replace } of plan) {
    try {
      if (replace) {
        const reason = protectedPath(target, home);
        if (reason) {
          throw new HttpError(403, `${target} is ${reason}`);
        }
        await fs.rm(target, { recursive: true });
      }
      await (op === 'move' ? moveEntry(source, target) : copyEntry(source, target));
    } catch (e) {
      const so = done.length > 0 ? ` (${done.length} done before)` : '';
      throw fsError(e, `Cannot ${op} ${path.basename(source)}${so}`);
    }
    done.push(target);
  }
  return { paths: done, conflicts: [] };
}

export async function deleteEntries(files: string[], home = os.homedir()): Promise<FsResult> {
  for (const file of files) {
    const reason = protectedPath(file, home);
    if (reason) {
      throw new HttpError(403, `Not deleted: ${file} is ${reason}`);
    }
  }
  for (const file of files) {
    try {
      await fs.rm(file, { recursive: true });
    } catch (e) {
      // Deleted meanwhile, by another page
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw fsError(e, `Cannot delete ${path.basename(file)}`);
      }
    }
  }
  return { paths: [], conflicts: [] };
}

export async function changeMode(file: string, mode: unknown): Promise<FsResult> {
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new HttpError(400, 'A mode is an integer, 0 to 0o7777');
  }
  try {
    await fs.chmod(file, mode);
  } catch (e) {
    throw fsError(e, `Cannot change the permissions of ${path.basename(file)}`);
  }
  return { paths: [file], conflicts: [] };
}

// Size, time and inode: what tells a file changed without reading it
function stampOf(stat: Stats): string {
  return `${stat.size}-${stat.mtimeMs}-${stat.ino}`;
}

function decodeText(data: Buffer, file: string): string {
  if (data.subarray(0, BINARY_PROBE).includes(0)) {
    throw new HttpError(415, `${path.basename(file)} is not a text file`);
  }
  try {
    // A byte order mark kept, to be saved again
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new HttpError(415, `${path.basename(file)} is not UTF-8 text`);
  }
}

// A text file, to edit; null if its stamp is still known
export async function readText(file: string, known: string | null = null): Promise<FsText | null> {
  const stat = await fs.stat(file).catch((e: unknown) => {
    throw fsError(e, `Cannot read ${path.basename(file)}`);
  });
  if (stat.isDirectory()) {
    throw new HttpError(400, `${path.basename(file)} is a folder`);
  }
  if (!stat.isFile()) {
    throw new HttpError(415, `${path.basename(file)} is not a regular file`);
  }
  const stamp = stampOf(stat);
  if (stamp === known) {
    return null;
  }
  if (stat.size > FS_MAX_TEXT_BYTES) {
    throw new HttpError(413, `${path.basename(file)} is larger than ${FS_MAX_TEXT_BYTES / 1024 / 1024} MB: download it`);
  }
  const data = await fs.readFile(file).catch((e: unknown) => {
    throw fsError(e, `Cannot read ${path.basename(file)}`);
  });
  const text = decodeText(data, file);
  const real = await fs.realpath(file).catch(() => file);
  const readOnly = await fs.access(real, fs.constants.W_OK).then(
    () => null,
    (e: unknown) =>
      (e as NodeJS.ErrnoException).code === 'EROFS' ? 'On a read-only file system' : 'The server’s user cannot write it',
  );
  return { path: file, text, version: contentVersion(text), stamp, readOnly };
}

// Saves a text file, unless it changed since base (null: whatever it is), or
// as a new one (create)
export async function saveText(file: string, text: string, base: string | null, create: boolean): Promise<FsSaved> {
  if (Buffer.byteLength(text) > FS_MAX_TEXT_BYTES) {
    throw new HttpError(413, `Larger than ${FS_MAX_TEXT_BYTES / 1024 / 1024} MB`);
  }
  const name = path.basename(file);
  if (create) {
    checkName(name);
    try {
      await fs.writeFile(file, text, { flag: 'wx' });
    } catch (e) {
      throw fsError(e, `Cannot save ${name}`);
    }
  } else {
    const real = await fs.realpath(file).catch((e: unknown) => {
      throw fsError(e, `Cannot save ${name}`);
    });
    if (base !== null) {
      const current = await fs.readFile(real).catch((e: unknown) => {
        throw fsError(e, `Cannot save ${name}`);
      });
      const version = contentVersion(decodeText(current, file));
      if (version !== base) {
        return { version, stamp: stampOf(await fs.stat(real)), conflict: true };
      }
    }
    try {
      await replaceFile(real, text);
    } catch (e) {
      throw fsError(e, `Cannot save ${name}`);
    }
  }
  return { version: contentVersion(text), stamp: stampOf(await fs.stat(file)), conflict: false };
}

// Where an upload goes: its name in the folder, with the folders it is in
// (those of a folder dropped), which are made. null: skipped, it exists.
export async function uploadTarget(folder: string, name: string, conflict: FsConflict): Promise<string | null> {
  const parts = name.split('/');
  if (parts.length > MAX_UPLOAD_DEPTH) {
    throw new HttpError(400, `More than ${MAX_UPLOAD_DEPTH} folders deep: ${name}`);
  }
  parts.forEach(checkName);
  const parent = path.join(folder, ...parts.slice(0, -1));
  try {
    await fs.mkdir(parent, { recursive: true });
  } catch (e) {
    throw fsError(e, `Cannot upload ${name}`);
  }
  const last = parts.at(-1)!;
  const target = path.join(parent, last);
  if (!(await exists(target))) {
    return target;
  }
  switch (conflict) {
    case 'ask':
      throw new HttpError(409, `${last} exists already`);
    case 'skip':
      return null;
    case 'keep-both':
      return path.join(parent, await freeName(parent, last));
    case 'replace':
      return target;
  }
}

// Writes an upload: into a hidden file, renamed to the target once complete
export async function receiveFile(body: AsyncIterable<Buffer>, target: string, maxBytes: number): Promise<number> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(4).toString('hex')}.upload`);
  let size = 0;
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > maxBytes) {
          throw new HttpError(413, `Larger than ${Math.round(maxBytes / 1024 ** 3)} GB`);
        }
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } catch (e) {
    await fs.rm(temporary, { force: true });
    throw fsError(e, `Cannot upload ${path.basename(target)}`);
  }
  return size;
}

// The arguments of tar archiving, gzipped, entries of one folder
export function archiveArguments(files: string[]): string[] {
  const folder = path.dirname(files[0]);
  if (files.some((file) => path.dirname(file) !== folder || file === path.parse(file).root)) {
    throw new HttpError(400, 'Entries of one folder only are downloaded together');
  }
  // ./: names starting with - are not options
  return ['-czf', '-', '-C', folder, ...files.map((file) => `./${path.basename(file)}`)];
}

// Of the list, by key, the largest TOP kept
function keepTop<T>(list: T[], item: T, key: (item: T) => number, top = ANALYSIS_TOP): void {
  if (list.length >= top && key(item) <= key(list[list.length - 1])) {
    return;
  }
  let index = list.length;
  while (index > 0 && key(list[index - 1]) < key(item)) {
    index--;
  }
  list.splice(index, 0, item);
  list.length = Math.min(list.length, top);
}

// Everything under a folder, on its file system only, read for ANALYSIS_MS
// at most: sizes, counts, the largest and latest files, by extension, by entry
export async function analyzeFolder(
  root: string,
  limits = { ms: ANALYSIS_MS, entries: ANALYSIS_ENTRIES },
): Promise<FsAnalysis> {
  const started = Date.now();
  const rootStat = await fs.stat(root).catch((e: unknown) => {
    throw fsError(e, `Cannot analyze ${root}`);
  });
  if (!rootStat.isDirectory()) {
    throw new HttpError(400, `${root} is not a folder`);
  }
  await fs.access(root, fs.constants.R_OK | fs.constants.X_OK).catch((e: unknown) => {
    throw fsError(e, `Cannot analyze ${root}`);
  });
  const result: FsAnalysis = {
    path: root,
    size: 0,
    disk: 0,
    files: 0,
    folders: 0,
    links: 0,
    children: [],
    types: [],
    largest: [],
    recent: [],
    partial: null,
    unreadable: 0,
    mounts: 0,
    elapsedMs: 0,
  };
  const children = new Map<string, FsAnalysis['children'][number]>();
  const types = new Map<string, { files: number; size: number }>();
  let entries = 0;
  // Folders to read, and the root's entry they are in ('' the root)
  const queue: { folder: string; top: string }[] = [{ folder: root, top: '' }];

  const visit = async (folder: string, top: string) => {
    let names: string[];
    try {
      names = await fs.readdir(folder);
    } catch {
      result.unreadable++;
      return;
    }
    for (let start = 0; start < names.length; start += STAT_BATCH) {
      const batch = names.slice(start, start + STAT_BATCH);
      const stats = await Promise.all(batch.map((name) => fs.lstat(path.join(folder, name)).catch(() => null)));
      batch.forEach((name, index) => {
        const stat = stats[index];
        if (!stat) {
          return;
        }
        entries++;
        const file = path.join(folder, name);
        if (!top) {
          children.set(name, { name, kind: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other', size: 0, files: 0 });
        }
        const child = children.get(top || name)!;
        if (stat.isDirectory()) {
          if (stat.dev !== rootStat.dev) {
            result.mounts++;
            return;
          }
          result.folders++;
          result.disk += stat.blocks * 512;
          queue.push({ folder: file, top: top || name });
        } else if (stat.isSymbolicLink()) {
          result.links++;
        } else if (stat.isFile()) {
          result.files++;
          result.size += stat.size;
          result.disk += stat.blocks * 512;
          child.size += stat.size;
          child.files++;
          const type = path.extname(name).toLowerCase();
          const sum = types.get(type) ?? { files: 0, size: 0 };
          sum.files++;
          sum.size += stat.size;
          types.set(type, sum);
          const relative = path.relative(root, file);
          keepTop(result.largest, { path: relative, size: stat.size }, (item) => item.size);
          keepTop(result.recent, { path: relative, modified: Math.round(stat.mtimeMs) }, (item) => item.modified);
        }
      });
    }
  };

  await new Promise<void>((resolve) => {
    let active = 0;
    const pump = () => {
      if (queue.length > 0 && !result.partial) {
        if (entries >= limits.entries) {
          result.partial = `Stopped after ${limits.entries.toLocaleString('en')} entries`;
        } else if (Date.now() - started > limits.ms) {
          result.partial = `Stopped after ${Math.round(limits.ms / 1000)} s`;
        }
      }
      while (!result.partial && active < ANALYSIS_FOLDERS && queue.length > 0) {
        // The latest first: deep before wide, few folders waiting
        const { folder, top } = queue.pop()!;
        active++;
        void visit(folder, top).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && (queue.length === 0 || result.partial)) {
        resolve();
      }
    };
    pump();
  });

  result.children = [...children.values()].sort((a, b) => b.size - a.size || collator.compare(a.name, b.name)).slice(0, ANALYSIS_CHILDREN);
  result.types = [...types]
    .map(([type, sum]) => ({ type, ...sum }))
    .sort((a, b) => b.size - a.size)
    .slice(0, ANALYSIS_TYPES);
  result.elapsedMs = Date.now() - started;
  return result;
}
