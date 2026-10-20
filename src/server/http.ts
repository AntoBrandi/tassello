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
//   /api/fs/...                         the file manager's: any file of the
//          robot (see src/shared/file_manager.ts), changed only by the
//          dashboard's pages
//     GET  places                       FsPlaces: home, the ROS workspaces
//     GET  list?path=&known=            FsListing, 204 while still the known version
//     GET  details?path=                FsDetails
//     GET  disks                        [FsDisk] of the robot's file systems
//     GET  analysis?path=               FsAnalysis: what takes a folder's space
//     GET  text?path=&stamp=            FsText, 204 while still of that stamp
//     PUT  text   {path, text, base, create}  -> FsSaved
//     POST op     FsOperation           -> FsResult
//     POST upload?path=&name=&conflict= the file (the body) -> FsResult
//     GET  download?path=[&path=...]    a file, or folders and files as a .tar.gz
//     GET  view?path=                   an image, PGM and PPM ones as PNG
//   GET    /plugins/<name>/<path>       a file of the plugin's client folder

import { spawn } from 'node:child_process';
import { createReadStream, promises as fs, type Stats } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import sharp from 'sharp';

import type { FsConflict, FsResult } from '../shared/file_manager.ts';
import type { TopicInfo } from '../shared/panel.ts';
import { DASHBOARD_CLIENT_HEADER } from '../shared/protocol.ts';
import { listDisks, spaceOf } from './disks.ts';
import {
  analyzeFolder,
  archiveArguments,
  changeMode,
  deleteEntries,
  entryDetails,
  fsError,
  listFolder,
  listPlaces,
  makeFile,
  makeFolder,
  readText,
  receiveFile,
  renameEntry,
  resolvePath,
  saveText,
  transfer,
  uploadTarget,
} from './file_manager.ts';
import {
  fileKind,
  IMAGE_EXTENSIONS,
  isUploadName,
  listDirectory,
  MAX_UPLOAD_BYTES,
  resolveImagePath,
  saveUpload,
} from './files.ts';
import { decodeNetpbm, NETPBM_EXTENSIONS } from './netpbm.ts';
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
// A text file saved by the file manager, 5 MB, as JSON
const MAX_TEXT_BODY_BYTES = 12 * 1024 * 1024;
// Of a file uploaded by the file manager: rosbags are large
const MAX_FS_UPLOAD_BYTES = 64 * 1024 ** 3;
// PGM and PPM images converted to PNG
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;
// Analyses at once: each reads a whole tree of folders
const MAX_ANALYSES = 2;
const CONFLICTS: FsConflict[] = ['ask', 'skip', 'keep-both', 'replace'];
// Compressed files are kept, the most recent first, within this size
const GZIP_CACHE_BYTES = 64 * 1024 * 1024;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// For the images of the robot and of the users: an SVG opened by itself must
// not run scripts in the dashboard's origin
const SANDBOXED = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

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
  { store, topics, uploadsDir, plugins, logger }: HttpServices,
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
  } else if (resource === 'fs' && id && rest.length === 0) {
    return fsApi(req, res, `${method} ${id}`, logger);
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

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return JSON.parse((await readBody(req, limit)).toString('utf8'));
}

let analyses = 0;

// The file manager's API (see file_manager.ts): route is the method and the
// action, "GET list"
async function fsApi(req: IncomingMessage, res: ServerResponse, route: string, logger: Logger): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  if (!route.startsWith('GET ') && typeof req.headers[DASHBOARD_CLIENT_HEADER.toLowerCase()] !== 'string') {
    // Another site's page cannot send the header: its browser would first
    // ask the server, which does not allow it
    throw new HttpError(403, 'The robot’s files are changed by the dashboard’s pages only');
  }
  switch (route) {
    case 'GET places':
      return sendJson(res, 200, listPlaces());
    case 'GET list': {
      const listing = await listFolder(resolvePath(query.get('path') ?? '~'));
      return listing.version === query.get('known') ? sendNothing(res) : sendJson(res, 200, listing);
    }
    case 'GET details':
      return sendJson(res, 200, await entryDetails(resolvePath(query.get('path'))));
    case 'GET disks':
      return sendJson(res, 200, await listDisks());
    case 'GET analysis': {
      if (analyses >= MAX_ANALYSES) {
        throw new HttpError(429, 'Other folders are being analyzed: try again in a moment');
      }
      analyses++;
      try {
        return sendJson(res, 200, await analyzeFolder(resolvePath(query.get('path'))));
      } finally {
        analyses--;
      }
    }
    case 'GET text': {
      const text = await readText(resolvePath(query.get('path')), query.get('stamp'));
      return text ? sendJson(res, 200, text) : sendNothing(res);
    }
    case 'PUT text': {
      const body = (await readJson(req, MAX_TEXT_BODY_BYTES)) as Record<string, unknown>;
      if (typeof body.text !== 'string') {
        throw new HttpError(400, 'text must be a string');
      }
      const file = resolvePath(body.path);
      const saved = await saveText(file, body.text, typeof body.base === 'string' ? body.base : null, body.create === true);
      if (!saved.conflict) {
        logger.info(`File saved: ${file}`);
      }
      return sendJson(res, 200, saved);
    }
    case 'POST op': {
      const result = await operate((await readJson(req)) as Record<string, unknown>, logger);
      return sendJson(res, 200, result);
    }
    case 'POST upload': {
      const folder = resolvePath(query.get('path'));
      const name = query.get('name') ?? '';
      const conflict = CONFLICTS.find((value) => value === query.get('conflict')) ?? 'ask';
      const length = Number(req.headers['content-length']);
      const space = Number.isFinite(length) ? await spaceOf(folder) : null;
      if (space && length > space.free) {
        throw new HttpError(507, `Not enough space on ${space.mount}: ${(space.free / 1e9).toFixed(1)} GB free`);
      }
      const target = await uploadTarget(folder, name, conflict);
      if (!target) {
        req.resume();
        return sendJson(res, 200, { paths: [], conflicts: [name] } satisfies FsResult);
      }
      const size = await receiveFile(req, target, MAX_FS_UPLOAD_BYTES);
      logger.info(`File uploaded: ${target} (${size} bytes)`);
      return sendJson(res, 201, { paths: [target], conflicts: [] } satisfies FsResult);
    }
    case 'GET download': {
      const files = query.getAll('path').map((value) => resolvePath(value));
      if (files.length === 0) {
        throw new HttpError(400, 'No path');
      }
      const stat =
        files.length === 1
          ? await fs.stat(files[0]).catch((e: unknown) => {
              throw fsError(e, `Cannot download ${path.basename(files[0])}`);
            })
          : null;
      return stat?.isFile() ? sendDownload(res, files[0], stat) : sendArchive(res, files, logger);
    }
    case 'GET view': {
      const file = resolvePath(query.get('path'));
      const extension = path.extname(file).toLowerCase();
      if (!NETPBM_EXTENSIONS.has(extension)) {
        if (!IMAGE_EXTENSIONS.has(extension) && extension !== '.ico') {
          throw new HttpError(415, `Not an image: ${path.basename(file)}`);
        }
        return serveFile(path.dirname(file), path.basename(file), req, res, SANDBOXED);
      }
      const stat = await fs.stat(file).catch((e: unknown) => {
        throw fsError(e, `Cannot read ${path.basename(file)}`);
      });
      if (stat.size > MAX_PREVIEW_BYTES) {
        throw new HttpError(413, `Too large to preview: ${path.basename(file)}`);
      }
      let pixels;
      try {
        pixels = decodeNetpbm(await fs.readFile(file));
      } catch (e) {
        throw e instanceof Error && !('code' in e) ? new HttpError(415, e.message) : fsError(e, `Cannot read ${path.basename(file)}`);
      }
      const { data, width, height, channels } = pixels;
      const png = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
      res.writeHead(200, {
        ...SANDBOXED,
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'no-cache',
      });
      res.end(png);
      return;
    }
  }
  throw new HttpError(404, `No API at ${req.url}`);
}

async function operate(body: Record<string, unknown>, logger: Logger): Promise<FsResult> {
  const paths = () => {
    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      throw new HttpError(400, 'paths must be a list of paths');
    }
    return body.paths.map((value) => resolvePath(value));
  };
  const log = (what: string, files: string[]) =>
    logger.info(`File manager: ${what} ${files.length === 1 ? files[0] : `${files.length} entries (${files[0]}, …)`}`);
  switch (body.op) {
    case 'mkdir':
      return makeFolder(resolvePath(body.path));
    case 'create':
      return makeFile(resolvePath(body.path));
    case 'rename': {
      const file = resolvePath(body.path);
      const result = await renameEntry(file, body.name as string);
      log(`renamed to ${body.name as string}:`, [file]);
      return result;
    }
    case 'move':
    case 'copy': {
      const sources = paths();
      const conflict = CONFLICTS.find((value) => value === body.conflict) ?? 'ask';
      const result = await transfer(body.op, sources, resolvePath(body.to), conflict);
      if (result.paths.length > 0) {
        log(`${body.op === 'move' ? 'moved' : 'copied'} into ${resolvePath(body.to)}:`, sources);
      }
      return result;
    }
    case 'delete': {
      const files = paths();
      const result = await deleteEntries(files);
      log('deleted', files);
      return result;
    }
    case 'chmod':
      return changeMode(resolvePath(body.path), body.mode);
    default:
      throw new HttpError(400, `Unknown operation ${JSON.stringify(body.op)}`);
  }
}

function sendNothing(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
}

// attachment; filename="…": an ASCII name for old browsers, the name whole
// for the others (RFC 6266)
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// A file of any size, streamed as it is
function sendDownload(res: ServerResponse, file: string, stat: Stats): void {
  res.writeHead(200, {
    ...SANDBOXED,
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': contentDisposition(path.basename(file)),
    'Cache-Control': 'no-store',
  });
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

// Entries of one folder, as tar archives them, gzipped, as it goes
async function sendArchive(res: ServerResponse, files: string[], logger: Logger): Promise<void> {
  const folder = path.dirname(files[0]);
  const name = files.length === 1 ? path.basename(files[0]) : `${path.basename(folder) || 'root'}-${files.length}-items`;
  const tar = spawn('tar', archiveArguments(files), { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    tar.once('spawn', resolve);
    tar.once('error', (e) => reject(new HttpError(500, `Cannot archive: tar ${(e as NodeJS.ErrnoException).code ?? errorMessage(e)}`)));
  });
  let errors = '';
  tar.stderr.on('data', (data: Buffer) => (errors = (errors + data.toString()).slice(-2000)));
  tar.on('close', (code) => {
    if (code !== 0 && errors.trim()) {
      logger.warn(`Download of ${files.length === 1 ? files[0] : folder}: ${errors.trim()}`);
    }
  });
  // The page gave up: so does tar
  res.on('close', () => tar.exitCode === null && tar.kill());
  res.writeHead(200, {
    ...SANDBOXED,
    'Content-Type': 'application/gzip',
    'Content-Disposition': contentDisposition(`${name}.tar.gz`),
    'Cache-Control': 'no-store',
  });
  tar.stdout.pipe(res);
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
