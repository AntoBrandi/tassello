// The board's grid: fixed square cells, widgets placed and sized in cells

import type { WidgetInstance } from '../../shared/panel.ts';

// Cell size and the space between neighbouring widgets, in CSS pixels
export const CELL = 64;
export const GAP = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// No other widget than `ignoreId` in the way
export function isFree(rect: Rect, widgets: WidgetInstance[], ignoreId?: string): boolean {
  return rect.x >= 0 && rect.y >= 0 && !widgets.some((w) => w.id !== ignoreId && overlaps(rect, w));
}

// Columns and rows the rects span
export function extent(rects: Rect[]): { cols: number; rows: number } {
  return {
    cols: Math.max(0, ...rects.map((r) => r.x + r.w)),
    rows: Math.max(0, ...rects.map((r) => r.y + r.h)),
  };
}

// The first free place for a widget of this size, row by row within `cols`
// columns (those on screen), else below everything
export function freeSpot(widgets: WidgetInstance[], size: { w: number; h: number }, cols: number): Rect {
  const { rows } = extent(widgets);
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x + size.w <= Math.max(cols, size.w); x++) {
      const rect = { x, y, ...size };
      if (isFree(rect, widgets)) {
        return rect;
      }
    }
  }
  return { x: 0, y: rows, ...size };
}

// CSS position of a rect on the board, of cells of that size
export function place(rect: Rect, cell = CELL): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * cell + GAP / 2,
    top: rect.y * cell + GAP / 2,
    width: rect.w * cell - GAP,
    height: rect.h * cell - GAP,
  };
}
