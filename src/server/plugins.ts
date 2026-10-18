// The plugins: npm packages (or folders) whose package.json has a "tassello"
// field naming their parts, all optional:
//
//   "tassello": {
//     "client": "dist/client.js",     the page's side: an ES module whose default
//                                     export is definePlugin({ widgets }) of
//                                     tassello/sdk. Its folder is served at
//                                     /plugins/<name>/, for its chunks and assets.
//     "styles": ["dist/client.css"],  stylesheets of the page, in that folder
//     "server": "dist/server.js",     the server's side: an ES module whose default
//                                     export is a TasselloPlugin (api.ts)
//     "panels": "panels"              example panels, copied with the others into
//                                     a new panels directory
//   }
//
// They are found, in this order (the first of a name wins):
// - named on the command line (--plugin <folder or package>)
// - ROS packages registering a tassello_plugins resource in the ament index of
//   the sourced workspaces, whose content is the plugin's folder relative to
//   the package's prefix (share/<package> if empty)
// - npm packages named tassello-plugin-* or @<scope>/tassello-plugin-*,
//   installed next to Tassello (e.g. both global) or in the working
//   directory's node_modules

import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type rclnodejs from 'rclnodejs';

import type { PluginInfo } from '../shared/protocol.ts';
import type {
  CommandWidget,
  PluginContext,
  PluginSession,
  RequestHandler,
  StreamHandler,
  TasselloPlugin,
} from './api.ts';
import { errorMessage, type Logger } from './util.ts';

const MANIFEST_KEY = 'tassello';
const AMENT_RESOURCE = 'tassello_plugins';
const NPM_PREFIX = 'tassello-plugin-';

export interface PluginLocation {
  dir: string;
  // How it was found, for the logs
  source: string;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  dir: string;
  source: string;
  // The client module's folder, served, and the module and stylesheets in it
  clientDir: string | null;
  client: string | null;
  styles: string[];
  server: string | null;
  panelsDir: string | null;
  // Why its server side did not start, if it did not
  error: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(file: string): string {
  return file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
}

// The node_modules folders packages are looked for in: the working
// directory's and its parents', and the one Tassello is installed in
function nodeModulesFolders(tasselloRoot: string): string[] {
  const folders: string[] = [];
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    folders.push(path.join(dir, 'node_modules'));
    if (path.dirname(dir) === dir) {
      break;
    }
  }
  const parent = path.dirname(tasselloRoot);
  const installedIn = path.basename(parent).startsWith('@') ? path.dirname(parent) : parent;
  if (path.basename(installedIn) === 'node_modules') {
    folders.unshift(installedIn);
  }
  return [...new Set(folders)].filter((folder) => existsSync(folder));
}

// A --plugin argument: a folder, or the name of an installed package
function resolveArgument(argument: string, tasselloRoot: string): string {
  const expanded = expandHome(argument);
  if (/^[./~]/.test(argument) || existsSync(path.join(expanded, 'package.json'))) {
    return path.resolve(expanded);
  }
  for (const folder of nodeModulesFolders(tasselloRoot)) {
    const dir = path.join(folder, argument);
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  throw new Error(`Plugin "${argument}": no such folder, nor installed package`);
}

async function amentPlugins(): Promise<PluginLocation[]> {
  const locations: PluginLocation[] = [];
  for (const prefix of (process.env.AMENT_PREFIX_PATH ?? '').split(':').filter(Boolean)) {
    const index = path.join(prefix, 'share/ament_index/resource_index', AMENT_RESOURCE);
    const packages = await fs.readdir(index).catch(() => [] as string[]);
    for (const name of packages) {
      const content = (await fs.readFile(path.join(index, name), 'utf8')).trim();
      locations.push({
        dir: path.resolve(prefix, content || path.join('share', name)),
        source: `ROS package ${name}`,
      });
    }
  }
  return locations;
}

async function npmPlugins(tasselloRoot: string): Promise<PluginLocation[]> {
  const locations: PluginLocation[] = [];
  for (const folder of nodeModulesFolders(tasselloRoot)) {
    for (const entry of await fs.readdir(folder).catch(() => [] as string[])) {
      const names = entry.startsWith('@')
        ? (await fs.readdir(path.join(folder, entry)).catch(() => [] as string[])).map((n) => `${entry}/${n}`)
        : [entry];
      for (const name of names) {
        if (path.basename(name).startsWith(NPM_PREFIX)) {
          locations.push({ dir: path.join(folder, name), source: `npm package in ${folder}` });
        }
      }
    }
  }
  return locations;
}

// The plugins' folders, each once
export async function findPlugins(
  explicit: string[],
  discover: boolean,
  tasselloRoot: string,
): Promise<PluginLocation[]> {
  const found: PluginLocation[] = explicit.map((argument) => ({
    dir: resolveArgument(argument, tasselloRoot),
    source: 'command line',
  }));
  if (discover) {
    found.push(...(await amentPlugins()), ...(await npmPlugins(tasselloRoot)));
  }
  const seen = new Set<string>();
  const unique: PluginLocation[] = [];
  for (const location of found) {
    const real = await fs.realpath(location.dir).catch(() => location.dir);
    if (!seen.has(real)) {
      seen.add(real);
      unique.push(location);
    }
  }
  return unique;
}

// A file the manifest names: within the plugin's folder
function within(dir: string, file: unknown, field: string): string {
  if (typeof file !== 'string' || !file) {
    throw new Error(`"${MANIFEST_KEY}.${field}" must be a path`);
  }
  const resolved = path.resolve(dir, file);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error(`"${MANIFEST_KEY}.${field}" must be within the plugin's folder`);
  }
  return resolved;
}

export async function readPlugin(location: PluginLocation): Promise<Plugin> {
  const dir = path.resolve(location.dir);
  const file = path.join(dir, 'package.json');
  let pkg: unknown;
  try {
    pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${errorMessage(e)}`);
  }
  if (!isObject(pkg) || typeof pkg.name !== 'string' || !pkg.name) {
    throw new Error(`${file} has no name`);
  }
  const manifest = pkg[MANIFEST_KEY];
  if (!isObject(manifest)) {
    throw new Error(`${file} has no "${MANIFEST_KEY}" field: not a Tassello plugin`);
  }
  const plugin: Plugin = {
    name: pkg.name,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    dir,
    source: location.source,
    clientDir: null,
    client: null,
    styles: [],
    server: null,
    panelsDir: null,
    error: null,
  };
  try {
    if (manifest.client !== undefined) {
      const client = within(dir, manifest.client, 'client');
      const clientDir = path.dirname(client);
      plugin.clientDir = clientDir;
      plugin.client = path.basename(client);
      const styles = manifest.styles ?? [];
      if (!Array.isArray(styles)) {
        throw new Error(`"${MANIFEST_KEY}.styles" must be a list of paths`);
      }
      plugin.styles = styles.map((style: unknown, i) => {
        const file = within(dir, style, `styles[${i}]`);
        if (!file.startsWith(clientDir + path.sep)) {
          throw new Error(`"${MANIFEST_KEY}.styles[${i}]" must be in the client module's folder`);
        }
        return path.relative(clientDir, file);
      });
    } else if (manifest.styles !== undefined) {
      throw new Error(`"${MANIFEST_KEY}.styles" needs a client`);
    }
    if (manifest.server !== undefined) {
      plugin.server = within(dir, manifest.server, 'server');
    }
    if (manifest.panels !== undefined) {
      plugin.panelsDir = within(dir, manifest.panels, 'panels');
    }
  } catch (e) {
    throw new Error(`${pkg.name} (${dir}): ${errorMessage(e)}`);
  }
  return plugin;
}

// What the server side needs to activate the plugins
export interface PluginHostServices {
  node: rclnodejs.Node;
  rclnodejs: typeof rclnodejs;
  logger: Logger;
  commandWidget: (type: string, command: CommandWidget) => void;
}

function prefixed(logger: Logger, name: string): Logger {
  return {
    debug: (message) => logger.debug(`[${name}] ${message}`),
    info: (message) => logger.info(`[${name}] ${message}`),
    warn: (message) => logger.warn(`[${name}] ${message}`),
    error: (message) => logger.error(`[${name}] ${message}`),
  };
}

// The plugins loaded, and what their server sides registered
export class PluginHost {
  readonly plugins: Plugin[];
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly streams = new Map<string, StreamHandler>();
  private readonly shutdownCallbacks: (() => void | Promise<void>)[] = [];

  constructor(plugins: Plugin[]) {
    this.plugins = plugins;
  }

  // Loads their server sides, one after the other; one failing is reported
  // in its info, the others still start
  async activate(services: PluginHostServices): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.server) {
        continue;
      }
      const logger = prefixed(services.logger, plugin.name);
      const context: PluginContext = {
        name: plugin.name,
        dir: plugin.dir,
        node: services.node,
        rclnodejs: services.rclnodejs,
        logger,
        handle: (method, handler) => this.handlers.set(key(plugin.name, method), handler),
        stream: (name, handler) => this.streams.set(key(plugin.name, name), handler),
        commandWidget: (type, command) => services.commandWidget(type, command),
        onShutdown: (callback) => this.shutdownCallbacks.push(callback),
      };
      try {
        const module = (await import(pathToFileURL(plugin.server).href)) as { default?: unknown };
        const definition = (module.default ?? module) as Partial<TasselloPlugin>;
        if (typeof definition.activate !== 'function') {
          throw new Error('its server module exports no activate(context)');
        }
        await definition.activate(context);
      } catch (e) {
        plugin.error = errorMessage(e);
        services.logger.error(`Plugin ${plugin.name} did not start: ${plugin.error}`);
      }
    }
  }

  info(): PluginInfo[] {
    return this.plugins.map((plugin) => {
      const base = `/plugins/${encodeURIComponent(plugin.name)}/`;
      return {
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        client: plugin.client && base + plugin.client,
        styles: plugin.styles.map((style) => base + style.split(path.sep).map(encodeURIComponent).join('/')),
        error: plugin.error,
      };
    });
  }

  clientDir(name: string): string | null {
    return this.plugins.find((plugin) => plugin.name === name)?.clientDir ?? null;
  }

  async request(plugin: string, method: string, params: unknown, session: PluginSession): Promise<unknown> {
    const handler = this.handlers.get(key(plugin, method));
    if (!handler) {
      throw new Error(this.missing(plugin, `request "${method}"`));
    }
    return handler(params, session);
  }

  // Returns what closes the stream
  open(
    plugin: string,
    stream: string,
    params: unknown,
    emit: (data: unknown) => void,
    session: PluginSession,
  ): () => void {
    const handler = this.streams.get(key(plugin, stream));
    if (!handler) {
      throw new Error(this.missing(plugin, `stream "${stream}"`));
    }
    return handler(params, emit, session) ?? (() => {});
  }

  async shutdown(logger: Logger): Promise<void> {
    for (const callback of this.shutdownCallbacks) {
      try {
        await callback();
      } catch (e) {
        logger.warn(`A plugin's shutdown failed: ${errorMessage(e)}`);
      }
    }
  }

  private missing(plugin: string, what: string): string {
    const found = this.plugins.find((p) => p.name === plugin);
    if (!found) {
      return `No plugin "${plugin}" on the robot`;
    }
    return found.error ? `Plugin ${plugin} did not start: ${found.error}` : `Plugin ${plugin} has no ${what}`;
  }
}

function key(plugin: string, name: string): string {
  return `${plugin}\n${name}`;
}
