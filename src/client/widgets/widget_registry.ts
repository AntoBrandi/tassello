// The widgets of the palette: Tassello's own, then those of the plugins
// (see ../plugins.ts), which may also change the defaults of any widget's
// properties, e.g. a robot's topic names and speed limits. The status
// widgets and the Robot Viewer's displays have registries of their own, of
// the same kind.

import type { DisplayInstance } from '../../shared/panel.ts';
import type {
  Property,
  RegisteredDisplay,
  RegisteredStatusWidget,
  RegisteredWidget,
  TasselloClientPlugin,
} from './types.ts';

// What a registry holds: a widget's definition, or a status widget's
interface Definition {
  type: string;
  properties: Property[];
}

export interface Entry<D> {
  definition: D;
  // The plugin that adds it, null for Tassello's own
  plugin: string | null;
}

export type WidgetEntry = Entry<RegisteredWidget>;
export type StatusWidgetEntry = Entry<RegisteredStatusWidget>;
export type DisplayEntry = Entry<RegisteredDisplay>;

export function fitsProperty(property: Property, value: unknown): boolean {
  return (
    typeof value === typeof property.default &&
    (property.kind !== 'displays' || Array.isArray(value)) &&
    // Those with options known at run time take any value: see useOptions
    (property.kind !== 'select' || !!property.useOptions || property.options.some((o) => o.value === value)) &&
    (typeof value !== 'number' || Number.isFinite(value))
  );
}

export class DefinitionRegistry<D extends Definition> {
  // As registered, before the defaults' changes
  private registered: Entry<D>[];
  // New defaults, by type then property key
  private readonly defaults = new Map<string, Map<string, unknown>>();
  private current: Entry<D>[];
  // The plugin's definitions for this registry
  private readonly of: (plugin: TasselloClientPlugin) => D[] | undefined;
  // What they are, for the problems
  private readonly kind: string;
  // Whose a type of another registry is: types are unique across them, as
  // the defaults are by type
  private readonly taken: (type: string) => string | null;

  constructor(
    core: D[],
    of: (plugin: TasselloClientPlugin) => D[] | undefined,
    kind: string,
    taken: (type: string) => string | null = () => null,
  ) {
    this.registered = core.map((definition) => ({ definition, plugin: null }));
    this.current = this.registered;
    this.of = of;
    this.kind = kind;
    this.taken = taken;
  }

  // Adds a plugin's definitions and defaults; returns what was wrong with them
  registerPlugin(name: string, plugin: TasselloClientPlugin): string[] {
    const problems: string[] = [];
    for (const definition of this.of(plugin) ?? []) {
      const existing = this.registered.find((entry) => entry.definition.type === definition.type);
      const owner = existing ? (existing.plugin ? `${existing.plugin}'s` : "Tassello's") : this.taken(definition.type);
      if (owner) {
        problems.push(`its ${this.kind} type "${definition.type}" is already ${owner}`);
        continue;
      }
      this.registered = [...this.registered, { definition, plugin: name }];
    }
    for (const [type, values] of Object.entries(plugin.defaults ?? {})) {
      const own = this.defaults.get(type) ?? new Map<string, unknown>();
      for (const [key, value] of Object.entries(values)) {
        own.set(key, value);
        const definition = this.registered.find((entry) => entry.definition.type === type)?.definition;
        const property = definition?.properties.find((p) => p.key === key);
        // Of one not registered (yet), or the other registry's: kept, in case
        // a later plugin adds it
        if (definition && (!property || !fitsProperty(property, value))) {
          problems.push(`its default of ${type}.${key} is not one of the property's values`);
        }
      }
      this.defaults.set(type, own);
    }
    this.current = this.registered.map((entry) => ({ ...entry, definition: this.withDefaults(entry.definition) }));
    return problems;
  }

  entries(): Entry<D>[] {
    return this.current;
  }

  definition(type: string): D | undefined {
    return this.current.find((entry) => entry.definition.type === type)?.definition;
  }

  // Whose it is, if registered: for the other registries' taken
  owner(type: string): string | null {
    const entry = this.registered.find((e) => e.definition.type === type);
    return entry ? `${entry.plugin ? `${entry.plugin}'s` : "Tassello's"}, as a ${this.kind}` : null;
  }

  private withDefaults(definition: D): D {
    const changed = this.defaults.get(definition.type);
    if (!changed) {
      return definition;
    }
    return {
      ...definition,
      properties: definition.properties.map((property) =>
        changed.has(property.key) && fitsProperty(property, changed.get(property.key))
          ? ({ ...property, default: changed.get(property.key) } as Property)
          : property,
      ),
    };
  }
}

export class WidgetRegistry extends DefinitionRegistry<RegisteredWidget> {
  constructor(core: RegisteredWidget[], taken?: (type: string) => string | null) {
    super(core, (plugin) => plugin.widgets, 'widget', taken);
  }
}

export class StatusWidgetRegistry extends DefinitionRegistry<RegisteredStatusWidget> {
  constructor(core: RegisteredStatusWidget[], taken?: (type: string) => string | null) {
    super(core, (plugin) => plugin.statusWidgets, 'status widget', taken);
  }
}

export class DisplayRegistry extends DefinitionRegistry<RegisteredDisplay> {
  constructor(core: RegisteredDisplay[], taken?: (type: string) => string | null) {
    super(core, (plugin) => plugin.displays, 'display', taken);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A list of displays as stored, those that are not displays left out (an id
// taken again, no type): their missing fields filled in
export function displayList(value: unknown[]): DisplayInstance[] {
  const ids = new Set<string>();
  const displays: DisplayInstance[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string' || ids.has(item.id)) {
      continue;
    }
    ids.add(item.id);
    displays.push({
      id: item.id,
      type: item.type,
      name: typeof item.name === 'string' ? item.name : '',
      enabled: item.enabled !== false,
      config: isRecord(item.config) ? item.config : {},
    });
  }
  return displays;
}

// The widget's config with every property: stored values of the right type,
// defaults for the others; first upgraded, if saved by an earlier version
export function resolveConfig(
  definition: { properties: Property[]; migrate?: (stored: Record<string, unknown>) => Record<string, unknown> },
  stored: Record<string, unknown>,
) {
  const current = definition.migrate ? definition.migrate(stored) : stored;
  const config: Record<string, unknown> = {};
  for (const property of definition.properties) {
    const value = current[property.key];
    if (!fitsProperty(property, value)) {
      config[property.key] = property.default;
    } else {
      config[property.key] = property.kind === 'displays' ? displayList(value as unknown[]) : value;
    }
  }
  return config;
}
