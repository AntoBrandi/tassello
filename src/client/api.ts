// The server's REST API (see src/server/http.ts)

import type {
  FsAnalysis,
  FsConflict,
  FsDetails,
  FsDisk,
  FsListing,
  FsOperation,
  FsPlaces,
  FsResult,
  FsSaved,
  FsText,
} from '../shared/file_manager.ts';
import type { Panel, PanelSummary, TopicInfo } from '../shared/panel.ts';
import { DASHBOARD_CLIENT_HEADER, type PluginInfo } from '../shared/protocol.ts';
import { connection } from './connection.ts';

// An error the server answered with: its HTTP status, and what it says.
// Unreachable, fetch's TypeError instead.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // So that the server's change notification can name us as the author
      [DASHBOARD_CLIENT_HEADER]: connection.clientId ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Not our JSON error, e.g. the server is down behind Vite's proxy
    }
    throw new ApiError(response.status, message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const panelUrl = (id: string) => `/api/panels/${encodeURIComponent(id)}`;

// The robot's files a page browses for (see src/server/files.ts): images,
// behavior trees (XML), rosbags (their folders or files), or folders only
export type FileKind = 'image' | 'behavior-tree' | 'bag' | 'folder';

export interface DirectoryListing {
  dir: string;
  parent: string | null;
  entries: { name: string; kind: 'dir' | FileKind }[];
}

async function upload(file: Blob): Promise<{ name: string }> {
  const response = await fetch('/api/uploads', { method: 'POST', body: file });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as { name: string };
}

// The URL of an image the widgets name: a robot path (/..., ~/...), a
// package's file (package://<package>/<path>), or an upload (uploads/<name>);
// null if none of them
export function imageUrl(image: string): string | null {
  const value = image.trim();
  if (value.startsWith('uploads/')) {
    return `/api/uploads/${encodeURIComponent(value.slice('uploads/'.length))}`;
  }
  const packaged = /^package:\/\/([^/]+)\/(.+)$/.exec(value);
  if (packaged) {
    return `/api/packages/${encodeURIComponent(packaged[1])}/${packaged[2].split('/').map(encodeURIComponent).join('/')}`;
  }
  if (value.startsWith('/') || value.startsWith('~/')) {
    return `/api/files?path=${encodeURIComponent(value)}`;
  }
  return null;
}

export const api = {
  listPanels: () => request<PanelSummary[]>('GET', '/api/panels'),
  getPanel: (id: string) => request<Panel>('GET', panelUrl(id)),
  createPanel: (panel: Omit<Panel, 'id'>) => request<Panel>('POST', '/api/panels', panel),
  savePanel: (panel: Panel) => request<Panel>('PUT', panelUrl(panel.id), panel),
  deletePanel: (id: string) => request<void>('DELETE', panelUrl(id)),
  listTopics: () => request<TopicInfo[]>('GET', '/api/topics'),
  listPlugins: () => request<PluginInfo[]>('GET', '/api/plugins'),
  listFiles: (dir: string, kind: FileKind = 'image') =>
    request<DirectoryListing>('GET', `/api/files/list?dir=${encodeURIComponent(dir)}&kind=${kind}`),
  // An image or a behavior tree; resolves with its value for a widget: uploads/<name>
  uploadFile: async (file: Blob) => `uploads/${(await upload(file)).name}`,
};

// /api/fs/<action>?…, a parameter repeated for each of a list's values
function fsUrl(action: string, parameters: Record<string, string | string[] | null | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    for (const item of value === null || value === undefined ? [] : [value].flat()) {
      query.append(key, item);
    }
  }
  const text = query.toString();
  return `/api/fs/${action}${text ? `?${text}` : ''}`;
}

export interface Upload {
  // The server's result: the file's path, or (skipped) its name in conflicts
  result: Promise<FsResult>;
  abort: () => void;
}

// The file manager's API (see src/shared/file_manager.ts): any file of the
// robot. Polled reads resolve with undefined while what they know is current.
export const fsApi = {
  places: () => request<FsPlaces>('GET', fsUrl('places')),
  list: (path: string, known?: string) => request<FsListing | undefined>('GET', fsUrl('list', { path, known })),
  details: (path: string) => request<FsDetails>('GET', fsUrl('details', { path })),
  disks: () => request<FsDisk[]>('GET', fsUrl('disks')),
  analyze: (path: string) => request<FsAnalysis>('GET', fsUrl('analysis', { path })),
  readText: (path: string, stamp?: string) => request<FsText | undefined>('GET', fsUrl('text', { path, stamp })),
  saveText: (path: string, text: string, base: string | null, create = false) =>
    request<FsSaved>('PUT', fsUrl('text'), { path, text, base, create }),
  operate: (operation: FsOperation) => request<FsResult>('POST', fsUrl('op'), operation),
  // A file as it is; folders, or several entries of a folder, as a .tar.gz
  downloadUrl: (paths: string[]) => fsUrl('download', { path: paths }),
  // An image, to show; stamp: of the version wanted, for the browser's cache
  viewUrl: (path: string, stamp?: string) => fsUrl('view', { path, v: stamp }),
  // A file into the folder, as name: within folders of its own (sub/name),
  // made as needed. With its progress, in bytes sent.
  upload(folder: string, name: string, file: Blob, conflict: FsConflict, onProgress: (sent: number) => void): Upload {
    const xhr = new XMLHttpRequest();
    const result = new Promise<FsResult>((resolve, reject) => {
      xhr.open('POST', fsUrl('upload', { path: folder, name, conflict }));
      xhr.setRequestHeader(DASHBOARD_CLIENT_HEADER, connection.clientId ?? '');
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () => {
        let body: (FsResult & { error?: string }) | null = null;
        try {
          body = JSON.parse(xhr.responseText) as FsResult & { error?: string };
        } catch {
          // Not our JSON: an error page of a proxy
        }
        if (xhr.status >= 200 && xhr.status < 300 && body) {
          resolve(body);
        } else {
          reject(new Error(body?.error ?? `${xhr.status} ${xhr.statusText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Cannot reach the robot'));
      xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
      xhr.send(file);
    });
    return { result, abort: () => xhr.abort() };
  },
};
