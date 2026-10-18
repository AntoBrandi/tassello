// The widgets of the palette: Tassello's own, then those of the plugins
// (see ../plugins.ts), which may also change the defaults of any widget's
// properties, e.g. a robot's topic names and speed limits.

import type { Property, RegisteredWidget, TasselloClientPlugin } from './types.ts';

export interface WidgetEntry {
  definition: RegisteredWidget;
  // The plugin that adds it, null for Tassello's own
  plugin: string | null;
}

export function fitsProperty(property: Property, value: unknown): boolean {
  return (
    typeof value === typeof property.default &&
    (property.kind !== 'select' || property.options.some((o) => o.value === value)) &&
    (typeof value !== 'number' || Number.isFinite(value))
  );
}

export class WidgetRegistry {
  // As registered, before the defaults' changes
  private registered: WidgetEntry[];
  // New defaults, by widget type then property key
  private readonly defaults = new Map<string, Map<string, unknown>>();
  private current: WidgetEntry[];

  constructor(core: RegisteredWidget[]) {
    this.registered = core.map((definition) => ({ definition, plugin: null }));
    this.current = this.registered;
  }

  // Adds a plugin's widgets and defaults; returns what was wrong with them
  registerPlugin(name: string, plugin: TasselloClientPlugin): string[] {
    const problems: string[] = [];
    for (const definition of plugin.widgets ?? []) {
      const existing = this.registered.find((entry) => entry.definition.type === definition.type);
      if (existing) {
        problems.push(
          `its widget type "${definition.type}" is already ${existing.plugin ? `${existing.plugin}'s` : "Tassello's"}`,
        );
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
        // Of a widget not registered (yet): kept, in case a later plugin adds it
        if (definition && (!property || !fitsProperty(property, value))) {
          problems.push(`its default of ${type}.${key} is not one of the property's values`);
        }
      }
      this.defaults.set(type, own);
    }
    this.current = this.registered.map((entry) => ({ ...entry, definition: this.withDefaults(entry.definition) }));
    return problems;
  }

  entries(): WidgetEntry[] {
    return this.current;
  }

  definition(type: string): RegisteredWidget | undefined {
    return this.current.find((entry) => entry.definition.type === type)?.definition;
  }

  private withDefaults(definition: RegisteredWidget): RegisteredWidget {
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

// The widget's config with every property: stored values of the right type,
// defaults for the others
export function resolveConfig(definition: RegisteredWidget, stored: Record<string, unknown>) {
  const config: Record<string, unknown> = {};
  for (const property of definition.properties) {
    const value = stored[property.key];
    config[property.key] = fitsProperty(property, value) ? value : property.default;
  }
  return config;
}
