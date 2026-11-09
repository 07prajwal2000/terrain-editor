// Live 3D preview for the terrain editor. Uses the game's own loader (loadMapFromData) on the SAME arrays the exporter would write
// (the editor fills them with its export conversion functions; only the PNG encode/decode is skipped), the shared sky/light/fog setup
// (src/world/sceneEnv.js) and the shared marker pins (src/world/markerPins.js).
//
// api (provided by the editor):
//   info()        -> map.json object            newBuffers() -> { h16, w16, s0, s1 } (full-size export arrays)
//   fill(b, rect) -> refill rect of b from the editor data (rect {x0,y0,x1,y1}, x1/y1 exclusive)
//   roads()       -> roads.json object          markers()    -> markers.json object
//   onRoadsRebuilt?() called after every road rebuild of the preview map (the 2D view redraws the auto bridges from map.roadDetail.autoBridges)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadMapFromData } from '../world/mapLoader.js';
import { createRenderer, setupSky, applyFog } from '../world/sceneEnv.js';
import { createMarkerPins } from '../world/markerPins.js';

const THROTTLE_MS = 100;
const EMPTY = { x0: 0, y0: 0, x1: 0, y1: 0 };

export function createPreview(host, api) {
  const renderer = createRenderer(THREE);
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  setupSky(THREE, scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 60000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = 1.52;
  const world = new THREE.Group(); world.name = 'previewWorld'; // vertical exaggeration scales this group (ponytail: the terrain shader's rock tint uses unscaled normals)
  scene.add(world);

  let map = null, pins = null, buf = null, visible = false, needsRender = true, ringDirty = true, timer = null, lastFlush = 0, lastAnim = 0;
  let pending = { rect: null, full: true };
  let brush = null, exag = 1, markersVisible = true;
  const toggles = { water: true, roads: true, edges: true, signs: true, wire: false };
  const stats = { lastUpdateMs: 0, lastFullMs: 0, updates: 0, renders: 0 };

  // brush ring: 64 points draped on the terrain
  const ringGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
  const ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0xffffff, fog: false }));
  ring.visible = false; ring.frustumCulled = false; ring.renderOrder = 5; world.add(ring);

  function applyToggles() {
    if (!map) return;
    map.parts.ocean.visible = toggles.water; if (map.parts.lakes) map.parts.lakes.visible = toggles.water;
    if (map.parts.roadGroup) map.parts.roadGroup.visible = toggles.roads;
    if (map.parts.roadEdges) { map.parts.roadEdges.visible = toggles.edges; map.parts.roadProps.visible = toggles.edges; map.parts.roadSigns.visible = toggles.signs; }
    map.parts.material.wireframe = toggles.wire;
    if (pins) pins.group.visible = markersVisible;
    world.scale.y = exag;
  }

  function placeCamera(W, maxH) {
    camera.far = W * 12; camera.updateProjectionMatrix();
    camera.position.set(W * 0.5, maxH * 1.6 + 60, W * 1.2);
    controls.target.set(W * 0.5, maxH * 0.15, W * 0.45);
    controls.minDistance = 3; controls.maxDistance = W * 6;
    controls.update();
  }

  function build(info) {
    const t0 = performance.now(), first = !map, oldW = map && map.info.worldSize;
    if (map) { world.remove(map.group); map.dispose(); }
    if (pins) { world.remove(pins.group); pins.dispose(); }
    buf = api.newBuffers();
    api.fill(buf, { x0: 0, y0: 0, x1: info.N, y1: info.N });
    map = loadMapFromData({ info, height: buf.h16, splat0: buf.s0, splat1: buf.s1, water: buf.w16, roads: api.roads(), markers: api.markers() }, { THREE, physics: false });
    world.add(map.group);
    const W = map.info.worldSize;
    pins = createMarkerPins(THREE, { heightAt: map.heightAt, size: Math.max(2, W * 0.012) });
    pins.setMarkers(map.markers); world.add(pins.group);
    map.onRebuild = () => { pins.setMarkers(map.markers); ringDirty = true; needsRender = true; if (api.onRoadsRebuilt) api.onRoadsRebuilt(); };
    if (api.onRoadsRebuilt) api.onRoadsRebuilt();
    applyFog(THREE, scene, W);
    if (first || oldW !== W) placeCamera(W, map.info.maxHeight);
    applyToggles();
    stats.lastFullMs = performance.now() - t0;
  }

  function flush() {
    timer = null;
    if (!visible) return;
    const t0 = performance.now(), info = api.info();
    if (pending.full || !map || info.N !== map.info.N || info.worldSizeMeters !== map.info.worldSize || info.maxHeightMeters !== map.info.maxHeight
      || (info.driveSide || 'right') !== map.info.driveSide || (info.signStyle || 'us') !== map.info.signStyle) build(info);
    else {
      if (info.seaLevelMeters !== map.info.seaLevel) map.setSeaLevel(info.seaLevelMeters);
      const r = pending.rect;
      if (r) api.fill(buf, r);
      const res = map.updateRegion(r || EMPTY, { height: buf.h16, splat: [buf.s0, buf.s1], water: buf.w16, roads: api.roads(), markers: api.markers() });
      if (res.markers || res.height) pins.setMarkers(map.markers);
      applyToggles();
      stats.updates++;
    }
    pending = { rect: null, full: false };
    lastFlush = performance.now(); stats.lastUpdateMs = lastFlush - t0;
    ringDirty = true; needsRender = true;
  }
  function schedule() {
    if (!visible || timer) return;
    timer = setTimeout(flush, Math.max(0, THROTTLE_MS - (performance.now() - lastFlush))); // leading + trailing throttle
  }

  function updateRing() {
    ringDirty = false;
    if (!map || !brush) { ring.visible = false; return; }
    const W = map.info.worldSize, pos = ringGeo.attributes.position.array;
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * 2 * Math.PI, x = Math.min(W, Math.max(0, brush.x + Math.cos(a) * brush.r)), z = Math.min(W, Math.max(0, brush.z + Math.sin(a) * brush.r));
      pos[i * 3] = x; pos[i * 3 + 1] = map.heightAt(x, z); pos[i * 3 + 2] = z;
    }
    ringGeo.attributes.position.needsUpdate = true;
    ring.position.y = Math.max(0.5, camera.position.distanceTo(controls.target) * 0.004); // keep it above the surface at any zoom
    ring.visible = true;
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); needsRender = true;
  }
  new ResizeObserver(resize).observe(host);
  controls.addEventListener('change', () => { needsRender = true; ringDirty = true; });
  (function loop() {
    requestAnimationFrame(loop);
    if (!visible || !map) return;
    const now = performance.now(); // signal lights of 'signals' junctions: ~15 fps clock + re-render, only when the map has any
    if (map.roadDetail && map.roadDetail.counts.signalPosts > 0 && now - lastAnim > 66) { map.update(Math.min(0.25, (now - lastAnim) / 1000)); lastAnim = now; needsRender = true; }
    if (ringDirty) { updateRing(); needsRender = true; }
    if (needsRender) { needsRender = false; renderer.render(scene, camera); stats.renders++; }
  })();

  return {
    renderer, camera, controls, stats,
    get map() { return map; },
    setVisible(v) { visible = v; if (v) { resize(); if (timer) clearTimeout(timer); flush(); } },
    // rect = pixel rect that changed (exclusive x1/y1) or null for roads/markers/sea-level/world-size changes only
    invalidate(rect) {
      if (rect) {
        const r = pending.rect;
        pending.rect = r ? { x0: Math.min(r.x0, rect.x0), y0: Math.min(r.y0, rect.y0), x1: Math.max(r.x1, rect.x1), y1: Math.max(r.y1, rect.y1) } : { ...rect };
      }
      schedule();
    },
    invalidateAll() { pending.full = true; schedule(); },
    flushNow() { if (timer) clearTimeout(timer); flush(); },
    setBrush(b) { brush = b; ringDirty = true; },
    setExaggeration(k) { exag = k; applyToggles(); needsRender = true; ringDirty = true; },
    setToggle(name, v) { toggles[name] = v; applyToggles(); needsRender = true; },
    setMarkersVisible(v) { markersVisible = v; applyToggles(); needsRender = true; },
  };
}
