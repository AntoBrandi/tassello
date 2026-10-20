// The HTTP side of the server: the dashboard's page (the Vite build), the
// REST API of the panels, the files of the ROS packages, and the plugins'
// client files.
//
//   GET    /api/panels        [{id, name}]
//   POST   /api/panels        {name, widgets?}  -> the new panel, its id made from the name
//   GET    /api/panels/<id>   the panel
//   PUT    /api/panels/<id>   {name, widgets}   -> saves (or creates) the panel
//   DELETE /api/panels/<id>
//   GET    /api/topics        [{name, types}] of the ROS graph
//   GET    /api/packages/<package>/<path>  a file of the package's share
//          directory, as package://<package>/<path> names it: the meshes of
//          the robot description
//   GET    /api/files?path=<path>       an image of the robot (absolute or ~/ path)
//   GET    /api/files/list?dir=<dir>[&kind=behavior-tree]
//                                       its subdirectories and images (or XML files)
//   POST   /api/uploads                 an image or a behavior tree (the body) -> {name}
//   GET    /api/uploads/<name>          an uploaded file
//   GET    /api/plugins                 [PluginInfo] of the plugins loaded
//   GET    /plugins/<name>/<path>       a file of the plugin's client folder

import { createReadStream, promises as fs } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import type { TopicInfo } from '../shared/panel.ts';
import { DASHBOARD_CLIENT_HEADER } from '../shared/protocol.ts';
import { fileKind, isUploadName, listDirectory, MAX_UPLOAD_BYTES, resolveImagePath, saveUpload } from './files.ts';
import { HttpError, type PanelStore } from './panels.ts';
import type { PluginHost } from './plugins.ts';
import { errorMessage, packageShareDirectory, type Logger } from './util.ts';

export interface HttpServices {
  store: PanelStore;
  // The built page, null when not built (development: Vite serves it)
  wwwDir: string | null;
  topics: () => TopicInfo[];
  // Where uploaded images and behavior trees are kept
  uploadsDir: string;
  plugins: PluginHost;
  logger: Logger;
}

// By lowercase extension: meshes come as .STL as often as .stl
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.stl': 'model/stl',
  '.dae': 'model/vnd.collada+xml',
  '.obj': 'model/obj',
};
// Worth compressing: text, and meshes, often tens of MB of CAD exports
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.map', '.svg', '.stl', '.dae', '.obj']);
const MAX_BODY_BYTES = 1024 * 1024;
// Compressed files are kept, the most recent first, within this size
const GZIP_CACHE_BYTES = 64 * 1024 * 1024;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// For the images of the robot and of the users: an SVG opened by itself must
// not run scripts in the dashboard's origin
const SANDBOXED = { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };

export function createRequestHandler(services: HttpServices): RequestListener {
  return (req, res) => {
    handle(services, req, res).catch((e: unknown) => {
      // SyntaxError: a malformed JSON body, URIError: a malformed URL
      const status =
        e instanceof HttpError ? e.status : e instanceof SyntaxError || e instanceof URIError ? 400 : 500;
      if (status >= 500) {
        services.logger.error(`${req.method} ${req.url}: ${e instanceof Error ? e.stack : e}`);
      }
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, status, { error: errorMessage(e) });
      }
    });
  };
}

async function handle(services: HttpServices, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await api(services, req, res, pathname.split('/').slice(2).map(decodeURIComponent));
  } else if (pathname.startsWith('/plugins/')) {
    const [name, ...rest] = pathname.split('/').slice(2).map(decodeURIComponent);
    const dir = name ? services.plugins.clientDir(name) : null;
    if (!dir) {
      throw new HttpError(404, `No plugin "${name}" with a client`);
    }
    await serveFile(dir, rest.join('/'), req, res);
  } else if (!services.wwwDir) {
    throw new HttpError(404, 'The dashboard is not built: build the package, or use `npm run dev`');
  } else {
    await serveFile(services.wwwDir, pathname === '/' ? 'index.html' : decodeURIComponent(pathname), req, res);
  }
}

async function api(
  { store, topics, uploadsDir, plugins }: HttpServices,
  req: IncomingMessage,
  res: ServerResponse,
  route: string[],
): Promise<void> {
  const origin = req.headers[DASHBOARD_CLIENT_HEADER.toLowerCase()];
  const author = typeof origin === 'string' && origin ? origin : null;
  const [resource, id, ...rest] = route;
  const method = req.method ?? 'GET';

  if (resource === 'panels' && id === undefined) {
    if (method === 'GET') {
      return sendJson(res, 200, await store.list());
    }
    if (method === 'POST') {
      return sendJson(res, 201, await store.create(await readJson(req), author));
    }
  } else if (resource === 'panels' && id && rest.length === 0) {
    if (method === 'GET') {
      const panel = await store.get(id);
      if (!panel) {
        throw new HttpError(404, `No panel "${id}"`);
      }
      return sendJson(res, 200, panel);
    }
    if (method === 'PUT') {
      return sendJson(res, 200, await store.save(id, await readJson(req), author));
    }
    if (method === 'DELETE') {
      if (!(await store.remove(id, author))) {
        throw new HttpError(404, `No panel "${id}"`);
      }
      res.writeHead(204).end();
      return;
    }
  } else if (resource === 'plugins' && id === undefined && method === 'GET') {
    return sendJson(res, 200, plugins.info());
  } else if (resource === 'topics' && id === undefined && method === 'GET') {
    return sendJson(res, 200, topics());
  } else if (resource === 'packages' && id && rest.length > 0) {
    const share = PACKAGE_NAME.test(id) ? packageShareDirectory(id) : null;
    if (!share) {
      throw new HttpError(404, `No package "${id}"`);
    }
    return serveFile(share, rest.join('/'), req, res);
  } else if (resource === 'files' && method === 'GET') {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (id === undefined) {
      const file = resolveImagePath(query.get('path') ?? '');
      return serveFile(path.dirname(file), path.basename(file), req, res, SANDBOXED);
    }
    if (id === 'list' && rest.length === 0) {
      return sendJson(res, 200, await listDirectory(query.get('dir') ?? '', fileKind(query.get('kind'))));
    }
    throw new HttpError(404, `No API at ${req.url}`);
  } else if (resource === 'uploads' && id === undefined && method === 'POST') {
    return sendJson(res, 201, { name: await saveUpload(uploadsDir, await readBody(req, MAX_UPLOAD_BYTES)) });
  } else if (resource === 'uploads' && id && rest.length === 0 && method === 'GET') {
    if (!isUploadName(id)) {
      throw new HttpError(404, `No upload "${id}"`);
    }
    return serveFile(uploadsDir, id, req, res, SANDBOXED);
  } else {
    throw new HttpError(404, `No API at ${req.url}`);
  }
  throw new HttpError(405, `${method} not allowed on ${req.url}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new HttpError(413, `Request body larger than ${limit / 1024 / 1024} MB`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'));
}

const gzipAsync = promisify(gzip);
// By file path: the compressed content of the file at that size and time
const gzipCache = new Map<string, { version: string; data: Buffer }>();
let gzipCacheBytes = 0;

async function compressed(file: string, version: string): Promise<Buffer> {
  const cached = gzipCache.get(file);
  if (cached?.version === version) {
    // Most recent last, so evicted last
    gzipCache.delete(file);
    gzipCache.set(file, cached);
    return cached.data;
  }
  const data = await gzipAsync(await fs.readFile(file));
  if (cached) {
    gzipCache.delete(file);
    gzipCacheBytes -= cached.data.length;
  }
  gzipCache.set(file, { version, data });
  gzipCacheBytes += data.length;
  for (const [key, entry] of gzipCache) {
    if (gzipCacheBytes <= GZIP_CACHE_BYTES) {
      break;
    }
    gzipCache.delete(key);
    gzipCacheBytes -= entry.data.length;
  }
  return data;
}

// relative: within root, which it must not leave
async function serveFile(
  root: string,
  relative: string,
  req: IncomingMessage,
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, `${req.method} not allowed`);
  }
  const file = path.resolve(root, `./${relative}`);
  if (!file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    throw new HttpError(404, 'Not found');
  }
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    throw new HttpError(404, 'Not found');
  }
  const extension = path.extname(file).toLowerCase();
  const gzipped =
    COMPRESSIBLE.has(extension) && stat.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding']));
  const version = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
  // Revalidated on every load: the page's file names carry no hash (see
  // vite.config.ts), and meshes change when the description does
  const etag = `"${version}${gzipped ? '-gz' : ''}"`;
  const headers = {
    ...extraHeaders,
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  if (gzipped) {
    const data = await compressed(file, version);
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
