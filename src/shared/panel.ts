// A panel is a named board of widgets, stored by the server as one JSON file
// per panel (<panels_dir>/<id>.json). Positions and sizes are in grid cells.
//
// The widgets' own x, y, w and h are their desktop layout. Tablets and phones
// lay them out on a fixed number of columns (see src/client/board/layouts.ts):
// automatically from the desktop layout, unless the panel has a layout of its
// own for the device.

export interface WidgetInstance {
  id: string;
  // Key of the widget in the client's registry (src/client/widgets/registry.ts)
  type: string;
  // Shown above the widget, if not empty
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // The widget's own properties, as its definition declares them
  config: Record<string, unknown>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Device = 'desktop' | 'tablet' | 'phone';
export const SMALL_DEVICES = ['tablet', 'phone'] as const;
export type SmallDevice = (typeof SMALL_DEVICES)[number];

// A device's own layout: the widgets' places (by widget id; those missing are
// placed automatically after them), and those not shown on the device
export interface DeviceLayout {
  rects: Record<string, Rect>;
  hidden: string[];
}

export interface Panel {
  id: string;
  name: string;
  widgets: WidgetInstance[];
  layouts?: Partial<Record<SmallDevice, DeviceLayout>>;
}

export interface PanelSummary {
  id: string;
  name: string;
}

export interface TopicInfo {
  name: string;
  types: string[];
}

// Panel ids are file names: no path separators, no hidden files
export const PANEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
