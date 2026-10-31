// What the Robot Viewer works out without three.js: its displays as saved by
// the Robot Model widget it replaces, the frame Auto stands for, new
// displays' ids, and the colour scale of points.

import type { DisplayInstance } from '../../../shared/panel.ts';

// The core displays' types: stored in the panels, never change them
export const ROBOT_MODEL_DISPLAY = 'robot-model-display';
export const TF_DISPLAY = 'tf-display';
export const GRID_DISPLAY = 'grid-display';
export const LASER_SCAN_DISPLAY = 'laser-scan-display';
export const POINT_CLOUD_DISPLAY = 'point-cloud-display';

// A new viewer's: the robot, its frames ready to be shown
export const DEFAULT_DISPLAYS: DisplayInstance[] = [
  { id: 'robot', type: ROBOT_MODEL_DISPLAY, name: '', enabled: true, config: {} },
  { id: 'tf', type: TF_DISPLAY, name: '', enabled: false, config: {} },
];

// The Robot Model widget's properties, before it became the Robot Viewer
const LEGACY_KEYS = ['descriptionTopic', 'jointStatesTopic', 'showFrames', 'highlightMotion'];

// A config saved by the Robot Model widget: its robot and frames as displays.
// Others are as they are, e.g. a new viewer's (the property's default).
export function migrateRobotModelConfig(stored: Record<string, unknown>): Record<string, unknown> {
  if (stored.displays !== undefined || !LEGACY_KEYS.some((key) => key in stored)) {
    return stored;
  }
  const robot: Record<string, unknown> = {};
  for (const key of ['descriptionTopic', 'jointStatesTopic', 'highlightMotion']) {
    if (key in stored) {
      robot[key] = stored[key];
    }
  }
  const displays: DisplayInstance[] = [
    { id: 'robot', type: ROBOT_MODEL_DISPLAY, name: '', enabled: true, config: robot },
    { id: 'tf', type: TF_DISPLAY, name: '', enabled: stored.showFrames === true, config: {} },
  ];
  return { ...stored, displays };
}

// The root of the largest tree: what Auto stands for when no display suggests
// a frame, e.g. map above odom above the robot
export function treeRoot(frames: { name: string; parent: string | null }[]): string | null {
  const parents = new Map(frames.map((frame) => [frame.name, frame.parent]));
  const sizes = new Map<string, number>();
  for (const frame of frames) {
    let current = frame.name;
    // Trees are shallow: a long way up is a loop
    for (let depth = 0; depth < 100 && parents.get(current); depth++) {
      current = parents.get(current)!;
    }
    sizes.set(current, (sizes.get(current) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [root, size] of sizes) {
    if (best === null || size > sizes.get(best)! || (size === sizes.get(best)! && root < best)) {
      best = root;
    }
  }
  return best;
}

// The frame the view is in: the one chosen, else the first suggested by the
// displays (in their order), else the root of the TF tree
export function effectiveFixedFrame(
  chosen: string,
  suggestions: (string | null)[],
  frames: { name: string; parent: string | null }[],
): string {
  return chosen.trim().replace(/^\/+/, '') || suggestions.find((s) => !!s) || treeRoot(frames) || '';
}

// Not crypto.randomUUID: for secure pages only, and the dashboard is mostly
// served over http
export function newDisplayId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = `d${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (!used.has(id)) {
      return id;
    }
  }
}

export function moveItem<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) {
    return list;
  }
  const moved = [...list];
  [moved[index], moved[target]] = [moved[target], moved[index]];
  return moved;
}

// RViz's rainbow, for intensities and heights: 0 red, then yellow, green,
// cyan, blue, 1 magenta. r, g, b in 0-1.
export function rainbow(value: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const v = 1 - Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const h = v * 5 + 1;
  const i = Math.floor(h);
  let f = h - i;
  if (!(i & 1)) {
    f = 1 - f;
  }
  const n = 1 - f;
  if (i <= 1) {
    out[0] = n;
    out[1] = 0;
    out[2] = 1;
  } else if (i === 2) {
    out[0] = 0;
    out[1] = n;
    out[2] = 1;
  } else if (i === 3) {
    out[0] = 0;
    out[1] = 1;
    out[2] = n;
  } else if (i === 4) {
    out[0] = n;
    out[1] = 1;
    out[2] = 0;
  } else {
    out[0] = 1;
    out[1] = n;
    out[2] = 0;
  }
  return out;
}

// '#rrggbb' to r, g, b in 0-1; grey if not a colour
export function parseColor(color: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) {
    return [0.5, 0.5, 0.5];
  }
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// Frames whose names contain one of the comma-separated words of the filter,
// any case; every frame if it has none
export function frameFilter(filter: string): (name: string) => boolean {
  const words = filter
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  return words.length === 0 ? () => true : (name) => words.some((word) => name.toLowerCase().includes(word));
}
