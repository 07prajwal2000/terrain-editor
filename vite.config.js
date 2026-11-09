import { defineConfig } from 'vite';
import { resolve } from 'node:path';
// rapier3d-compat inlines its wasm, but pre-bundling mangles top-level await in some versions; keep it simple.
// Pages (garage.html = car selection, play.html = drive a car on a map):
// Two pages: the dev viewer (index.html) and the terrain editor with live 3D preview (editor.html -> /editor.html).
export default defineConfig({
  server: { host: '127.0.0.1' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), editor: resolve(import.meta.dirname, 'editor.html'), garage: resolve(import.meta.dirname, 'garage.html'), play: resolve(import.meta.dirname, 'play.html') } } },
});
