// The plugins' client side: their modules, listed by the server (GET
// /api/plugins), imported before the page renders, and their stylesheets.
// They share React and tassello/sdk with the page through the import map of
// index.html (see vite.config.ts).

import type { PluginInfo } from '../shared/protocol.ts';
import { api } from './api.ts';
import { registerPlugin } from './widgets/registry.ts';
import type { TasselloClientPlugin } from './widgets/types.ts';

let loaded: PluginInfo[] = [];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function plugins(): PluginInfo[] {
  return loaded;
}

// Returns what went wrong, plugin by plugin: the others load all the same
export async function loadPlugins(): Promise<string[]> {
  try {
    loaded = await api.listPlugins();
  } catch (e) {
    return [`The plugins could not be listed: ${errorMessage(e)}`];
  }
  const problems = loaded.flatMap((plugin) =>
    plugin.error ? [`Plugin ${plugin.name}: its server side did not start: ${plugin.error}`] : [],
  );
  for (const plugin of loaded) {
    for (const href of plugin.styles) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.append(link);
    }
  }
  // Fetched together, registered in the server's order
  const modules = await Promise.allSettled(
    loaded.map((plugin) => (plugin.client ? import(/* @vite-ignore */ plugin.client) : Promise.resolve(null))),
  );
  modules.forEach((result, i) => {
    const { name } = loaded[i];
    if (result.status === 'rejected') {
      problems.push(`Plugin ${name} did not load: ${errorMessage(result.reason)}`);
      return;
    }
    if (result.value === null) {
      return;
    }
    const plugin = (result.value as { default?: unknown }).default;
    if (typeof plugin !== 'object' || plugin === null) {
      problems.push(`Plugin ${name}: its client module has no default export (definePlugin({ widgets }))`);
      return;
    }
    for (const problem of registerPlugin(name, plugin as TasselloClientPlugin)) {
      problems.push(`Plugin ${name}: ${problem}`);
    }
  });
  return problems;
}
