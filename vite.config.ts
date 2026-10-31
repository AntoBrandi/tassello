import { createRequire } from 'node:module';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The server the development page (npm run dev) talks to: `npm run server`, or
// any running dashboard, e.g. DASHBOARD_SERVER=http://myrobot.local:8080
const server = process.env.DASHBOARD_SERVER ?? 'http://localhost:8080';

// The modules the page shares with the plugins' client modules, which import
// them by these names (src/vite/index.ts keeps them external): the import map
// of the page maps each name to the page's own, so that there is one React,
// one connection and one three.js. By name, the module that provides it and
// its entry in the build. three and tassello/viewer are fetched only when a
// plugin's display is shown.
const SHARED: Record<string, { id: string; entry: string }> = {
  react: { id: 'virtual:shared/react', entry: 'shared/react' },
  'react/jsx-runtime': { id: 'virtual:shared/react/jsx-runtime', entry: 'shared/react/jsx-runtime' },
  'react-dom': { id: 'virtual:shared/react-dom', entry: 'shared/react-dom' },
  'react-dom/client': { id: 'virtual:shared/react-dom/client', entry: 'shared/react-dom/client' },
  'tassello/sdk': { id: '/src/client/sdk/index.ts', entry: 'shared/tassello-sdk' },
  'tassello/viewer': { id: '/src/client/sdk/viewer.ts', entry: 'shared/tassello-viewer' },
  three: { id: '/src/client/sdk/three.ts', entry: 'shared/three' },
};

// The page's entries for the shared modules, and the import map that names
// them. React's packages are CommonJS: their entries re-export them by name.
function sharedModules(): Plugin {
  const require = createRequire(import.meta.url);
  const entries: Record<string, string> = Object.fromEntries(Object.values(SHARED).map(({ id, entry }) => [entry, id]));
  return {
    name: 'tassello-shared-modules',
    config: () => ({ build: { rolldownOptions: { input: { index: 'index.html', ...entries } } } }),
    resolveId: (id) => (id.startsWith('virtual:shared/') ? `\0${id}` : undefined),
    load(id) {
      if (!id.startsWith('\0virtual:shared/')) {
        return undefined;
      }
      const name = id.slice('\0virtual:shared/'.length);
      const exports = Object.keys(require(name) as object).filter((key) => key !== 'default');
      return `import m from '${name}';\nexport default m;\nexport const { ${exports.join(', ')} } = m;\n`;
    },
    transformIndexHtml(_html, context) {
      const imports = Object.fromEntries(
        Object.entries(SHARED).map(([name, { id, entry }]) => [
          name,
          context.server ? (id.startsWith('virtual:') ? `/@id/__x00__${id}` : id) : `/assets/${entry}.js`,
        ]),
      );
      return [
        {
          tag: 'script',
          attrs: { type: 'importmap' },
          children: JSON.stringify({ imports }, null, 2),
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), sharedModules()],
  build: {
    outDir: 'dist/www',
    // The robot model's chunk, three.js mostly, is that large; it is only
    // fetched by the panels that show one
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      // The shared modules' entries keep their exports
      preserveEntrySignatures: 'exports-only',
      // No content hash in the file names: the import map names the shared
      // modules' entries, and the server has browsers revalidate every file
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    proxy: {
      '/api': server,
      '/plugins': server,
      '/ws': { target: server, ws: true },
    },
  },
});
