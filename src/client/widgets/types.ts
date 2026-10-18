// What a widget is made of: see registry.ts to add one

import type { ComponentType, SVGProps } from 'react';

import type { WidgetInstance } from '../../shared/panel.ts';

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
          | { kind: 'select'; default: V; options: { value: V; label: string }[] }
          // A robot file (browsed), a package's, or an uploaded image: see imageUrl
          | { kind: 'image'; default: V; placeholder?: string }
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
}

// The same, with the config type erased: what the registry holds
export type Property = PropertyBase<Config, string> &
  (
    | PropertyKind<boolean>
    | PropertyKind<number>
    | { kind: 'string' | 'color' | 'text'; default: string; placeholder?: string }
    | { kind: 'topic'; default: string; topicTypes: string[]; placeholder?: string }
    | { kind: 'select'; default: string; options: { value: string; label: string }[] }
    | { kind: 'image'; default: string; placeholder?: string }
  );

export interface RegisteredWidget extends Omit<WidgetDefinition<Config>, 'properties'> {
  properties: Property[];
}

// Type-checks a widget's definition against its config, then erases the config
// type so that all definitions fit in the registry
export function defineWidget<C>(definition: WidgetDefinition<C>): RegisteredWidget {
  return definition as unknown as RegisteredWidget;
}

// The page's side of a plugin: the default export of its client module (see
// src/server/plugins.ts)
export interface TasselloClientPlugin {
  // The widgets it adds to the palette. Their types are stored in the panels:
  // prefix them with something of the plugin's own, e.g. "myrobot.gripper"
  widgets?: RegisteredWidget[];
  // New defaults of widgets' properties, Tassello's or other plugins', by
  // widget type then property key: e.g. a robot's own topic names and speed
  // limits, { teleop: { topic: '/myrobot/cmd_vel', maxLinear: 0.3 } }. They
  // stand in for the values a panel does not set.
  defaults?: Record<string, Record<string, unknown>>;
}

export function definePlugin(plugin: TasselloClientPlugin): TasselloClientPlugin {
  return plugin;
}
