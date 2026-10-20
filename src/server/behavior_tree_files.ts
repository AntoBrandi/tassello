// The behavior trees' XML files, for the behavior tree editors: read for
// their pages, and again whenever they change (saved by a page, or edited on
// the robot), with the nodes they can use: Nav2's, those of their includes
// and of the libraries the pages name (TreeNodesModel). And saved, only over
// behavior trees, and only if unchanged since the page read them.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { readModels, type BtNodeModel, type ModelElement } from '../shared/bt_nodes.ts';
import type { BehaviorTreeFile, BehaviorTreeModels, BehaviorTreeSaved, BtNodeLibrary } from '../shared/protocol.ts';
import { parseXmlSource, sourceText, type SourceElement } from '../shared/xml.ts';
import { resolveTreeFile } from './behavior_tree_file.ts';
import { isBehaviorTreeXml } from './files.ts';
import { contentVersion, errorMessage, packageShareDirectory, replaceFile, type Logger } from './util.ts';

export type FileState = Omit<BehaviorTreeFile, 'type' | 'id'>;
export type ModelsState = Omit<BehaviorTreeModels, 'type' | 'id'>;

export interface BehaviorTreeFileWatcher {
  onFile: (file: FileState) => void;
  onModels: (models: ModelsState) => void;
}

// How often the files are checked for changes
const POLL_MS = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Includes of includes, at most
const MAX_INCLUDES = 50;
// A file of models kept parsed while unchanged; this many
const MODEL_CACHE = 64;

// Size, time and inode of a file, '' if gone
async function stamp(file: string): Promise<string> {
  const stat = await fs.stat(file).catch(() => null);
  return stat ? `${stat.size}-${stat.mtimeMs}-${stat.ino}` : '';
}

async function readText(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) {
    throw new Error(`${file} is not a file`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${file} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  return fs.readFile(file, 'utf8');
}

function modelElement(text: string, element: SourceElement): ModelElement {
  return {
    name: element.name,
    attributes: element.attributes,
    children: element.children.flatMap((child) => (child.type === 'element' ? [modelElement(text, child)] : [])),
    text: sourceText(text, element),
  };
}

// The includes of a tree's root, resolved: relative to its file, or to their
// ros_pkg's share directory
function includes(root: SourceElement, file: string, warnings: string[]): string[] {
  return root.children.flatMap((child) => {
    if (child.type !== 'element' || child.name !== 'include') {
      return [];
    }
    const { ros_pkg: rosPackage, path: relative = '' } = child.attributes;
    const share = rosPackage ? packageShareDirectory(rosPackage) : path.dirname(file);
    if (!share) {
      warnings.push(`Not included: ${relative}, of the package ${rosPackage}, not found`);
      return [];
    }
    return [path.resolve(share, relative)];
  });
}

interface ModelFile {
  models: BtNodeModel[];
  trees: string[];
  root: SourceElement;
}

const modelCache = new Map<string, { stamp: string; parsed: ModelFile }>();

// A file's models and BehaviorTrees, parsed again only when it changes
async function readModelFile(file: string): Promise<ModelFile> {
  const current = await stamp(file);
  const cached = modelCache.get(file);
  if (cached && cached.stamp === current) {
    return cached.parsed;
  }
  const text = await readText(file).catch((e: unknown) => {
    throw new Error(`Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? errorMessage(e)}`);
  });
  const root = parseXmlSource(text);
  if (root.name !== 'root') {
    throw new Error(`${file} is not of BT.CPP: its root element is <${root.name}>, not <root>`);
  }
  const parsed = {
    models: readModels(modelElement(text, root)),
    trees: root.children.flatMap((child) => (child.type === 'element' && child.name === 'BehaviorTree' && child.attributes.ID ? [child.attributes.ID] : [])),
    root,
  };
  modelCache.delete(file);
  modelCache.set(file, { stamp: current, parsed });
  if (modelCache.size > MODEL_CACHE) {
    modelCache.delete(modelCache.keys().next().value!);
  }
  return parsed;
}

// The models of Nav2's nodes, if installed
function nav2Models(): string | null {
  const share = packageShareDirectory('nav2_behavior_tree');
  return share && path.join(share, 'nav2_tree_nodes.xml');
}

// What a page edits: the file, read again when it changes, for all its pages
class WatchedFile {
  readonly file: string;
  private readonly readOnly: string | null;
  private readonly watchers = new Set<BehaviorTreeFileWatcher>();
  private state: FileState | null = null;
  private stamp: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;

  constructor(file: string, readOnly: string | null) {
    this.file = file;
    this.readOnly = readOnly;
  }

  get text(): string | null {
    return this.state?.text ?? null;
  }

  add(watcher: BehaviorTreeFileWatcher): void {
    this.watchers.add(watcher);
    if (this.state) {
      watcher.onFile(this.state);
    }
    this.timer ??= setInterval(() => void this.check(), POLL_MS);
    void this.check();
  }

  // false once it has no watcher left
  remove(watcher: BehaviorTreeFileWatcher): boolean {
    this.watchers.delete(watcher);
    if (this.watchers.size > 0) {
      return true;
    }
    this.stop();
    return false;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Reads it again if it changed: once at a time
  check(): Promise<void> {
    this.checking ??= this.read().finally(() => (this.checking = null));
    return this.checking;
  }

  // After a check started before it changed
  async refresh(): Promise<void> {
    await this.checking;
    await this.check();
  }

  private async read(): Promise<void> {
    const current = await stamp(this.file);
    if (current === this.stamp) {
      return;
    }
    this.stamp = current;
    let state: FileState;
    try {
      const text = await readText(this.file);
      let readOnly = this.readOnly;
      if (!readOnly) {
        readOnly = await fs.access(await fs.realpath(this.file), fs.constants.W_OK).then(
          () => null,
          () => 'The server’s user cannot write it: save it elsewhere',
        );
      }
      state = { file: this.file, text, version: contentVersion(text), readOnly, error: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT' ? `No file ${this.file}` : `Cannot read ${this.file}: ${code ?? errorMessage(e)}`;
      state = { file: this.file, text: null, version: null, readOnly: this.readOnly, error };
    }
    if (state.version !== this.state?.version || state.error !== this.state?.error || state.readOnly !== this.state?.readOnly) {
      this.state = state;
      for (const watcher of this.watchers) {
        watcher.onFile(state);
      }
    }
  }
}

// The models a page can use with its file and libraries: again whenever the
// file's includes, or any file read for them, change
class ModelsWatch {
  private readonly watched: WatchedFile;
  private readonly libraries: string[];
  private readonly uploadsDir: string;
  private readonly onModels: (models: ModelsState) => void;
  // The files read, and their stamps then
  private stamps = new Map<string, string>();
  private text: string | null | undefined = undefined;
  private sent = '';
  private timer: NodeJS.Timeout;
  private running = false;
  // Asked again while checking
  private again = false;
  private closed = false;

  constructor(watched: WatchedFile, libraries: string[], uploadsDir: string, onModels: (models: ModelsState) => void) {
    this.watched = watched;
    this.libraries = libraries;
    this.uploadsDir = uploadsDir;
    this.onModels = onModels;
    this.timer = setInterval(() => void this.check(), POLL_MS);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        let changed = this.watched.text !== this.text;
        for (const [file, known] of this.stamps) {
          changed ||= (await stamp(file)) !== known;
        }
        if (changed && !this.closed) {
          await this.read();
        }
      } while (this.again && !this.closed);
    } finally {
      this.running = false;
    }
  }

  private async read(): Promise<void> {
    this.text = this.watched.text;
    const stamps = new Map<string, string>();
    const libraries: BtNodeLibrary[] = [];
    // The first of each ID
    const trees = new Map<string, string>();
    const warnings: string[] = [];
    const load = async (file: string) => {
      stamps.set(file, await stamp(file));
      return readModelFile(file);
    };

    const nav2 = nav2Models();
    if (nav2) {
      try {
        libraries.push({ name: 'Nav2', file: nav2, models: (await load(nav2)).models });
      } catch {
        // Not readable: Nav2's nodes are known by name anyway
      }
    }
    if (this.text !== null) {
      // The includes, and theirs
      const queue: string[] = [];
      try {
        queue.push(...includes(parseXmlSource(this.text), this.watched.file, warnings));
      } catch {
        // Not XML, as the page will say
      }
      const seen = new Set([this.watched.file]);
      while (queue.length > 0 && seen.size <= MAX_INCLUDES) {
        const file = queue.shift()!;
        if (seen.has(file)) {
          continue;
        }
        seen.add(file);
        try {
          const included = await load(file);
          for (const id of included.trees) {
            if (!trees.has(id)) {
              trees.set(id, file);
            }
          }
          if (included.models.length > 0) {
            libraries.push({ name: path.basename(file), file, models: included.models });
          }
          queue.push(...includes(included.root, file, warnings));
        } catch (e) {
          warnings.push(`Not included: ${errorMessage(e)}`);
        }
      }
    }
    for (const source of this.libraries) {
      try {
        const file = resolveTreeFile(source, this.uploadsDir);
        const library = await load(file);
        if (library.models.length === 0) {
          warnings.push(`No node models (TreeNodesModel) in the library ${source}`);
        }
        libraries.push({ name: source.startsWith('uploads/') ? source : path.basename(file), file, models: library.models });
      } catch (e) {
        warnings.push(`Library ${source}: ${errorMessage(e)}`);
      }
    }
    if (this.closed) {
      return;
    }
    this.stamps = stamps;
    const models: ModelsState = { libraries, trees: [...trees].map(([id, file]) => ({ id, file })), warnings };
    const text = JSON.stringify(models);
    if (text !== this.sent) {
      this.sent = text;
      this.onModels(models);
    }
  }
}

export class BehaviorTreeFiles {
  private readonly uploadsDir: string;
  private readonly logger: Logger;
  // By file
  private readonly watched = new Map<string, WatchedFile>();

  constructor(uploadsDir: string, logger: Logger) {
    this.uploadsDir = uploadsDir;
    this.logger = logger;
  }

  // The file the page names, and the models it can use: returns what ends it
  watch(source: string, libraries: string[], watcher: BehaviorTreeFileWatcher): () => void {
    let file: string;
    try {
      file = resolveTreeFile(source, this.uploadsDir);
    } catch (e) {
      watcher.onFile({ file: '', text: null, version: null, readOnly: null, error: errorMessage(e) });
      watcher.onModels({ libraries: [], trees: [], warnings: [] });
      return () => {};
    }
    let watched = this.watched.get(file);
    if (!watched) {
      watched = new WatchedFile(file, source.trim().startsWith('uploads/') ? 'An upload: save it on the robot' : null);
      this.watched.set(file, watched);
    }
    const shared = watched;
    const models = new ModelsWatch(shared, libraries, this.uploadsDir, watcher.onModels);
    // Its includes may have changed with it
    const own: BehaviorTreeFileWatcher = {
      onFile: (state) => {
        watcher.onFile(state);
        void models.check();
      },
      onModels: watcher.onModels,
    };
    shared.add(own);
    void models.check();
    return () => {
      models.close();
      if (!shared.remove(own)) {
        this.watched.delete(file);
      }
    };
  }

  // Saves the file: over a behavior tree, unless it changed since base (null:
  // whatever it is), or a new one (create)
  async save(source: string, text: string, base: string | null, create: boolean): Promise<BehaviorTreeSaved> {
    if (source.trim().startsWith('uploads/')) {
      throw new Error('Uploads are not saved: save it on the robot');
    }
    const file = resolveTreeFile(source, this.uploadsDir);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      throw new Error(`Larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    const root = parseXmlSource(text);
    if (root.name !== 'root') {
      throw new Error(`Not a behavior tree: its root element is <${root.name}>, not <root>`);
    }
    if (create) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, { flag: 'wx' }).catch((e: unknown) => {
        throw new Error((e as NodeJS.ErrnoException).code === 'EEXIST' ? `${file} exists already` : errorMessage(e));
      });
    } else {
      const real = await fs.realpath(file).catch(() => {
        throw new Error(`No file ${file}`);
      });
      const current = await readText(real);
      if (!isBehaviorTreeXml(current)) {
        throw new Error(`${file} is not a behavior tree (its root element is not <root>): not overwritten`);
      }
      if (base !== null && contentVersion(current) !== base) {
        return { version: contentVersion(current), conflict: true };
      }
      await replaceFile(real, text);
    }
    this.logger.info(`Behavior tree saved: ${file}`);
    await this.watched.get(file)?.refresh();
    return { version: contentVersion(text), conflict: false };
  }

  stopAll(): void {
    for (const watched of this.watched.values()) {
      watched.stop();
    }
    this.watched.clear();
  }
}
