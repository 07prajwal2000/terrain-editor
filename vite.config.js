import { defineConfig } from 'vite';
import { resolve } from 'node:path';
// rapier3d-compat inlines its wasm, but pre-bundling mangles top-level await in some versions; keep it simple.
// Pages: the dev viewer (index.html), the terrain editor (editor.html),
// the garage (garage.html) and the game (play.html).
export default defineConfig({
  server: { host: '127.0.0.1' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), editor: resolve(import.meta.dirname, 'editor.html'), garage: resolve(import.meta.dirname, 'garage.html'), play: resolve(import.meta.dirname, 'play.html') } } },
});
