// The status bar's grid: one row of STATUS_COLUMNS columns, stretched to the
// bar's width, on which the status widgets lie, each over a few columns and
// never on another. Moved and resized as the board's widgets are, with its
// layouts' fits and movedBy.

import { STATUS_COLUMNS, type Rect, type StatusWidgetInstance } from '../../shared/panel.ts';
import type { Layout } from './layouts.ts';

export { STATUS_COLUMNS };

// The space between neighbouring status widgets, in CSS pixels
export const STATUS_GAP = 6;

// The widgets' places, by id, within the columns (a file may have them
// further), on the one row
export function statusLayout(widgets: StatusWidgetInstance[]): Layout {
  const rects = new Map<string, Rect>();
  for (const widget of widgets) {
    const w = Math.min(widget.w, STATUS_COLUMNS);
    rects.set(widget.id, { x: Math.min(widget.x, STATUS_COLUMNS - w), y: 0, w, h: 1 });
  }
  return { rects, hidden: [], custom: true };
}

// CSS position of a place, on columns that wide
export function placeStatus(rect: Rect, column: number): { left: number; width: number } {
  return { left: rect.x * column + STATUS_GAP / 2, width: rect.w * column - STATUS_GAP };
}

// A width dragged by this many columns: at least min, within the bar
export function widened(rect: Rect, columns: number, min: number): Rect {
  const max = STATUS_COLUMNS - rect.x;
  return { ...rect, w: Math.min(max, Math.max(Math.min(min, max), rect.w + columns)) };
}

// Where a status widget of w columns goes: the first free place from the
// column `from` on, then from the left; else the widest free place, if at
// least min columns. Null if there is none.
export function freePlace(
  rects: Iterable<Rect>,
  w: number,
  min: number,
  from = 0,
): { x: number; w: number } | null {
  const taken = new Array<boolean>(STATUS_COLUMNS).fill(false);
  for (const rect of rects) {
    for (let x = Math.max(0, rect.x); x < Math.min(STATUS_COLUMNS, rect.x + rect.w); x++) {
      taken[x] = true;
    }
  }
  const width = Math.min(w, STATUS_COLUMNS);
  const start = Math.min(Math.max(0, from), STATUS_COLUMNS);
  const columns = [...Array(STATUS_COLUMNS).keys()];
  for (const x of [...columns.slice(start), ...columns.slice(0, start)]) {
    if (x + width <= STATUS_COLUMNS && !taken.slice(x, x + width).some(Boolean)) {
      return { x, w: width };
    }
  }
  let widest: { x: number; w: number } | null = null;
  for (let x = 0; x < STATUS_COLUMNS; x++) {
    let run = 0;
    while (x + run < STATUS_COLUMNS && !taken[x + run]) {
      run++;
    }
    if (run > (widest?.w ?? 0)) {
      widest = { x, w: run };
    }
    x += run;
  }
  return widest && widest.w >= min ? widest : null;
}
