// Colours of the OccupancyGrid cells: occupancy probabilities 0-100, -1 for
// unknown. In Nav2's costmaps 99 is inscribed (the robot's footprint would
// touch an obstacle) and 100 lethal.

import type { GridStyle } from '../shared/protocol.ts';

export interface Grid {
  width: number;
  height: number;
  data: Int8Array;
}

// Pixels for sharp: gray and alpha for maps, RGBA for costmaps, and the
// bounding box of the cells that are not unknown
export interface GridPixels {
  data: Buffer;
  channels: 2 | 4;
  known: { x: number; y: number; width: number; height: number } | null;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// 256 entries of `channels` bytes, indexed by the cell value as an unsigned
// byte: -1 is 255. Values out of 0-100 are unknown.
function mapTable(): Uint8Array {
  const table = new Uint8Array(256 * 2);
  for (let v = 0; v <= 100; v++) {
    // Free near white, occupied near black: as RViz, readable on any theme
    table[v * 2] = lerp(242, 28, v / 100);
    table[v * 2 + 1] = 255;
  }
  return table;
}

function costmapTable(): Uint8Array {
  const table = new Uint8Array(256 * 4);
  const set = (v: number, r: number, g: number, b: number, a: number) => table.set([r, g, b, a], v * 4);
  // 0, free: transparent, the map shows through
  for (let v = 1; v <= 98; v++) {
    const t = (v - 1) / 97;
    set(v, lerp(59, 239, t), lerp(130, 68, t), lerp(246, 68, t), lerp(60, 170, t));
  }
  set(99, 34, 211, 238, 170);
  set(100, 217, 70, 239, 220);
  return table;
}

const TABLES: Record<GridStyle, { table: Uint8Array; channels: 2 | 4 }> = {
  map: { table: mapTable(), channels: 2 },
  costmap: { table: costmapTable(), channels: 4 },
};

// One pixel per cell, rows in the grid's order: the page draws the first one
// at the origin's side
export function renderGrid(grid: Grid, style: GridStyle): GridPixels {
  const { table, channels } = TABLES[style];
  const cells = grid.width * grid.height;
  if (grid.data.length < cells) {
    throw new Error(`Malformed grid: ${grid.data.length} cells for ${grid.width}x${grid.height}`);
  }
  const out = Buffer.allocUnsafe(cells * channels);
  let [minX, minY, maxX, maxY] = [grid.width, grid.height, -1, -1];
  for (let i = 0; i < cells; i++) {
    const value = grid.data[i];
    const entry = (value & 0xff) * channels;
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = table[entry + c];
    }
    if (value >= 0 && value <= 100) {
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const known = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { data: out, channels, known };
}

// Copies a map_msgs/OccupancyGridUpdate into the grid; false if it does not fit
export function applyUpdate(
  grid: Grid,
  update: { x: number; y: number; width: number; height: number; data: Int8Array },
): boolean {
  const { x, y, width, height, data } = update;
  if (x < 0 || y < 0 || x + width > grid.width || y + height > grid.height || data.length < width * height) {
    return false;
  }
  for (let row = 0; row < height; row++) {
    grid.data.set(data.subarray(row * width, (row + 1) * width), (y + row) * grid.width + x);
  }
  return true;
}
