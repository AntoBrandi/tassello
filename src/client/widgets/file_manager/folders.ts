// What the file manager asks of the robot and of the browser: the folders
// shown, read again as they change; the files and folders dropped onto it;
// the clipboard; downloads.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FsListing } from '../../../shared/file_manager.ts';
import { ApiError, fsApi } from '../../api.ts';

// The folders shown and the files open are read again this often
export const POLL_MS = 3000;

// navigator.clipboard is for secure pages only (https, localhost), and the
// dashboard is mostly served over http
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) {
    throw new Error('the browser does not allow it');
  }
}

export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.click();
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The files dropped, those of the folders dropped with their folders in
// their names (maps/house.pgm). The entries are taken at once, while the
// drop's data is readable.
export function droppedFiles(transfer: DataTransfer): Promise<{ file: File; name: string }[]> {
  const entries = [...transfer.items].filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.() ?? null);
  const plain = [...transfer.files].map((file) => ({ file, name: file.name }));
  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return Promise.resolve(plain);
  }
  const found: { file: File; name: string }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      found.push({ file, name: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) {
          break;
        }
        for (const child of batch) {
          await walk(child, `${prefix}${entry.name}/`);
        }
      }
    }
  };
  return (async () => {
    for (const entry of entries) {
      await walk(entry!, '');
    }
    return found;
  })();
}

// The listings of the folders, read again every POLL_MS while the page is
// shown, and at once when asked (refresh). Unreachable, those known stay.
export function useListings(paths: readonly string[]) {
  const [listings, setListings] = useState<ReadonlyMap<string, FsListing>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [offline, setOffline] = useState(false);
  const [asked, setAsked] = useState(0);
  const versions = useRef(new Map<string, string>());
  const key = paths.join('\0');

  useEffect(() => {
    const wanted = key ? key.split('\0') : [];
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const without = <T,>(map: ReadonlyMap<string, T>, path: string) => {
      if (!map.has(path)) {
        return map;
      }
      const next = new Map(map);
      next.delete(path);
      return next;
    };
    const read = async (path: string) => {
      try {
        const listing = await fsApi.list(path, versions.current.get(path));
        if (stopped) {
          return;
        }
        setOffline(false);
        if (listing) {
          versions.current.set(path, listing.version);
          setListings((known) => new Map(known).set(path, listing));
        }
        setErrors((known) => without(known, path));
      } catch (e) {
        if (stopped) {
          return;
        }
        if (e instanceof ApiError) {
          versions.current.delete(path);
          setListings((known) => without(known, path));
          setErrors((known) => new Map(known).set(path, e.message));
        } else {
          setOffline(true);
        }
      }
    };
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        await Promise.all(wanted.map(read));
      }
      if (!stopped) {
        timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, asked]);

  const refresh = useCallback(() => setAsked((n) => n + 1), []);
  return { listings, errors, offline, refresh };
}
