/**
 * Galactic map — the Super Destroyer's war table.
 *
 * Styled after the game's holographic galaxy projection: a cyan hologram of the
 * galactic plane on a dark table, viewed obliquely, with sector groupings drawn
 * as glowing hulls, supply lines strung between worlds, and planets rendered as
 * additive light rather than lit rock. Everything luminous composites with
 * `lighter`, which is what makes overlapping glow read as a projection instead
 * of as stacked stickers.
 *
 * On the third dimension, honestly
 * ------------------------------------------------------------------
 * The API publishes two coordinates per planet and no depth. Scattering worlds
 * along an invented z-axis would look like data and be nothing of the kind, so
 * every planet sits at its true position on the plane, exactly as in game. Only
 * worlds with a live campaign lift slightly off it — mirroring the floating
 * objective markers the game hangs above contested planets — and each keeps a
 * footprint and tether below so its real position stays unambiguous.
 *
 * Rendered by a small software projector onto a 2D canvas rather than WebGL:
 * the scene is a few thousand points and lines, the project has no build step
 * and no dependencies, and baking each planet to a cached sprite makes the cost
 * one drawImage per world.
 */

import { biomeColor, faction } from '../config.js';
import { selectPlanet, state, subscribe } from '../state.js';
import { compact, percent } from '../format.js';

const canvas = document.getElementById('galaxy');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('map-tooltip');
const zoomReadout = document.getElementById('zoom-readout');

/* --------------------------------------------------------------- constants */

/** Distance at which the whole galaxy frames neatly; the zoom readout's 1.00x. */
const BASE_DISTANCE = 3.1;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 14;
const FOV = 42 * (Math.PI / 180);

/** Elevation is clamped short of vertical: the poles are a singularity. */
const MIN_ELEVATION = 4 * (Math.PI / 180);
const MAX_ELEVATION = 88 * (Math.PI / 180);
/** Low and oblique, the angle you read a table projection from. */
const DEFAULT_ELEVATION = 27 * (Math.PI / 180);

const PLANET_RADIUS = 0.013;
const HIT_PADDING = 10;

/** The hologram's own palette. Faction colours ride on top of this. */
const HOLO = {
  base: '#4fd8ff',
  deep: '#1b7fa8',
  grid: 'rgba(79, 216, 255, 0.13)',
  gridFaint: 'rgba(79, 216, 255, 0.06)',
  hull: 'rgba(96, 200, 240, 0.34)',
  hullFill: 'rgba(30, 110, 155, 0.10)',
  label: 'rgba(168, 232, 255, 0.8)',
};

const view = {
  azimuth: -0.55,
  elevation: DEFAULT_ELEVATION,
  distance: BASE_DISTANCE,
  /** Look-at point, on or near the galactic plane. */
  target: { x: 0, y: 0, z: 0 },
};

let width = 0;
let height = 0;
let dpr = 1;
let focal = 1;

let hovered = null;
let needsDraw = true;
let animating = true;
let hasFitted = false;
let userMovedView = false;

/* -------------------------------------------------------------------- math */

function normalize(v) {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * A planet's world position: the API plane becomes XZ, with Y as height.
 * The y axis is negated so north stays up when the camera looks from +Z.
 */
function worldOf(planet, lift = true) {
  return {
    x: planet.position.x,
    y: lift ? planetHeight(planet) : 0,
    z: -planet.position.y,
  };
}

/**
 * Height above the plane.
 *
 * The game's map is flat; what floats above it are the objective markers on
 * contested worlds. So only planets with a live campaign lift, and only a
 * little — enough to separate a battle from the plane, not enough to turn the
 * galaxy into a bar chart. Scaled by garrison so the heaviest fronts sit
 * highest.
 */
function planetHeight(planet) {
  if (!planet.campaign && !planet.event) return 0;
  const players = Math.max(planet.players || 0, 1);
  return 0.035 + Math.min(0.075, Math.log10(Math.max(players, 100) / 100) * 0.026);
}

/** Camera basis, rebuilt whenever the view changes. */
let camera = { eye: { x: 0, y: 0, z: 0 }, right: null, up: null, forward: null };

function updateCamera() {
  const { azimuth, elevation, distance, target } = view;
  const cosE = Math.cos(elevation);
  const eye = {
    x: target.x + distance * cosE * Math.sin(azimuth),
    y: target.y + distance * Math.sin(elevation),
    z: target.z + distance * cosE * Math.cos(azimuth),
  };
  const forward = normalize({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
  const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = cross(right, forward);
  camera = { eye, forward, right, up };
  focal = (height / 2) / Math.tan(FOV / 2);
}

const NEAR = 0.05;

/**
 * World point to screen. Anything at or behind the near plane comes back
 * `visible: false` rather than projected, since dividing by a negative depth
 * mirrors geometry behind the camera into the middle of the scene.
 */
function project(p) {
  const dx = p.x - camera.eye.x;
  const dy = p.y - camera.eye.y;
  const dz = p.z - camera.eye.z;
  const depth = dx * camera.forward.x + dy * camera.forward.y + dz * camera.forward.z;
  if (depth <= NEAR) return { visible: false, depth };
  const vx = dx * camera.right.x + dy * camera.right.y + dz * camera.right.z;
  const vy = dx * camera.up.x + dy * camera.up.y + dz * camera.up.z;
  const scale = focal / depth;
  return {
    visible: true,
    depth,
    scale,
    x: width / 2 + vx * scale,
    y: height / 2 - vy * scale,
  };
}

/**
 * Atmospheric depth. A projection this size needs the far rim to recede or the
 * whole disc reads as flat pattern; near things stay full strength.
 */
function fog(depth) {
  const near = view.distance * 0.55;
  const far = view.distance * 2.1;
  if (depth <= near) return 1;
  return clamp(1 - (depth - near) / (far - near), 0.18, 1);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ----------------------------------------------------------- sprite cache */

/**
 * Planets are baked once per colour and blitted thereafter. Building the
 * gradients fresh for 260 worlds every frame is what would actually cost
 * something here; drawImage of a cached bitmap costs nothing.
 *
 * The sprite is additive light: a hot near-white core, a faction-tinted bloom,
 * and a containment ring — a projected point of light, not a lit sphere.
 */
const SPRITE_SIZE = 128;
const CORE_FRACTION = 0.115;
const spriteCache = new Map();

function planetSprite(coreColor, glowColor) {
  const key = `${coreColor}|${glowColor}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  const g = c.getContext('2d');
  const mid = SPRITE_SIZE / 2;
  const core = SPRITE_SIZE * CORE_FRACTION;

  // Outer bloom — the halo that makes crowded space glow rather than clutter.
  const bloom = g.createRadialGradient(mid, mid, core * 0.5, mid, mid, mid);
  bloom.addColorStop(0, withAlpha(glowColor, 0.34));
  bloom.addColorStop(0.22, withAlpha(glowColor, 0.11));
  bloom.addColorStop(0.6, withAlpha(glowColor, 0.025));
  bloom.addColorStop(1, withAlpha(glowColor, 0));
  g.fillStyle = bloom;
  g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // Core: hot centre falling to the planet's own tint, so biome still reads.
  const body = g.createRadialGradient(mid, mid, 0, mid, mid, core);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.35, lighten(coreColor, 0.55));
  body.addColorStop(1, withAlpha(coreColor, 0.85));
  g.fillStyle = body;
  g.beginPath();
  g.arc(mid, mid, core, 0, Math.PI * 2);
  g.fill();

  // Containment ring, a little clear of the core.
  g.strokeStyle = withAlpha(glowColor, 0.75);
  g.lineWidth = SPRITE_SIZE * 0.008;
  g.beginPath();
  g.arc(mid, mid, core * 1.85, 0, Math.PI * 2);
  g.stroke();

  spriteCache.set(key, c);
  return c;
}

/* Colour helpers, kept local so the palette stays plain hex in config.js. */

function parseHex(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function withAlpha(hex, alpha) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Returns hex, not `rgb()`, so the result can be fed straight back into
 * parseHex — the palette helpers compose, and a lightened colour is still a
 * valid input to withAlpha().
 */
function lighten(hex, amount) {
  const { r, g, b } = parseHex(hex);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return toHex(mix(r), mix(g), mix(b));
}

function toHex(r, g, b) {
  const pair = (c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/* --------------------------------------------------------------- starfield */

/** Deterministic, so the sky does not reshuffle on every resize. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARS = (() => {
  const rng = seeded(0x5e4);
  const stars = [];
  for (let i = 0; i < 360; i++) {
    const u = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    stars.push({
      x: r * Math.cos(theta) * 14,
      y: u * 14,
      z: r * Math.sin(theta) * 14,
      size: 0.4 + rng() * 1.1,
      alpha: 0.16 + rng() * 0.4,
    });
  }
  return stars;
})();

/**
 * Dust motes drifting in the projection volume. A hologram reads as a volume
 * rather than a decal when there is something suspended inside it.
 */
const MOTES = (() => {
  const rng = seeded(0xd0f7);
  const motes = [];
  for (let i = 0; i < 90; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = 0.15 + rng() * 1.15;
    motes.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      baseY: rng() * 0.34,
      phase: rng() * Math.PI * 2,
      alpha: 0.1 + rng() * 0.28,
    });
  }
  return motes;
})();

/* ---------------------------------------------------------- sector shapes */

/**
 * Sector hulls, the way the game groups worlds into named regions.
 *
 * Rebuilt only when the planet list changes: convex hulls over ~40 sectors are
 * cheap but pointless to recompute every frame.
 */
let sectorShapes = [];
let sectorSource = null;

function buildSectors(planets) {
  const bySector = new Map();
  for (const planet of planets) {
    const name = planet.sector || 'Unknown';
    if (!bySector.has(name)) bySector.set(name, []);
    bySector.get(name).push({ x: planet.position.x, z: -planet.position.y });
  }

  const shapes = [];
  for (const [name, points] of bySector) {
    if (points.length < 3) continue;
    const hull = convexHull(points);
    if (hull.length < 3) continue;

    const centroid = hull.reduce(
      (acc, p) => ({ x: acc.x + p.x / hull.length, z: acc.z + p.z / hull.length }),
      { x: 0, z: 0 },
    );
    // Push the boundary clear of the worlds it encloses.
    const padded = hull.map((p) => {
      const dx = p.x - centroid.x;
      const dz = p.z - centroid.z;
      const length = Math.hypot(dx, dz) || 1;
      return { x: p.x + (dx / length) * 0.045, z: p.z + (dz / length) * 0.045 };
    });
    shapes.push({ name, points: padded, centroid, size: points.length });
  }
  return shapes;
}

/** Andrew's monotone chain. Returns the hull counter-clockwise. */
function convexHull(points) {
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.z - b.z));
  if (sorted.length < 3) return sorted;
  const cross2 = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function ensureSectors() {
  if (sectorSource === state.planets) return;
  sectorSource = state.planets;
  sectorShapes = buildSectors(state.planets);
}

/* ------------------------------------------------------------------ sizing */

/** Scanline overlay, baked once and tiled — cheaper than stroking every row. */
let scanlinePattern = null;

function buildScanlines() {
  const tile = document.createElement('canvas');
  tile.width = 1;
  tile.height = 3;
  const g = tile.getContext('2d');
  g.fillStyle = 'rgba(120, 200, 240, 0.055)';
  g.fillRect(0, 0, 1, 1);
  scanlinePattern = ctx.createPattern(tile, 'repeat');
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = rect.width;
  height = rect.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!scanlinePattern) buildScanlines();
  if (!userMovedView) {
    view.target = { x: 0, y: 0, z: 0 };
    view.distance = BASE_DISTANCE;
    hasFitted = fitToPlanets();
  }
  needsDraw = true;
}

/* ----------------------------------------------------------------- drawing */

function draw(now) {
  if (!width || !height) return;
  updateCamera();
  ensureSectors();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  drawTable();
  drawStars();

  if (!state.planets.length) {
    drawEmptyState();
    drawOverlay(now);
    return;
  }

  // Everything luminous composites additively: overlapping glow brightens the
  // way projected light does, instead of the nearest sprite simply winning.
  drawSectors();

  ctx.globalCompositeOperation = 'lighter';
  drawCoreHaze();
  drawGrid(now);
  drawSupplyLines();
  drawMotes(now);
  drawTethers();
  drawAttacks(now);
  drawSuperEarth(now);
  const drawn = drawPlanets(now);
  ctx.globalCompositeOperation = 'source-over';

  drawLabels(drawn, drawSectorLabels());
  drawOverlay(now);

  if (zoomReadout) zoomReadout.textContent = `${(BASE_DISTANCE / view.distance).toFixed(2)}×`;
}

/** The dark table the projection stands on. */
function drawTable() {
  const gradient = ctx.createRadialGradient(
    width / 2, height * 0.56, 0,
    width / 2, height * 0.56, Math.max(width, height) * 0.78,
  );
  gradient.addColorStop(0, 'rgba(12, 34, 52, 0.95)');
  gradient.addColorStop(0.55, 'rgba(6, 16, 26, 0.75)');
  gradient.addColorStop(1, 'rgba(2, 5, 9, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawStars() {
  for (const star of STARS) {
    const p = project(star);
    if (!p.visible || p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
    ctx.fillStyle = `rgba(190, 226, 245, ${star.alpha})`;
    ctx.fillRect(p.x, p.y, star.size, star.size);
  }
}

/** The bright galactic core, projected onto the plane. */
function drawCoreHaze() {
  const centre = project({ x: 0, y: 0, z: 0 });
  const edge = project({ x: 0.85, y: 0, z: 0 });
  if (!centre.visible || !edge.visible) return;
  const radius = Math.max(40, Math.hypot(edge.x - centre.x, edge.y - centre.y));
  const gradient = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
  gradient.addColorStop(0, 'rgba(56, 132, 180, 0.085)');
  gradient.addColorStop(0.45, 'rgba(38, 100, 145, 0.035)');
  gradient.addColorStop(1, 'rgba(20, 60, 100, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrid(now) {
  ctx.lineWidth = 1;
  for (let r = 0.25; r <= 1.3; r += 0.25) {
    ctx.strokeStyle = r > 1.2 ? HOLO.gridFaint : HOLO.grid;
    ringPath(r);
    ctx.stroke();
  }

  ctx.strokeStyle = HOLO.gridFaint;
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const a = project({ x: 0, y: 0, z: 0 });
    const b = project({ x: Math.cos(angle) * 1.3, y: 0, z: Math.sin(angle) * 1.3 });
    if (!a.visible || !b.visible) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Sweep line, on the plane rather than the screen, so it belongs to the world
  // once the view is tilted.
  if (animating) {
    const angle = (now / 9000) % (Math.PI * 2);
    const a = project({ x: 0, y: 0, z: 0 });
    const b = project({ x: Math.cos(angle) * 1.3, y: 0, z: Math.sin(angle) * 1.3 });
    if (a.visible && b.visible) {
      const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      gradient.addColorStop(0, 'rgba(120, 220, 255, 0.20)');
      gradient.addColorStop(1, 'rgba(120, 220, 255, 0)');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

function ringPath(radius, segments = 84) {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const p = project({ x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius });
    if (!p.visible) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; } else { ctx.lineTo(p.x, p.y); }
  }
}

/**
 * Sector hulls: soft-cornered regions enclosing the worlds of each sector, the
 * way the game groups them. Corners are rounded through the midpoints of the
 * hull edges, which turns a spiky polygon into something that reads as a region.
 */
function drawSectors() {
  for (const shape of sectorShapes) {
    const projected = shape.points.map((p) => project({ x: p.x, y: 0, z: p.z }));
    if (projected.some((p) => !p.visible)) continue;
    if (projected.every((p) => offscreen(p, 60))) continue;

    ctx.beginPath();
    const n = projected.length;
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let start = mid(projected[n - 1], projected[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < n; i++) {
      const control = projected[i];
      const end = mid(projected[i], projected[(i + 1) % n]);
      ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
    }
    ctx.closePath();

    const depth = projected.reduce((sum, p) => sum + p.depth, 0) / n;
    ctx.globalAlpha = fog(depth);
    ctx.fillStyle = HOLO.hullFill;
    ctx.fill();
    ctx.strokeStyle = HOLO.hull;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawSupplyLines() {
  const byIndex = state.planetsByIndex;
  ctx.lineWidth = 1;
  for (const line of state.supplyLines) {
    const a = byIndex.get(line.a);
    const b = byIndex.get(line.b);
    if (!a || !b) continue;
    const pa = project(worldOf(a, false));
    const pb = project(worldOf(b, false));
    if (!pa.visible || !pb.visible) continue;
    if (offscreen(pa) && offscreen(pb)) continue;
    ctx.globalAlpha = fog((pa.depth + pb.depth) / 2) * 0.26;
    ctx.strokeStyle = HOLO.base;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawMotes(now) {
  const t = animating ? now / 4200 : 0;
  for (const mote of MOTES) {
    const y = mote.baseY + Math.sin(t + mote.phase) * 0.03;
    const p = project({ x: mote.x, y, z: mote.z });
    if (!p.visible || offscreen(p)) continue;
    ctx.globalAlpha = mote.alpha * fog(p.depth);
    ctx.fillStyle = HOLO.base;
    ctx.fillRect(p.x, p.y, 1.4, 1.4);
  }
  ctx.globalAlpha = 1;
}

/** Footprint and tether under every contested world lifted off the plane. */
function drawTethers() {
  for (const planet of state.planets) {
    if (planetHeight(planet) <= 0) continue;
    const base = project(worldOf(planet, false));
    const top = project(worldOf(planet, true));
    if (!base.visible || !top.visible) continue;
    if (offscreen(base) && offscreen(top)) continue;

    const color = faction(planet.currentOwner).color;
    const alpha = fog(base.depth);
    const gradient = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
    gradient.addColorStop(0, withAlpha(color, 0.05 * alpha));
    gradient.addColorStop(1, withAlpha(color, 0.5 * alpha));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();

    // Objective footprint: a small ring on the plane, as the game marks them.
    ctx.strokeStyle = withAlpha(color, 0.4 * alpha);
    ctx.beginPath();
    ctx.arc(base.x, base.y, Math.max(2.5, 0.012 * base.scale), 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Attack arrows, arced over the plane.
 *
 * A straight line between two worlds lies flat and vanishes edge-on at the low
 * tilt this view uses; lifting the midpoint keeps the front line readable from
 * every angle and separates crossing routes.
 */
function drawAttacks(now) {
  const byIndex = state.planetsByIndex;

  for (const attack of state.attacks) {
    const source = byIndex.get(attack.source);
    const target = byIndex.get(attack.target);
    if (!source || !target) continue;

    const a = worldOf(source, false);
    const b = worldOf(target, false);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const lift = Math.min(0.22, 0.07 + span * 0.24);

    const points = [];
    const SEGMENTS = 26;
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const p = project({
        x: a.x + (b.x - a.x) * t,
        // Parabola through both endpoints, peaking at the midpoint.
        y: Math.sin(t * Math.PI) * lift,
        z: a.z + (b.z - a.z) * t,
      });
      if (!p.visible) { points.length = 0; break; }
      points.push(p);
    }
    if (points.length < 2) continue;

    const color = faction(attack.faction).color;
    const alpha = fog(points[Math.floor(points.length / 2)].depth);
    ctx.strokeStyle = color;
    ctx.globalAlpha = (attack.inferred ? 0.4 : 0.85) * alpha;
    ctx.lineWidth = attack.inferred ? 1.2 : 1.9;
    ctx.setLineDash(attack.inferred ? [3, 5] : [9, 6]);
    ctx.lineDashOffset = animating ? -(now / 45) % 15 : 0;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.setLineDash([]);

    const tip = points[points.length - 1];
    const prev = points[points.length - 3] || points[points.length - 2];
    const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    const size = clamp(tip.scale * 0.012, 5, 12);
    ctx.globalAlpha = (attack.inferred ? 0.55 : 1) * alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - Math.cos(angle - 0.42) * size, tip.y - Math.sin(angle - 0.42) * size);
    ctx.lineTo(tip.x - Math.cos(angle + 0.42) * size, tip.y - Math.sin(angle + 0.42) * size);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Super Earth: the projection's origin, and its brightest point. */
function drawSuperEarth(now) {
  const base = project({ x: 0, y: 0, z: 0 });
  if (!base.visible) return;
  const pulse = animating ? 0.5 + 0.5 * Math.sin(now / 900) : 0.7;
  const r = Math.max(3, 0.016 * base.scale);

  const top = project({ x: 0, y: 0.3, z: 0 });
  if (top.visible) {
    const beam = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
    beam.addColorStop(0, 'rgba(245, 210, 90, 0.5)');
    beam.addColorStop(1, 'rgba(245, 210, 90, 0)');
    ctx.strokeStyle = beam;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
  }

  const glow = ctx.createRadialGradient(base.x, base.y, 0, base.x, base.y, r * 6);
  glow.addColorStop(0, 'rgba(255, 226, 130, 0.6)');
  glow.addColorStop(1, 'rgba(255, 200, 40, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(base.x, base.y, r * 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(245, 197, 24, ${0.3 + pulse * 0.45})`;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(base.x, base.y, r * 2.6 + pulse * 3, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#fff3c4';
  ctx.beginPath();
  ctx.arc(base.x, base.y, r, 0, Math.PI * 2);
  ctx.fill();

  // The label is drawn with the rest, so it takes part in collision testing
  // instead of stamping itself over whatever planet name shares the spot.
  superEarthLabel = { x: base.x, y: base.y + r + 16 };
}

/** Screen position for Super Earth's caption, set each frame while drawing. */
let superEarthLabel = null;

/**
 * Planets, painted back to front.
 *
 * Returns what was drawn, in front-to-back order, so labels and hit testing
 * agree with what the viewer can actually see.
 */
function drawPlanets(now) {
  const selected = state.selectedPlanet;
  const drawn = [];

  for (const planet of state.planets) {
    const p = project(worldOf(planet));
    if (!p.visible) continue;
    const radius = Math.max(1.3, PLANET_RADIUS * p.scale);
    if (offscreen(p, radius + 40)) continue;
    drawn.push({ planet, p, radius });
  }

  drawn.sort((a, b) => b.p.depth - a.p.depth);

  for (const item of drawn) {
    const { planet, p, radius } = item;
    const info = faction(planet.currentOwner);
    const active = Boolean(planet.campaign || planet.event);
    const isSelected = selected === planet.index;
    const isHovered = hovered === planet.index;
    const alpha = fog(p.depth);

    ctx.globalAlpha = alpha;

    if (active && animating) {
      const phase = ((now / 1400) + planet.index * 0.13) % 1;
      ctx.strokeStyle = info.color;
      ctx.globalAlpha = (1 - phase) * 0.7 * alpha;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2 + phase * radius * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }

    // Biome tints the core; the faction owns the glow. Contested worlds burn
    // in their faction colour outright, which is how the game flags a fight.
    const core = active ? lighten(info.color, 0.35) : biomeColor(planet.biome);
    const sprite = planetSprite(core, info.color);
    const size = (radius / CORE_FRACTION) * (active ? 1.15 : 1);
    ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);

    if (active && planet.liberation > 0.5) {
      ctx.strokeStyle = planet.event ? '#ffd75e' : '#ffffff';
      ctx.lineWidth = Math.max(1.5, radius * 0.3);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.6, -Math.PI / 2,
        -Math.PI / 2 + (planet.liberation / 100) * Math.PI * 2);
      ctx.stroke();
    }

    if (isSelected || isHovered) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = isSelected ? 1.8 : 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 3.4, 0, Math.PI * 2);
      ctx.stroke();
      // Selection brackets, in the game's targeting idiom.
      if (isSelected) {
        const b = radius * 3.4;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.beginPath();
          ctx.moveTo(p.x + sx * b, p.y + sy * b * 0.55);
          ctx.lineTo(p.x + sx * b, p.y + sy * b);
          ctx.lineTo(p.x + sx * b * 0.55, p.y + sy * b);
          ctx.stroke();
        }
      }
    }
  }

  ctx.globalAlpha = 1;
  drawn.reverse();
  return drawn;
}

/**
 * Sector names on the plane.
 *
 * Collision-tested like the planet labels, largest sector first, and skipped
 * entirely for regions too small on screen to be worth naming. Returns the
 * boxes it claimed so planet labels can avoid them too.
 */
function drawSectorLabels() {
  const placed = [];
  const zoom = BASE_DISTANCE / view.distance;
  if (zoom < 0.75) return placed;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '600 9px "Saira Condensed", "Arial Narrow", sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';

  const candidates = [];
  for (const shape of sectorShapes) {
    if (shape.size < 3) continue;
    const p = project({ x: shape.centroid.x, y: 0, z: shape.centroid.z });
    if (!p.visible || offscreen(p, 40)) continue;

    // A sector too small on screen to hold its own name is better left unnamed.
    const projected = shape.points.map((q) => project({ x: q.x, y: 0, z: q.z }));
    if (projected.some((q) => !q.visible)) continue;
    const spanX = Math.max(...projected.map((q) => q.x)) - Math.min(...projected.map((q) => q.x));
    if (spanX < 64) continue;

    candidates.push({ shape, p, spanX });
  }

  // Bigger regions get first claim on the space.
  candidates.sort((a, b) => b.spanX - a.spanX);

  for (const { shape, p } of candidates) {
    const label = shape.name.toUpperCase();
    const w = ctx.measureText(label).width;
    const box = { x1: p.x - w / 2 - 3, y1: p.y - 9, x2: p.x + w / 2 + 3, y2: p.y + 4 };
    if (placed.some((o) => !(box.x2 < o.x1 || box.x1 > o.x2 || box.y2 < o.y1 || box.y1 > o.y2))) {
      continue;
    }
    placed.push(box);

    ctx.globalAlpha = fog(p.depth);
    ctx.fillStyle = 'rgba(2, 7, 12, 0.85)';
    ctx.fillText(label, p.x + 1, p.y + 1);
    ctx.fillStyle = HOLO.label;
    ctx.fillText(label, p.x, p.y);
  }

  ctx.globalAlpha = 1;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.restore();
  return placed;
}

/**
 * Labels, nearest first, skipping any that would collide with one already
 * placed. Without that a dense sector turns into an unreadable smear.
 */
function drawLabels(drawn, reserved = []) {
  const zoom = BASE_DISTANCE / view.distance;
  // Sector captions already claimed their space; planet names go around them.
  const placed = [...reserved];
  ctx.save();
  ctx.textAlign = 'center';

  if (superEarthLabel) {
    ctx.font = '700 10px "Saira Condensed", "Arial Narrow", sans-serif';
    const w = ctx.measureText('SUPER EARTH').width;
    placed.push({
      x1: superEarthLabel.x - w / 2 - 2, y1: superEarthLabel.y - 10,
      x2: superEarthLabel.x + w / 2 + 2, y2: superEarthLabel.y + 3,
    });
    ctx.fillStyle = 'rgba(3, 8, 14, 0.8)';
    ctx.fillText('SUPER EARTH', superEarthLabel.x + 1, superEarthLabel.y + 1);
    ctx.fillStyle = 'rgba(255, 214, 90, 0.95)';
    ctx.fillText('SUPER EARTH', superEarthLabel.x, superEarthLabel.y);
    superEarthLabel = null;
  }

  for (const { planet, p, radius } of drawn) {
    const active = Boolean(planet.campaign || planet.event);
    const focused = state.selectedPlanet === planet.index || hovered === planet.index;
    if (!active && !focused && zoom < 2.2) continue;

    const text = planet.name;
    ctx.font = `${active || focused ? 600 : 400} 10px "Saira Condensed", "Arial Narrow", sans-serif`;
    const w = ctx.measureText(text).width;
    const x = p.x;
    const y = p.y - radius * 2.8 - 6;
    const box = { x1: x - w / 2 - 2, y1: y - 10, x2: x + w / 2 + 2, y2: y + 3 };

    if (!focused && placed.some((o) => !(box.x2 < o.x1 || box.x1 > o.x2 || box.y2 < o.y1 || box.y1 > o.y2))) {
      continue;
    }
    placed.push(box);

    ctx.fillStyle = 'rgba(3, 8, 14, 0.8)';
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = active ? 'rgba(226, 248, 255, 0.97)' : 'rgba(168, 208, 232, 0.72)';
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/** Scanlines, a drifting refresh band and an edge vignette: the projection. */
function drawOverlay(now) {
  if (scanlinePattern) {
    ctx.fillStyle = scanlinePattern;
    ctx.fillRect(0, 0, width, height);
  }

  if (animating) {
    const bandY = ((now / 26) % (height + 260)) - 130;
    const band = ctx.createLinearGradient(0, bandY - 60, 0, bandY + 60);
    band.addColorStop(0, 'rgba(120, 220, 255, 0)');
    band.addColorStop(0.5, 'rgba(120, 220, 255, 0.045)');
    band.addColorStop(1, 'rgba(120, 220, 255, 0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, bandY - 60, width, 120);
  }

  const vignette = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.32,
    width / 2, height / 2, Math.max(width, height) * 0.78,
  );
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function drawEmptyState() {
  ctx.fillStyle = 'rgba(150, 200, 230, 0.4)';
  ctx.font = '600 13px "Saira Condensed", "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NO TELEMETRY', width / 2, height / 2);
}

function offscreen(p, margin = 8) {
  return p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin;
}

/* ------------------------------------------------------------- hit testing */

function planetAt(sx, sy) {
  let best = null;
  let bestDepth = Infinity;
  for (const planet of state.planets) {
    const p = project(worldOf(planet));
    if (!p.visible) continue;
    const radius = Math.max(1.3, PLANET_RADIUS * p.scale);
    const distance = Math.hypot(p.x - sx, p.y - sy);
    // Nearest to the camera wins a tie, matching what is drawn on top.
    if (distance < radius * 2 + HIT_PADDING && p.depth < bestDepth) {
      best = planet;
      bestDepth = p.depth;
    }
  }
  return best;
}

/* -------------------------------------------------------------- navigation */

const zoomToDistance = (zoom) => BASE_DISTANCE / clamp(zoom, MIN_ZOOM, MAX_ZOOM);

function zoomBy(factor) {
  userMovedView = true;
  const zoom = clamp((BASE_DISTANCE / view.distance) * factor, MIN_ZOOM, MAX_ZOOM);
  view.distance = BASE_DISTANCE / zoom;
  needsDraw = true;
}

function orbitBy(dAzimuth, dElevation) {
  userMovedView = true;
  view.azimuth += dAzimuth;
  view.elevation = clamp(view.elevation + dElevation, MIN_ELEVATION, MAX_ELEVATION);
  needsDraw = true;
}

/**
 * Slide the look-at point across the plane, as if dragging the scene by
 * (dx, dy) screen pixels. Shared by pointer panning and by auto-framing.
 */
function shiftTarget(dxScreen, dyScreen) {
  const perPixel = view.distance / focal;
  const heading = normalize({ x: camera.forward.x, y: 0, z: camera.forward.z });
  const right = camera.right;
  view.target.x -= (right.x * dxScreen - heading.x * dyScreen) * perPixel;
  view.target.z -= (right.z * dxScreen - heading.z * dyScreen) * perPixel;
  const limit = 2.2;
  view.target.x = clamp(view.target.x, -limit, limit);
  view.target.z = clamp(view.target.z, -limit, limit);
}

function panBy(dxScreen, dyScreen) {
  userMovedView = true;
  shiftTarget(dxScreen, dyScreen);
  needsDraw = true;
}

export function focusPlanet(index, { zoom } = {}) {
  const planet = state.planetsByIndex.get(index);
  if (!planet) return;
  userMovedView = true;
  const w = worldOf(planet, false);
  view.target.x = w.x;
  view.target.z = w.z;
  if (zoom) view.distance = zoomToDistance(zoom);
  needsDraw = true;
}

export function resetView() {
  userMovedView = false;
  view.azimuth = -0.55;
  view.elevation = DEFAULT_ELEVATION;
  view.target = { x: 0, y: 0, z: 0 };
  view.distance = BASE_DISTANCE;
  if (!fitToPlanets()) view.distance = BASE_DISTANCE;
  needsDraw = true;
}

/** Look straight down: the flat map, for when perspective is in the way. */
export function topDownView() {
  userMovedView = true;
  view.elevation = MAX_ELEVATION;
  view.azimuth = 0;
  needsDraw = true;
}

/**
 * Frame the whole galaxy.
 *
 * Measured rather than derived: under perspective and tilt the galaxy projects
 * as an off-centre ellipse, not a disc, so solving from its world radius alone
 * both under-fills the canvas and leaves the far rim riding high. Instead the
 * planets are projected, the screen bounds measured, and the distance and
 * centre corrected — repeated a few times, because moving the camera changes
 * the projection it was measured from. It converges in two or three passes.
 */
function fitToPlanets() {
  const planets = state.planets;
  if (!planets.length || !width || !height) return false;

  const targetW = width * 0.86;
  const targetH = height * 0.80;
  const minDistance = BASE_DISTANCE / MAX_ZOOM;
  const maxDistance = BASE_DISTANCE / MIN_ZOOM;

  for (let pass = 0; pass < 4; pass++) {
    updateCamera();

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let seen = 0;
    for (const point of [{ x: 0, y: 0, z: 0 }, ...planets.map((pl) => worldOf(pl))]) {
      const p = project(point);
      if (!p.visible) continue;
      seen += 1;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (seen < 2) return false;

    const boundsW = Math.max(1, maxX - minX);
    const boundsH = Math.max(1, maxY - minY);
    const correction = Math.max(boundsW / targetW, boundsH / targetH);

    const next = clamp(view.distance * correction, minDistance, maxDistance);
    const settled = Math.abs(next - view.distance) / view.distance < 0.01;
    view.distance = next;

    updateCamera();
    shiftTarget(width / 2 - (minX + maxX) / 2, height / 2 - (minY + maxY) / 2);

    if (settled) break;
  }

  updateCamera();
  return true;
}

/* ------------------------------------------------------------------ events */

function bindPointer() {
  const pointers = new Map();
  let mode = null; // 'orbit' | 'pan'
  let moved = 0;
  let last = null;
  let pinchDistance = 0;
  let pinchMid = null;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      mode = (event.shiftKey || event.button === 1 || event.button === 2) ? 'pan' : 'orbit';
      moved = 0;
      last = { x: event.clientX, y: event.clientY };
    } else if (pointers.size === 2) {
      mode = null;
      pinchDistance = pointerSpread(pointers);
      pinchMid = pointerMidpoint(pointers);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (pointers.size === 2) {
      const spread = pointerSpread(pointers);
      const mid = pointerMidpoint(pointers);
      if (pinchDistance > 0 && spread > 0) zoomBy(spread / pinchDistance);
      if (pinchMid) panBy(mid.x - pinchMid.x, mid.y - pinchMid.y);
      pinchDistance = spread;
      pinchMid = mid;
      return;
    }

    if (mode && last) {
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (mode === 'orbit') orbitBy(-dx * 0.006, dy * 0.005);
      else panBy(dx, dy);
      last = { x: event.clientX, y: event.clientY };
      canvas.classList.add('is-panning');
      return;
    }

    const planet = planetAt(event.clientX - rect.left, event.clientY - rect.top);
    const nextHover = planet ? planet.index : null;
    if (nextHover !== hovered) {
      hovered = nextHover;
      needsDraw = true;
    }
    updateTooltip(planet, event.clientX - rect.left, event.clientY - rect.top);
    canvas.style.cursor = planet ? 'pointer' : 'grab';
  });

  const endPointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    const wasDragging = Boolean(mode);
    pointers.delete(event.pointerId);
    if (pointers.size < 2) { pinchDistance = 0; pinchMid = null; }
    if (pointers.size === 0) {
      mode = null;
      last = null;
      canvas.classList.remove('is-panning');
      // A drag that barely moved is a click, not a rotation.
      if (wasDragging && moved < 6) {
        const planet = planetAt(event.clientX - rect.left, event.clientY - rect.top);
        selectPlanet(planet ? planet.index : null);
      }
    }
  };

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    hideTooltip();
    needsDraw = true;
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    zoomBy(Math.exp(-event.deltaY * unit * 0.0016));
  }, { passive: false });

  canvas.addEventListener('dblclick', () => zoomBy(1.6));

  canvas.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 3 : 1;
    const actions = {
      ArrowLeft: () => (event.altKey ? panBy(40 * step, 0) : orbitBy(0.08 * step, 0)),
      ArrowRight: () => (event.altKey ? panBy(-40 * step, 0) : orbitBy(-0.08 * step, 0)),
      ArrowUp: () => (event.altKey ? panBy(0, 40 * step) : orbitBy(0, -0.06 * step)),
      ArrowDown: () => (event.altKey ? panBy(0, -40 * step) : orbitBy(0, 0.06 * step)),
      '+': () => zoomBy(1.25),
      '=': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
      '0': () => resetView(),
      t: () => topDownView(),
      T: () => topDownView(),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
}

function pointerSpread(pointers) {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint(pointers) {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/* ----------------------------------------------------------------- tooltip */

function updateTooltip(planet, sx, sy) {
  if (!planet) {
    hideTooltip();
    return;
  }
  const info = faction(planet.currentOwner);
  const active = planet.campaign || planet.event;
  tooltip.innerHTML = `
    <span class="tip__name">${escapeText(planet.name)}</span>
    <span class="tip__sector">${escapeText(planet.sector)} Sector</span>
    <span class="tip__row"><i style="background:${info.color}"></i>${escapeText(info.label)}</span>
    ${planet.biome ? `<span class="tip__row tip__row--stat">${escapeText(planet.biome.name)}</span>` : ''}
    ${active ? `<span class="tip__row tip__row--stat">${planet.event ? 'DEFENCE' : 'LIBERATION'} ${percent(planet.liberation)}</span>` : ''}
    <span class="tip__row tip__row--stat">${compact(planet.players)} divers</span>`;
  tooltip.hidden = false;

  const rect = tooltip.getBoundingClientRect();
  const left = sx + 16 + rect.width > width ? sx - rect.width - 16 : sx + 16;
  const top = sy + 12 + rect.height > height ? sy - rect.height - 12 : sy + 12;
  tooltip.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/* ------------------------------------------------------------------- loop */

function frame(now) {
  if (needsDraw || animating) {
    draw(now);
    needsDraw = false;
  }
  requestAnimationFrame(frame);
}

export function initMap() {
  resize();
  bindPointer();

  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement || canvas);
  window.addEventListener('resize', resize);

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = () => { animating = !motionQuery.matches; needsDraw = true; };
  applyMotion();
  motionQuery.addEventListener('change', applyMotion);

  subscribe(() => {
    needsDraw = true;
    if (!hasFitted && state.planets.length) {
      view.target = { x: 0, y: 0, z: 0 };
      view.distance = BASE_DISTANCE;
      hasFitted = fitToPlanets();
    }
  });
  requestAnimationFrame(frame);

  document.getElementById('map-reset')?.addEventListener('click', resetView);
  document.getElementById('map-top')?.addEventListener('click', topDownView);
  document.getElementById('map-zoom-in')?.addEventListener('click', () => zoomBy(1.3));
  document.getElementById('map-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.3));
}
