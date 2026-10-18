// Where the widgets go on each kind of device. The desktop's board is a free
// canvas of fixed cells, the widgets' own x, y, w and h. Tablets and phones
// have a fixed number of columns, whose cells stretch to the screen's width:
// a layout looks the same on every phone. Their layout is the panel's own for
// the device (Panel.layouts) if it has one, else made from the desktop's,
// keeping its reading order; widgets the device layout does not place yet,
// e.g. added since, go after the others.

import type { Device, DeviceLayout, Panel, Rect, SmallDevice } from '../../shared/panel.ts';

export const DEVICES: Record<Device, { label: string; columns: number | null; previewWidth: number | null }> = {
  desktop: { label: 'Desktop', columns: null, previewWidth: null },
  tablet: { label: 'Tablet', columns: 12, previewWidth: 820 },
  phone: { label: 'Phone', columns: 6, previewWidth: 390 },
};

// By the width of the window, in CSS pixels
export function deviceFor(width: number): Device {
  return width < 640 ? 'phone' : width < 1100 ? 'tablet' : 'desktop';
}

export interface Layout {
  // Of the widgets shown, by id
  rects: Map<string, Rect>;
  // The widgets not shown on the device
  hidden: string[];
  // The panel places the widgets on the device itself, instead of
  // automatically (its hidden widgets aside)
  custom: boolean;
}

type MinSize = (type: string) => { w: number; h: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// No other widget in the way, and within the columns (if any)
export function fits(rect: Rect, layout: Layout, columns: number | null, ignoreId?: string): boolean {
  if (rect.x < 0 || rect.y < 0 || (columns !== null && rect.x + rect.w > columns)) {
    return false;
  }
  for (const [id, other] of layout.rects) {
    if (id !== ignoreId && overlaps(rect, other)) {
      return false;
    }
  }
  return true;
}

// The first free place of this size, from the row given on
function firstFree(placed: Map<string, Rect>, w: number, h: number, columns: number, fromRow: number): Rect {
  for (let y = fromRow; ; y++) {
    for (let x = 0; x + w <= columns; x++) {
      const rect = { x, y, w, h };
      if (![...placed.values()].some((other) => overlaps(rect, other))) {
        return rect;
      }
    }
  }
}

export function layoutFor(panel: Panel, device: Device, minSize: MinSize): Layout {
  const columns = DEVICES[device].columns;
  if (columns === null) {
    return {
      rects: new Map(panel.widgets.map((w) => [w.id, { x: w.x, y: w.y, w: w.w, h: w.h }])),
      hidden: [],
      custom: true,
    };
  }
  const own = panel.layouts?.[device as SmallDevice];
  const hidden = new Set(own?.hidden ?? []);
  const rects = new Map<string, Rect>();
  for (const widget of panel.widgets) {
    const rect = own?.rects[widget.id];
    if (rect && !hidden.has(widget.id)) {
      const w = Math.min(rect.w, columns);
      rects.set(widget.id, { x: Math.min(rect.x, columns - w), y: rect.y, w, h: rect.h });
    }
  }
  // After what the device's layout places, in the desktop's reading order
  let row = Math.max(0, ...[...rects.values()].map((r) => r.y + r.h));
  const rest = panel.widgets
    .filter((w) => !hidden.has(w.id) && !rects.has(w.id))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const widget of rest) {
    const w = Math.min(widget.w, columns);
    // Narrowed: the height follows, to keep its shape
    const h =
      widget.w > columns ? Math.max(minSize(widget.type).h, Math.round((widget.h * columns) / widget.w)) : widget.h;
    const rect = firstFree(rects, w, h, columns, row);
    rects.set(widget.id, rect);
    row = rect.y;
  }
  return { rects, hidden: [...hidden], custom: Object.keys(own?.rects ?? {}).length > 0 };
}

function withLayout(panel: Panel, device: SmallDevice, layout: DeviceLayout): Panel {
  return { ...panel, layouts: { ...panel.layouts, [device]: layout } };
}

// The widget moved or resized on the device: on a tablet or phone, the
// layout shown becomes the device's own, the automatic places included
export function withRect(panel: Panel, device: Device, current: Layout, id: string, rect: Rect): Panel {
  if (device === 'desktop') {
    return { ...panel, widgets: panel.widgets.map((w) => (w.id === id ? { ...w, ...rect } : w)) };
  }
  const rects = Object.fromEntries(current.rects);
  rects[id] = rect;
  return withLayout(panel, device, { rects, hidden: current.hidden });
}

// The widget hidden on the device, or shown again: in an automatic layout the
// others close the gap, in an arranged one they stay, and it comes back after
// them
export function withHidden(panel: Panel, device: SmallDevice, current: Layout, id: string, hide: boolean): Panel {
  const rects = current.custom ? Object.fromEntries([...current.rects].filter(([widget]) => widget !== id)) : {};
  const hidden = hide ? [...new Set([...current.hidden, id])] : current.hidden.filter((widget) => widget !== id);
  return withLayout(panel, device, { rects, hidden });
}

// Back to the automatic layout
export function withoutLayout(panel: Panel, device: SmallDevice): Panel {
  const { [device]: _, ...others } = panel.layouts ?? {};
  const { layouts: __, ...rest } = panel;
  return Object.keys(others).length > 0 ? { ...rest, layouts: others } : rest;
}
