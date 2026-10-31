// What a widget is made of, a status widget, which a panel's status bar shows
// above its board, and a display, which the Robot Viewer draws: see
// registry.ts to add one

import type { ComponentType, SVGProps } from 'react';

import type { DisplayInstance, StatusWidgetInstance, WidgetInstance } from '../../shared/panel.ts';
import type { DisplayClass } from './robot_viewer/display.ts';

type Config = Record<string, unknown>;

interface PropertyBase<C, K extends string> {
  key: K;
  label: string;
  help?: string;
  // Hides the property when it does not apply, e.g. the frame id of a Twist
  visible?: (config: C) => boolean;
}

// The kinds of property the editor offers, by value type. [V]: not
// distributed over the members of a union, e.g. of a select's values.
type PropertyKind<V> = [V] extends [boolean]
  ? { kind: 'boolean'; default: V }
  : [V] extends [number]
    ? { kind: 'number'; default: V; min?: number; max?: number; step?: number }
    : [V] extends [string]
      ?
          | { kind: 'string' | 'color'; default: V; placeholder?: string }
          // Multi-line, monospace: commands
          | { kind: 'text'; default: V; placeholder?: string }
          // Suggests the topics of the ROS graph of these types
          | { kind: 'topic'; default: V; topicTypes: string[]; placeholder?: string }
          | {
              kind: 'select';
              default: V;
              options: { value: V; label: string }[];
              // Options known at run time, e.g. the robot's, after `options`:
              // a hook, called by the properties panel. Values among neither
              // are kept, as they may be options later
              useOptions?: () => { value: V; label: string }[];
            }
          // A robot file (browsed), a package's, or an uploaded image: see imageUrl
          | { kind: 'image'; default: V; placeholder?: string }
          // The same, of a behavior tree's XML (BT.CPP's)
          | { kind: 'behavior-tree'; default: V; placeholder?: string }
      : [V] extends [DisplayInstance[]]
        ? // A Robot Viewer's displays: a list, each of its own properties
          { kind: 'displays'; default: V }
        : never;

// A property of a widget, edited in the properties panel. Its value is stored
// in the widget's config; the default stands in for a missing or mistyped one.
export type PropertySchema<C> = {
  [K in keyof C & string]: PropertyBase<C, K> & PropertyKind<C[K]>;
}[keyof C & string];

export interface WidgetProps<C> {
  config: C;
  instance: WidgetInstance;
  panelId: string;
  // Edit mode: the widget is shown, not used
  editing: boolean;
  // Changes some of its properties, saved with the panel as the properties
  // panel's changes are: what people choose in the widget itself, e.g. a
  // plot's series
  updateConfig: (changes: Partial<C>) => void;
}

export interface WidgetDefinition<C> {
  // Stored in the panels: never change it
  type: string;
  name: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  // In grid cells
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  properties: PropertySchema<C>[];
  component: ComponentType<WidgetProps<C>>;
  // Upgrades a config saved by an earlier version of the widget, before its
  // properties are read from it: e.g. properties renamed
  migrate?: (stored: Record<string, unknown>) => Record<string, unknown>;
}

// The same, with the config type erased: what the registry holds
export type Property = PropertyBase<Config, string> &
  (
    | PropertyKind<boolean>
    | PropertyKind<number>
    | { kind: 'string' | 'color' | 'text'; default: string; placeholder?: string }
    | { kind: 'topic'; default: string; topicTypes: string[]; placeholder?: string }
    | {
        kind: 'select';
        default: string;
        options: { value: string; label: string }[];
        useOptions?: () => { value: string; label: string }[];
      }
    | { kind: 'image' | 'behavior-tree'; default: string; placeholder?: string }
    | { kind: 'displays'; default: DisplayInstance[] }
  );

export interface RegisteredWidget extends Omit<WidgetDefinition<Config>, 'properties'> {
  properties: Property[];
}

// Type-checks a widget's definition against its config, then erases the config
// type so that all definitions fit in the registry
export function defineWidget<C>(definition: WidgetDefinition<C>): RegisteredWidget {
  return definition as unknown as RegisteredWidget;
}

export interface StatusWidgetProps<C> {
  config: C;
  // Its place (x) and width (w), in the bar's columns
  instance: StatusWidgetInstance;
  panelId: string;
  // Edit mode: the status widget is shown, not used
  editing: boolean;
  // Changes some of its properties, saved with the panel
  updateConfig: (changes: Partial<C>) => void;
}

// A status widget: one reading at a glance (the Wi-Fi signal, the CPU's
// load), in a panel's status bar, above its board. As tall as the bar, as wide as
// people make it, in columns that stretch to the bar's width (STATUS_COLUMNS
// across it): StatusReadout (StatusReadout.tsx) lays out an icon, a value and
// a label that fit it.
export interface StatusWidgetDefinition<C> {
  // Stored in the panels' status bars: never change it. No widget's type
  // either.
  type: string;
  name: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  // In the bar's columns
  defaultWidth: number;
  minWidth: number;
  properties: PropertySchema<C>[];
  component: ComponentType<StatusWidgetProps<C>>;
}

export interface RegisteredStatusWidget extends Omit<StatusWidgetDefinition<Config>, 'properties'> {
  properties: Property[];
}

export function defineStatusWidget<C>(definition: StatusWidgetDefinition<C>): RegisteredStatusWidget {
  return definition as unknown as RegisteredStatusWidget;
}

// A display of the Robot Viewer, as RViz's: a kind of thing it draws in 3D (or
// from above, in 2D), e.g. a laser scan. A viewer has a list of them, each
// with its own properties, edited in the side panel: people add them from
// those registered, Tassello's and the plugins'.
export interface DisplayDefinition<C> {
  // Stored in the panels' Robot Viewers: never change it. No widget's nor
  // status widget's type either.
  type: string;
  name: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  properties: PropertySchema<C>[];
  // Its class, which extends Display (tassello/viewer), imported with three.js
  // when a viewer first shows such a display: keep it in a module of its own,
  // e.g. () => import('./PoseDisplay.ts').then((m) => m.PoseDisplay)
  load: () => Promise<DisplayClass<C>>;
}

export interface RegisteredDisplay extends Omit<DisplayDefinition<Config>, 'properties'> {
  properties: Property[];
}

export function defineDisplay<C>(definition: DisplayDefinition<C>): RegisteredDisplay {
  return definition as unknown as RegisteredDisplay;
}

// The page's side of a plugin: the default export of its client module (see
// src/server/plugins.ts)
export interface TasselloClientPlugin {
  // The widgets it adds to the palette. Their types are stored in the panels:
  // prefix them with something of the plugin's own, e.g. "myrobot.gripper"
  widgets?: RegisteredWidget[];
  // The status widgets it adds to the status bars' palette, their types
  // prefixed the same way, e.g. "myrobot.battery-status"
  statusWidgets?: RegisteredStatusWidget[];
  // The displays it adds to the Robot Viewer, their types prefixed the same
  // way, e.g. "myrobot.gripper-display"
  displays?: RegisteredDisplay[];
  // New defaults of widgets' properties, Tassello's or other plugins', by
  // widget type then property key: e.g. a robot's own topic names and speed
  // limits, { teleop: { topic: '/myrobot/cmd_vel', maxLinear: 0.3 } }. They
  // stand in for the values a panel does not set. Status widgets' and
  // displays' too.
  defaults?: Record<string, Record<string, unknown>>;
}

export function definePlugin(plugin: TasselloClientPlugin): TasselloClientPlugin {
  return plugin;
}
