// Web Worker for cityFill.js: builds windowAtlas textures off the main thread (each costs ~50-100 ms in the browser).
//   postMessage({ id, key, opts }) -> { id, data, emissive, width, height, cells } (buffers transferred)
import { textureFromKey } from './windowAtlas.js';
self.onmessage = ({ data: { id, key, opts } }) => {
  const t = textureFromKey(key, opts);
  self.postMessage({ id, data: t.data, emissive: t.emissive, width: t.width, height: t.height, cells: t.cells }, [t.data.buffer, t.emissive.buffer]);
};
