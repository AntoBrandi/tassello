// The server's REST API (see src/server/http.ts)

import type { Panel, PanelSummary, TopicInfo } from '../shared/panel.ts';
import { DASHBOARD_CLIENT_HEADER, type PluginInfo } from '../shared/protocol.ts';
import { connection } from './connection.ts';

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
    throw new Error(message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const panelUrl = (id: string) => `/api/panels/${encodeURIComponent(id)}`;

export interface DirectoryListing {
  dir: string;
  parent: string | null;
  entries: { name: string; kind: 'dir' | 'image' }[];
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
  listFiles: (dir: string) => request<DirectoryListing>('GET', `/api/files/list?dir=${encodeURIComponent(dir)}`),
  // Resolves with the image's value for a widget: uploads/<name>
  uploadImage: async (file: Blob) => `uploads/${(await upload(file)).name}`,
};
