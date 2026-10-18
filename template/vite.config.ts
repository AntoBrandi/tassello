import { defineConfig } from 'vite';
import { tassello } from 'tassello/vite';

// Builds src/client/index.tsx into dist/client: see tassello/vite
export default defineConfig({
  plugins: [tassello()],
});
