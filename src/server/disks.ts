// The robot's file systems, for the file manager: the mounts of
// /proc/self/mountinfo that hold files (not proc, sysfs, cgroups, snaps...),
// with their size and free space, and the one a path is on.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { FsDisk, FsSpace } from '../shared/file_manager.ts';

export interface Mount {
  // Its device's major:minor: bind mounts share it
  device: string;
  mount: string;
  // /dev/nvme0n1p2, tmpfs, server:/export
  source: string;
  type: string;
  readOnly: boolean;
}

// File systems that hold no files of the robot's
const PSEUDO = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'fuse.gvfsd-fuse',
  'fuse.portal',
  'fuse.snapfuse',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tracefs',
]);
// Mounts of the system's own, below these
const HIDDEN_UNDER = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/snap', '/var/lib/docker', '/boot/efi'];
// statfs of a network share that went away hangs: given up after this
const STATFS_TIMEOUT_MS = 2000;
// The mount table changes rarely: read again after this
const MOUNTS_TTL_MS = 10_000;

// \040 for a space, as the kernel escapes them
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

// The lines of /proc/self/mountinfo:
//   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
export function parseMountInfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');
    const separator = fields.indexOf('-', 6);
    if (fields.length < 10 || separator < 0 || separator + 2 >= fields.length) {
      continue;
    }
    mounts.push({
      device: fields[2],
      mount: unescape(fields[4]),
      source: unescape(fields[separator + 2]),
      type: fields[separator + 1],
      readOnly: fields[5].split(',').includes('ro'),
    });
  }
  return mounts;
}

function under(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

// The mounts worth showing: not pseudo file systems, nor the system's own
// (/run, /snap), nor RAM (but /tmp), each device once, at its shortest mount
// point (others are bind mounts of it)
export function storageMounts(mounts: Mount[]): Mount[] {
  const kept = new Map<string, Mount>();
  for (const mount of mounts) {
    const media = under(mount.mount, '/run/media') || under(mount.mount, '/media');
    if (
      PSEUDO.has(mount.type) ||
      (mount.type === 'tmpfs' && mount.mount !== '/tmp') ||
      // A container's root
      (mount.type === 'overlay' && mount.mount !== '/') ||
      (!media && HIDDEN_UNDER.some((folder) => under(mount.mount, folder)))
    ) {
      continue;
    }
    const known = kept.get(mount.device);
    if (!known || mount.mount.length < known.mount.length) {
      kept.set(mount.device, mount);
    }
  }
  return [...kept.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

// The mount a path is on, of those given: the deepest that holds it
export function mountOf(file: string, mounts: Mount[]): Mount | null {
  let found: Mount | null = null;
  for (const mount of mounts) {
    if (under(file, mount.mount) && (!found || mount.mount.length >= found.mount.length)) {
      found = mount;
    }
  }
  return found;
}

let cached: { at: number; mounts: Promise<Mount[]> } | null = null;

export function readMounts(): Promise<Mount[]> {
  if (!cached || Date.now() - cached.at > MOUNTS_TTL_MS) {
    cached = {
      at: Date.now(),
      mounts: fs.readFile('/proc/self/mountinfo', 'utf8').then(parseMountInfo, () => []),
    };
  }
  return cached.mounts;
}

async function statfs(folder: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), STATFS_TIMEOUT_MS)));
  try {
    return await Promise.race([fs.statfs(folder).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Of the file system a folder is on; null if not known
export async function spaceOf(folder: string): Promise<FsSpace | null> {
  const [stats, mounts] = await Promise.all([statfs(folder), readMounts()]);
  if (!stats) {
    return null;
  }
  const real = await fs.realpath(folder).catch(() => folder);
  return {
    mount: mountOf(real, mounts)?.mount ?? path.parse(real).root,
    total: stats.blocks * stats.bsize,
    free: stats.bavail * stats.bsize,
  };
}

// The robot's file systems, by mount point
export async function listDisks(): Promise<FsDisk[]> {
  const mounts = storageMounts(await readMounts());
  const disks = await Promise.all(
    mounts.map(async (mount): Promise<FsDisk | null> => {
      const stats = await statfs(mount.mount);
      if (!stats || stats.blocks === 0) {
        return null;
      }
      return {
        mount: mount.mount,
        device: mount.source,
        type: mount.type,
        readOnly: mount.readOnly,
        total: stats.blocks * stats.bsize,
        used: (stats.blocks - stats.bfree) * stats.bsize,
        free: stats.bavail * stats.bsize,
        inodes: stats.files > 0 ? { total: stats.files, free: stats.ffree } : null,
      };
    }),
  );
  return disks.filter((disk) => disk !== null);
}
