// The panels, one JSON file each in the panels directory, named after the
// panel's id. The files hold the name, the widgets and the status bar's: the
// id is the file name, so a panel can be copied between machines by copying
// its file.

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PANEL_ID_PATTERN,
  SMALL_DEVICES,
  slugify,
  STATUS_COLUMNS,
  WIDGET_ID_PATTERN,
  type DeviceLayout,
  type Panel,
  type PanelSummary,
  type StatusWidgetInstance,
  type WidgetInstance,
} from '../shared/panel.ts';
import type { Logger } from './util.ts';

// An error the HTTP API reports to the client with its status
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_WIDGETS = 200;
// Generous bounds that keep a malformed panel from blowing up the page
const MAX_POSITION = 1000;
const MAX_SIZE = 100;
const MAX_STATUS_WIDGETS = 50;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gridNumber(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${what} must be an integer between ${min} and ${max}`);
  }
  return value;
}

// Checks a panel received from a client (or read from disk) and returns it
// with only the fields the dashboard knows.
export function sanitizePanel(value: unknown, id: string): Panel {
  if (!isObject(value)) {
    throw new HttpError(400, 'A panel must be a JSON object');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 100) {
    throw new HttpError(400, 'The panel name must be 1 to 100 characters long');
  }
  const widgets = value.widgets ?? [];
  if (!Array.isArray(widgets) || widgets.length > MAX_WIDGETS) {
    throw new HttpError(400, `widgets must be an array of at most ${MAX_WIDGETS} widgets`);
  }
  const ids = new Set<string>();
  const sanitized: Panel = {
    id,
    name,
    widgets: widgets.map((widget: unknown, index): WidgetInstance => {
      const where = `widgets[${index}]`;
      if (!isObject(widget)) {
        throw new HttpError(400, `${where} must be an object`);
      }
      if (typeof widget.id !== 'string' || !WIDGET_ID_PATTERN.test(widget.id)) {
        throw new HttpError(400, `${where}.id must match ${WIDGET_ID_PATTERN}`);
      }
      if (ids.has(widget.id)) {
        throw new HttpError(400, `${where}.id "${widget.id}" is not unique`);
      }
      ids.add(widget.id);
      if (typeof widget.type !== 'string' || !widget.type) {
        throw new HttpError(400, `${where}.type must be a non-empty string`);
      }
      if (widget.config !== undefined && !isObject(widget.config)) {
        throw new HttpError(400, `${where}.config must be an object`);
      }
      return {
        id: widget.id,
        type: widget.type,
        title: typeof widget.title === 'string' ? widget.title : '',
        x: gridNumber(widget.x, `${where}.x`, 0, MAX_POSITION),
        y: gridNumber(widget.y, `${where}.y`, 0, MAX_POSITION),
        w: gridNumber(widget.w, `${where}.w`, 1, MAX_SIZE),
        h: gridNumber(widget.h, `${where}.h`, 1, MAX_SIZE),
        config: (widget.config as Record<string, unknown> | undefined) ?? {},
      };
    }),
  };
  const layouts = sanitizeLayouts(value.layouts, ids);
  if (layouts) {
    sanitized.layouts = layouts;
  }
  const statusBar = sanitizeStatusBar(value.statusBar);
  if (statusBar.length > 0) {
    sanitized.statusBar = statusBar;
  }
  return sanitized;
}

// The devices' own layouts; what names a widget the panel does not have is
// dropped, as removing a widget leaves its places behind
function sanitizeLayouts(value: unknown, ids: Set<string>): Panel['layouts'] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new HttpError(400, 'layouts must be an object');
  }
  const layouts: NonNullable<Panel['layouts']> = {};
  for (const device of SMALL_DEVICES) {
    const layout = value[device];
    if (layout === undefined || layout === null) {
      continue;
    }
    if (!isObject(layout) || !isObject(layout.rects ?? {}) || !Array.isArray(layout.hidden ?? [])) {
      throw new HttpError(400, `layouts.${device} must be {rects: {}, hidden: []}`);
    }
    const sanitized: DeviceLayout = { rects: {}, hidden: [] };
    for (const [id, rect] of Object.entries((layout.rects ?? {}) as Record<string, unknown>)) {
      if (!ids.has(id)) {
        continue;
      }
      const where = `layouts.${device}.rects.${id}`;
      if (!isObject(rect)) {
        throw new HttpError(400, `${where} must be an object`);
      }
      sanitized.rects[id] = {
        x: gridNumber(rect.x, `${where}.x`, 0, MAX_POSITION),
        y: gridNumber(rect.y, `${where}.y`, 0, MAX_POSITION),
        w: gridNumber(rect.w, `${where}.w`, 1, MAX_SIZE),
        h: gridNumber(rect.h, `${where}.h`, 1, MAX_SIZE),
      };
    }
    sanitized.hidden = [...new Set((layout.hidden as unknown[]).filter((id): id is string => typeof id === 'string' && ids.has(id)))];
    layouts[device] = sanitized;
  }
  return Object.keys(layouts).length > 0 ? layouts : undefined;
}

// The status bar's widgets. One without a place (x) goes after the one before
// it, e.g. in a file written by hand.
function sanitizeStatusBar(value: unknown): StatusWidgetInstance[] {
  const widgets = value ?? [];
  if (!Array.isArray(widgets) || widgets.length > MAX_STATUS_WIDGETS) {
    throw new HttpError(400, `statusBar must be an array of at most ${MAX_STATUS_WIDGETS} status widgets`);
  }
  const ids = new Set<string>();
  let next = 0;
  return widgets.map((widget: unknown, index): StatusWidgetInstance => {
    const where = `statusBar[${index}]`;
    if (!isObject(widget)) {
      throw new HttpError(400, `${where} must be an object`);
    }
    if (typeof widget.id !== 'string' || !WIDGET_ID_PATTERN.test(widget.id)) {
      throw new HttpError(400, `${where}.id must match ${WIDGET_ID_PATTERN}`);
    }
    if (ids.has(widget.id)) {
      throw new HttpError(400, `${where}.id "${widget.id}" is not unique`);
    }
    ids.add(widget.id);
    if (typeof widget.type !== 'string' || !widget.type) {
      throw new HttpError(400, `${where}.type must be a non-empty string`);
    }
    if (widget.config !== undefined && !isObject(widget.config)) {
      throw new HttpError(400, `${where}.config must be an object`);
    }
    const w = gridNumber(widget.w, `${where}.w`, 1, STATUS_COLUMNS);
    const x =
      widget.x === undefined ? Math.min(next, STATUS_COLUMNS - w) : gridNumber(widget.x, `${where}.x`, 0, STATUS_COLUMNS - 1);
    next = x + w;
    return {
      id: widget.id,
      type: widget.type,
      x,
      w,
      config: (widget.config as Record<string, unknown> | undefined) ?? {},
    };
  });
}

interface PanelEvents {
  // origin: the clientId of the change's author, null if unknown
  changed: [id: string, deleted: boolean, origin: string | null];
}

export class PanelStore extends EventEmitter<PanelEvents> {
  readonly dir: string;
  private readonly examplesDirs: string[];
  private readonly logger: Logger;
  // Numbers the temporary files, so that concurrent saves never share one
  private writes = 0;

  // examplesDirs: panels copied into dir when it is first created; a panel of
  // an id already copied is not
  constructor(dir: string, examplesDirs: string[], logger: Logger) {
    super();
    this.dir = dir;
    this.examplesDirs = examplesDirs;
    this.logger = logger;
  }

  // Returns the number of example panels installed
  async init(): Promise<number> {
    try {
      await fs.access(this.dir);
      return 0;
    } catch {
      // First start: create the directory with the examples
    }
    await fs.mkdir(this.dir, { recursive: true });
    const copied = new Set<string>();
    for (const examplesDir of this.examplesDirs) {
      const examples = await fs.readdir(examplesDir).catch(() => [] as string[]);
      for (const file of examples.filter((f) => f.endsWith('.json') && !copied.has(f))) {
        await fs.copyFile(path.join(examplesDir, file), path.join(this.dir, file));
        copied.add(file);
      }
    }
    return copied.size;
  }

  // Files that are not valid panels are left out, with a warning
  async list(): Promise<PanelSummary[]> {
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const panels: PanelSummary[] = [];
    for (const file of files) {
      const id = file.slice(0, -'.json'.length);
      if (!PANEL_ID_PATTERN.test(id)) {
        this.logger.warn(`Ignoring ${path.join(this.dir, file)}: panel file names must match ${PANEL_ID_PATTERN}`);
        continue;
      }
      try {
        const panel = await this.get(id);
        if (panel) {
          panels.push({ id, name: panel.name });
        }
      } catch (e) {
        this.logger.warn((e as Error).message);
      }
    }
    return panels.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Throws if the file exists but is not a valid panel
  async get(id: string): Promise<Panel | null> {
    if (!PANEL_ID_PATTERN.test(id)) {
      return null;
    }
    let text: string;
    try {
      text = await fs.readFile(this.file(id), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw e;
    }
    try {
      return sanitizePanel(JSON.parse(text), id);
    } catch (e) {
      throw new HttpError(500, `${this.file(id)} is not a valid panel: ${(e as Error).message}`);
    }
  }

  async create(value: unknown, origin: string | null): Promise<Panel> {
    const name = isObject(value) && typeof value.name === 'string' ? value.name : '';
    const base = slugify(name);
    const existing = new Set(
      (await fs.readdir(this.dir)).map((f) => f.slice(0, -'.json'.length)),
    );
    let id = base;
    for (let n = 2; existing.has(id); n++) {
      id = `${base}-${n}`;
    }
    const panel = sanitizePanel(value, id);
    await this.write(panel, 'wx');
    this.emit('changed', id, false, origin);
    return panel;
  }

  async save(id: string, value: unknown, origin: string | null): Promise<Panel> {
    if (!PANEL_ID_PATTERN.test(id)) {
      throw new HttpError(400, `Invalid panel id "${id}"`);
    }
    const panel = sanitizePanel(value, id);
    await this.write(panel, 'w');
    this.emit('changed', id, false, origin);
    return panel;
  }

  async remove(id: string, origin: string | null): Promise<boolean> {
    if (!PANEL_ID_PATTERN.test(id)) {
      return false;
    }
    try {
      await fs.unlink(this.file(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw e;
    }
    this.emit('changed', id, true, origin);
    return true;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  // Through a temporary file, so that a crash never leaves half a panel.
  // flag 'wx' fails if the panel exists.
  private async write(panel: Panel, flag: 'w' | 'wx'): Promise<void> {
    const { id, ...content } = panel;
    const text = `${JSON.stringify(content, null, 2)}\n`;
    if (flag === 'wx') {
      await fs.writeFile(this.file(id), text, { flag });
      return;
    }
    const tmp = `${this.file(id)}.${process.pid}-${++this.writes}.tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, this.file(id));
  }
}
