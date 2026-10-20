// The robot's files, as the file manager widgets see them: the REST API of
// /api/fs (see src/server/http.ts). The server acts as its user, anywhere that
// user can: see the README's Security.

// A folder's entry
export interface FsEntry {
  name: string;
  // Links followed: what they point to. 'other': sockets, pipes, devices and
  // broken links
  kind: 'dir' | 'file' | 'other';
  // Where a symbolic link points, as written; null if not a link
  link: string | null;
  // Bytes; a folder's own, not of what it holds
  size: number;
  // ms since the epoch
  modified: number;
  // Permission bits (0o7777)
  mode: number;
  // Names, or ids when unknown
  owner: string;
  group: string;
  // What the server's user may do, by the permissions: read it (go into a
  // folder), write it (a folder: add, rename and remove its entries)
  readable: boolean;
  writable: boolean;
  // A folder of a rosbag (with its metadata.yaml)
  bag: boolean;
}

// The file system a path is on
export interface FsSpace {
  // Its mount point
  mount: string;
  // Bytes: its size, and what the server's user may still fill
  total: number;
  free: number;
}

export interface FsListing {
  // Absolute, links not resolved
  path: string;
  // null at the root
  parent: string | null;
  // All of them, hidden ones too, folders first then by name
  entries: FsEntry[];
  // Entries left out: past FS_MAX_ENTRIES, a folder of that many is listed in
  // part
  truncated: number;
  writable: boolean;
  // Of the listing: sent back by the page polling it, which is answered 204
  // while it is the same
  version: string;
  space: FsSpace | null;
}

// Where the file manager offers to go
export interface FsPlaces {
  home: string;
  user: string;
  // The ROS installations and workspaces sourced (AMENT_PREFIX_PATH): Jazzy's
  // /opt/ros/jazzy, ~/ros2_ws
  ros: { name: string; path: string }[];
}

export interface FsDetails extends FsEntry {
  path: string;
  // Where it is, links resolved, if elsewhere
  realPath: string | null;
  // ms since the epoch; created is not known by every file system
  created: number | null;
  accessed: number;
  changed: number;
  inode: number;
  // Hard links
  links: number;
  // Of a folder: its entries, and how many of them are hidden
  items: number | null;
  hidden: number | null;
  space: FsSpace | null;
}

// A file system of the robot (a disk's partition, a USB stick, a network share)
export interface FsDisk extends FsSpace {
  // /dev/nvme0n1p2, server:/export
  device: string;
  // ext4, vfat, nfs4...
  type: string;
  readOnly: boolean;
  used: number;
  inodes: { total: number; free: number } | null;
}

// What takes a folder's space: everything under it, on its file system only
export interface FsAnalysis {
  path: string;
  // Bytes: of the files, and on the disk (blocks)
  size: number;
  disk: number;
  files: number;
  folders: number;
  // Symbolic links, not followed
  links: number;
  // Its entries, with all they hold, the largest first
  children: { name: string; kind: FsEntry['kind']; size: number; files: number }[];
  // Of the files, by extension ('' none), the largest first
  types: { type: string; files: number; size: number }[];
  // Anywhere under it, paths relative to it
  largest: { path: string; size: number }[];
  recent: { path: string; modified: number }[];
  // Why not all of it was read (too large, too long), null if it was
  partial: string | null;
  // Folders that could not be read, and those of other file systems, skipped
  unreadable: number;
  mounts: number;
  elapsedMs: number;
}

// A text file, for the editor
export interface FsText {
  path: string;
  text: string;
  // Of its content: what a save names as its base
  version: string;
  // Of its size, time and inode: what the page polls with, answered 204 while
  // it is the same
  stamp: string;
  // Why it cannot be saved, null if it can
  readOnly: string | null;
}

export interface FsSaved {
  // The file's: as saved, or (conflict) as found
  version: string;
  stamp: string;
  // Not saved: it changed since the base
  conflict: boolean;
}

// What to do with what is there already, where entries are moved, copied or
// uploaded: 'ask' does nothing, and tells which (FsResult.conflicts);
// 'keep-both' names the new ones "name (2).ext"
export type FsConflict = 'ask' | 'skip' | 'keep-both' | 'replace';

export type FsOperation =
  | { op: 'mkdir'; path: string }
  // An empty file
  | { op: 'create'; path: string }
  | { op: 'rename'; path: string; name: string }
  // Into the folder to; copying into their own folder duplicates them
  | { op: 'move' | 'copy'; paths: string[]; to: string; conflict: FsConflict }
  | { op: 'delete'; paths: string[] }
  | { op: 'chmod'; path: string; mode: number };

export interface FsResult {
  // What was made: the new paths
  paths: string[];
  // The names in the way, of a move or copy that asked: nothing was done
  conflicts: string[];
}

// Of a folder's entries, at most, listed
export const FS_MAX_ENTRIES = 5000;
// Of the files edited as text
export const FS_MAX_TEXT_BYTES = 5 * 1024 * 1024;
