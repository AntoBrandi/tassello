// What the file manager makes of the robot's folders: paths, sizes, dates and
// permissions in words, the entries sorted and filtered, the rows of the list
// (a folder's entries, and those of the folders unfolded under them), what
// kind of file each is, and so what opening it does.

import type { FsEntry, FsListing } from '../../../shared/file_manager.ts';

// Paths are absolute, as the server gives them: /, /home/robot

export function joinPath(folder: string, name: string): string {
  return folder === '/' ? `/${name}` : `${folder}/${name}`;
}

export function parentOf(path: string): string | null {
  if (path === '/') {
    return null;
  }
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export function baseName(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

// The path itself, or one under it
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`);
}

// ~/maps for the home's
export function displayPath(path: string, home: string): string {
  return home && home !== '/' && isWithin(path, home) ? `~${path.slice(home.length)}` : path;
}

// The folders of the path, from the root (or home, or the folder it is
// confined to), each with its path
export function crumbs(path: string, home: string, root = '/'): { name: string; path: string }[] {
  let start = root;
  let name = root === '/' ? '/' : baseName(root);
  if (root === '/' && home && home !== '/' && isWithin(path, home)) {
    start = home;
    name = '~';
  }
  if (!isWithin(path, start)) {
    return [{ name: path, path }];
  }
  const list = [{ name, path: start }];
  let current = start;
  for (const part of path.slice(start.length).split('/').filter(Boolean)) {
    current = joinPath(current, part);
    list.push({ name: part, path: current });
  }
  return list;
}

// The path typed into the address bar, absolute: ~ and ~/ for home, relative
// to the folder shown otherwise
export function typedPath(typed: string, folder: string, home: string): string {
  const value = typed.trim();
  if (value.startsWith('package://')) {
    return value;
  }
  let path = value === '~' || value.startsWith('~/') ? home + value.slice(1) : value.startsWith('/') ? value : `${folder}/${value}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  path = `/${parts.join('/')}`;
  return path;
}

// 1,234 bytes, 4.2 MB, 123 MB, 1.5 GB: of 1000s, as GNOME's Files says them
export function formatSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  }
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 99.95 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

// Today its time, this year its day, else its date
export function formatDate(ms: number, now: number): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return TIME.format(date);
  }
  return (date.getFullYear() === today.getFullYear() ? DAY : DATE).format(date);
}

export function formatFullDate(ms: number): string {
  return FULL.format(new Date(ms));
}

// 3 minutes ago, 2 days ago
export function ago(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  const steps: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (value < size) {
      return value < 1 && unit === 'second' ? 'just now' : `${value} ${unit}${value === 1 ? '' : 's'} ago`;
    }
    value = Math.floor(value / size);
  }
  return '';
}

// drwxr-xr-x, as ls -l writes it
export function formatMode(mode: number, kind: FsEntry['kind'], link = false): string {
  const bits = ['r', 'w', 'x'];
  let text = link ? 'l' : kind === 'dir' ? 'd' : kind === 'file' ? '-' : '?';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 0; bit < 3; bit++) {
      let char = (mode >> (shift + 2 - bit)) & 1 ? bits[bit] : '-';
      // setuid, setgid and sticky, on the x of each
      const special = bit === 2 && (mode >> (9 + shift / 3)) & 1;
      if (special) {
        const mark = shift === 0 ? 't' : 's';
        char = char === 'x' ? mark : mark.toUpperCase();
      }
      text += char;
    }
  }
  return text;
}

export function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export type SortKey = 'name' | 'size' | 'modified';
export interface Sort {
  key: SortKey;
  descending: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

// Folders first, whatever the order; then by the key, then by name
export function sortEntries(entries: readonly FsEntry[], { key, descending }: Sort): FsEntry[] {
  const sign = descending ? -1 : 1;
  return [...entries].sort((a, b) => {
    const folders = Number(b.kind === 'dir') - Number(a.kind === 'dir');
    if (folders !== 0) {
      return folders;
    }
    let order = 0;
    if (key === 'size' && a.kind !== 'dir') {
      order = a.size - b.size;
    } else if (key === 'modified') {
      order = a.modified - b.modified;
    }
    return sign * (order || compareNames(a.name, b.name));
  });
}

export interface Filter {
  hidden: boolean;
  // Terms the names contain, any case
  text: string;
}

export function filterEntries(entries: readonly FsEntry[], { hidden, text }: Filter): FsEntry[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(
    (entry) =>
      (hidden || !isHidden(entry.name)) &&
      words.every((word) => entry.name.toLowerCase().includes(word)),
  );
}

// A row of the list: an entry, or what an unfolded folder says instead of
// its entries (reading, an error, empty)
export type Row =
  | { type: 'entry'; path: string; entry: FsEntry; depth: number; open: boolean | null }
  | { type: 'note'; path: string; depth: number; text: string; error: boolean };

// The folder's entries, and under each folder unfolded its own, as listed
// so far. The filter's text applies to the folder's own entries only.
export function buildRows(
  folder: string,
  listings: ReadonlyMap<string, FsListing>,
  errors: ReadonlyMap<string, string>,
  expanded: ReadonlySet<string>,
  sort: Sort,
  filter: Filter,
): Row[] {
  const rows: Row[] = [];
  const visit = (path: string, depth: number, seen: Set<string>) => {
    const listing = listings.get(path);
    if (!listing) {
      const error = errors.get(path);
      rows.push({ type: 'note', path: `${path}/…`, depth, text: error ?? 'Reading…', error: error !== undefined });
      return;
    }
    const entries = sortEntries(filterEntries(listing.entries, depth === 0 ? filter : { ...filter, text: '' }), sort);
    if (entries.length === 0 && depth > 0) {
      rows.push({ type: 'note', path: `${path}/…`, depth, text: 'Empty', error: false });
    }
    for (const entry of entries) {
      const child = joinPath(path, entry.name);
      // A link to a folder above unfolds once
      const open = entry.kind === 'dir' ? expanded.has(child) && !seen.has(child) : null;
      rows.push({ type: 'entry', path: child, entry, depth, open });
      if (open) {
        visit(child, depth + 1, new Set(seen).add(child));
      }
    }
  };
  visit(folder, 0, new Set([folder]));
  return rows;
}

// The paths of the entries' rows from one to the other, both included
export function rowRange(rows: readonly Row[], from: string, to: string): string[] {
  const paths = rows.flatMap((row) => (row.type === 'entry' ? [row.path] : []));
  const a = paths.indexOf(from);
  const b = paths.indexOf(to);
  if (a < 0 || b < 0) {
    return b < 0 ? [] : [to];
  }
  return paths.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// The first name "New folder", "New folder (2)"... not among the entries
export function freeName(entries: readonly FsEntry[], name: string): string {
  const taken = new Set(entries.map((entry) => entry.name));
  if (!taken.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const split = dot > 0 ? dot : name.length;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, split)} (${n})${name.slice(split)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

// What a file is, to show it and to open it
export type FileType = 'folder' | 'bag' | 'text' | 'image' | 'archive' | 'media' | 'program' | 'other';

const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown rst log csv tsv yaml yml json jsonc xml urdf xacro sdf srdf launch world rviz repos rosinstall ' +
    'py pyi pyx cpp cc cxx c h hpp hh hxx ipp tpp ino cu js mjs cjs ts tsx jsx html htm css scss ' +
    'sh bash zsh fish env ini cfg conf config toml properties service timer socket mount target path desktop rules ' +
    'msg srv action idl cmake mk make patch diff lua rs go java kt rb pl sql proto gitignore dockerignore editorconfig ' +
    'gitmodules gitattributes dae xsd xsl tex bib in am ac m4 pc lock'
  ).split(' '),
);
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'authors', 'changelog', 'colcon_ignore', 'ament_ignore', 'catkin_ignore', 'vagrantfile', 'gemfile', 'rakefile', 'procfile', 'cmakelists.txt']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'pgm', 'ppm', 'pnm']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'deb', 'whl']);
const MEDIA_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'pdf']);
const BAG_EXTENSIONS = new Set(['mcap', 'db3', 'bag']);

// Lower case, without its dot; '' if none (.bashrc has none)
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileType(entry: Pick<FsEntry, 'name' | 'kind' | 'bag' | 'mode'>): FileType {
  if (entry.kind === 'dir') {
    return entry.bag ? 'bag' : 'folder';
  }
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (BAG_EXTENSIONS.has(extension)) {
    return 'bag';
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return 'archive';
  }
  if (MEDIA_EXTENSIONS.has(extension)) {
    return 'media';
  }
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(entry.name.toLowerCase())) {
    return 'text';
  }
  // Without an extension: programs if executable (scripts too), else text,
  // as dot files are (.bashrc)
  if (entry.kind === 'file' && (!extension || extension === 'so')) {
    return entry.mode & 0o111 || extension === 'so' ? 'program' : 'text';
  }
  return 'other';
}

// Shown in the browser, PGM maps and all (the server converts them)
export function isViewable(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

// Of the type, in words: the details' kind
export function typeLabel(entry: Pick<FsEntry, 'name' | 'kind' | 'bag' | 'link' | 'mode'>): string {
  if (entry.kind === 'other') {
    return entry.link !== null ? 'Broken link' : 'Special file';
  }
  const label = {
    folder: 'Folder',
    bag: entry.kind === 'dir' ? 'Rosbag' : 'Rosbag file',
    text: 'Text',
    image: 'Image',
    archive: 'Archive',
    media: 'Media',
    program: 'Program',
    other: 'File',
  }[fileType(entry)];
  const extension = extensionOf(entry.name);
  return `${label}${entry.kind === 'file' && extension ? ` (${extension.toUpperCase()})` : ''}${entry.link !== null ? ', a link' : ''}`;
}

// The names among the folder's entries already
export function takenNames(entries: readonly FsEntry[] | undefined, names: readonly string[]): string[] {
  const taken = new Set((entries ?? []).map((entry) => entry.name));
  return names.filter((name) => taken.has(name));
}

// "a, b and 3 more"
export function listNames(names: readonly string[], shown = 3): string {
  if (names.length <= shown) {
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

// 1 file, 2,048 files
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function items(count: number): string {
  return counted(count, 'item');
}

// Of a disk's use, as the bars colour it
export function usageTone(used: number, total: number): 'ok' | 'warn' | 'full' {
  const share = total > 0 ? used / total : 0;
  return share >= 0.95 ? 'full' : share >= 0.85 ? 'warn' : 'ok';
}
