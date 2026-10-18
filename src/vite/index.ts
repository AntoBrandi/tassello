// tassello/vite: builds the client module of a Tassello plugin.
//
//   // vite.config.ts
//   import { defineConfig } from 'vite';
//   import { tassello } from 'tassello/vite';
//
//   export default defineConfig({ plugins: [tassello()] });
//
// builds src/client/index.tsx (or the entry given) into dist/client/index.js,
// and its styles into dist/client/index.css: an ES module that imports React
// and tassello/sdk as the page provides them (its import map), instead of
// bundling copies. Name them in package.json:
//
//   "tassello": { "client": "dist/client/index.js", "styles": ["dist/client/index.css"] }

import type { Plugin } from 'vite';

// What the page shares with the plugins (see Tassello's vite.config.ts)
export const SHARED_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'tassello/sdk'];

export interface TasselloPluginOptions {
  // The client module's source, src/client/index.tsx by default
  entry?: string;
  // Where it is built, dist/client by default: the whole folder is served
  outDir?: string;
}

export function tassello(options: TasselloPluginOptions = {}): Plugin {
  return {
    name: 'tassello-plugin',
    // What the Vite configuration or command line sets wins, e.g. --outDir
    config: (config) => ({
      // The browser runs it as it is: no process.env there
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      // JSX through React's automatic runtime, as the page's own
      oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
      build: {
        outDir: config.build?.outDir ?? options.outDir ?? 'dist/client',
        emptyOutDir: config.build?.emptyOutDir ?? true,
        lib: {
          entry: options.entry ?? 'src/client/index.tsx',
          formats: ['es'],
          fileName: 'index',
          cssFileName: 'index',
        },
        rolldownOptions: {
          external: (id: string) => SHARED_MODULES.includes(id),
        },
      },
    }),
  };
}
