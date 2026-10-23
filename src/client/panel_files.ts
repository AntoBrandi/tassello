// Panels exported to a file and imported from one. The file is the panel's own
// file on the server (<panels dir>/<id>.json, see src/server/panels.ts): its
// name, its widgets with their desktop places, and the tablet's and phone's
// layouts. An exported file can be imported, or copied into a panels
// directory, and the other way round.

import { SMALL_DEVICES, type Panel } from '../shared/panel.ts';

export type PanelFile = Omit<Panel, 'id'>;

// What the server keeps of the panel: its device layouts place only the
// widgets it has (a widget removed leaves its places behind until saved)
export function panelFile(panel: Panel): PanelFile {
  const ids = new Set(panel.widgets.map((w) => w.id));
  const layouts: NonNullable<Panel['layouts']> = {};
  for (const device of SMALL_DEVICES) {
    const layout = panel.layouts?.[device];
    if (layout) {
      layouts[device] = {
        rects: Object.fromEntries(Object.entries(layout.rects).filter(([id]) => ids.has(id))),
        hidden: layout.hidden.filter((id) => ids.has(id)),
      };
    }
  }
  const file: PanelFile = { name: panel.name, widgets: panel.widgets };
  if (Object.keys(layouts).length > 0) {
    file.layouts = layouts;
  }
  return file;
}

// As the server writes it
export function panelFileText(panel: Panel): string {
  return `${JSON.stringify(panelFile(panel), null, 2)}\n`;
}

// teleoperation.json: copied into a panels directory, the same panel id
export function panelFileName(panel: Panel): string {
  return `${panel.id}.json`;
}

// The panel of a file, checked enough to tell it from other JSON files (a
// package.json has a name too): the server checks the rest when it creates it.
// Throws what is wrong, to show.
export function readPanelFile(text: string): PanelFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('it is not a JSON file');
  }
  const object = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!object || typeof object.name !== 'string' || !Array.isArray(object.widgets)) {
    throw new Error('it is not a Tassello panel (a JSON object with a name and widgets)');
  }
  return object as unknown as PanelFile;
}

// "Teleoperation", or "Teleoperation (2)" if a panel has that name already
export function freeName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const base = name.trim();
  let free = base;
  for (let n = 2; names.has(free); n++) {
    free = `${base} (${n})`;
  }
  return free;
}
