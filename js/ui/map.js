/**
 * Galactic map — a perspective 3D view of the war.
 *
 * On the third dimension, honestly
 * ------------------------------------------------------------------
 * The API publishes two coordinates per planet and no depth. Scattering worlds
 * along an invented z-axis would look like data and be nothing of the kind, so
 * every planet sits at its true position on the galactic plane. What the third
 * dimension carries instead is real:
 *
 *   - the plane itself, drawn in perspective and free to orbit and tilt, which
 *     is how the galaxy is laid out in game;
 *   - height above the plane, which encodes deployed divers, so the busy fronts
 *     physically rise out of the map. Every raised planet keeps a footprint dot
 *     and a stalk on the plane, so its real position is never ambiguous;
 *   - attack arrows arc over the plane rather than crossing it, which keeps a
 *     front line readable from any angle.
 *
 * Rendered with a small software projector onto a 2D canvas rather than WebGL:
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
const DEFAULT_ELEVATION = 34 * (Math.PI / 180);

/** World-space radius of a planet body at the reference distance. */
const PLANET_RADIUS = 0.016;
const HIT_PADDING = 10;

/**
 * Direction toward the light, in world space, and the angle the sprite is baked
 * at. Keeping the light fixed in the world rather than on the screen means the
 * terminators all swing together as the camera orbits, which is most of what
 * sells the scene as lit rather than as flat discs.
 */
const LIGHT = normalize({ x: -0.45, y: 0.72, z: 0.53 });
const SPRITE_LIGHT_ANGLE = Math.atan2(-0.42, -0.42);

const view = {
  azimuth: -0.6,
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

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

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
 * Height above the plane, from deployed divers.
 *
 * Quiet worlds stay flat so the plane reads as a map; only fronts with a real
 * garrison rise, which is what makes the shape of the war legible at a glance.
 */
function planetHeight(planet) {
  const players = planet.players || 0;
  if (players < 1500) return 0;
  return Math.min(0.5, Math.log10(players / 1500) * 0.135);
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

/**
 * World point to screen. `depth` is distance along the view axis; anything at
 * or behind the near plane is returned with `visible: false` rather than
 * projected, since dividing by a negative depth mirrors geometry behind you
 * into the middle of the scene.
 */
const NEAR = 0.05;

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

/** Screen point back onto the galactic plane (y = 0), for pointer panning. */
function screenToPlane(sx, sy) {
  const ndcX = (sx - width / 2) / focal;
  const ndcY = -(sy - height / 2) / focal;
  const dir = {
    x: camera.forward.x + camera.right.x * ndcX + camera.up.x * ndcY,
    y: camera.forward.y + camera.right.y * ndcX + camera.up.y * ndcY,
    z: camera.forward.z + camera.right.z * ndcX + camera.up.z * ndcY,
  };
  if (Math.abs(dir.y) < 1e-6) return null;
  const t = -camera.eye.y / dir.y;
  if (t <= 0) return null;
  return { x: camera.eye.x + dir.x * t, y: 0, z: camera.eye.z + dir.z * t };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ----------------------------------------------------------- sprite cache */

/**
 * Planet bodies are baked once per colour pair and blitted thereafter. Building
 * the gradients fresh for 260 worlds every frame is what would actually cost
 * something here; drawImage of a cached bitmap costs nothing.
 */
const SPRITE_SIZE = 96;
const spriteCache = new Map();

function planetSprite(bodyColor, ringColor) {
  const key = `${bodyColor}|${ringColor}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  const g = c.getContext('2d');
  const mid = SPRITE_SIZE / 2;
  const bodyR = SPRITE_SIZE * 0.26;

  // Atmosphere: a faction-tinted halo, so allegiance reads before the surface.
  const halo = g.createRadialGradient(mid, mid, bodyR * 0.7, mid, mid, mid);
  halo.addColorStop(0, withAlpha(ringColor, 0.42));
  halo.addColorStop(0.45, withAlpha(ringColor, 0.12));
  halo.addColorStop(1, withAlpha(ringColor, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // Body, lit from the upper left with a soft terminator.
  const lx = mid - bodyR * 0.42;
  const ly = mid - bodyR * 0.42;
  const body = g.createRadialGradient(lx, ly, bodyR * 0.08, mid, mid, bodyR);
  body.addColorStop(0, lighten(bodyColor, 0.5));
  body.addColorStop(0.45, bodyColor);
  body.addColorStop(0.82, darken(bodyColor, 0.55));
  body.addColorStop(1, darken(bodyColor, 0.78));
  g.fillStyle = body;
  g.beginPath();
  g.arc(mid, mid, bodyR, 0, Math.PI * 2);
  g.fill();

  // Rim light in the faction colour, along the terminator's far edge.
  g.strokeStyle = withAlpha(ringColor, 0.85);
  g.lineWidth = SPRITE_SIZE * 0.018;
  g.beginPath();
  g.arc(mid, mid, bodyR * 0.99, 0, Math.PI * 2);
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

function lighten(hex, amount) {
  const { r, g, b } = parseHex(hex);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function darken(hex, amount) {
  const { r, g, b } = parseHex(hex);
  const mix = (c) => Math.round(c * (1 - amount));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
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
  for (let i = 0; i < 420; i++) {
    // Even distribution over a sphere well outside the galaxy.
    const u = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    stars.push({
      x: r * Math.cos(theta) * 14,
      y: u * 14,
      z: r * Math.sin(theta) * 14,
      size: 0.4 + rng() * 1.3,
      alpha: 0.25 + rng() * 0.6,
    });
  }
  return stars;
})();

/* ------------------------------------------------------------------ sizing */

function resize() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = rect.width;
  height = rect.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  drawNebula();
  drawStars();

  if (!state.planets.length) {
    drawEmptyState();
    return;
  }

  drawPlane(now);
  drawSupplyLines();
  drawStalks();
  drawAttacks(now);
  const drawn = drawPlanets(now);
  drawLabels(drawn);

  if (zoomReadout) zoomReadout.textContent = `${(BASE_DISTANCE / view.distance).toFixed(2)}×`;
}

/** Screen-space wash, shifted by heading so it parallaxes as you orbit. */
function drawNebula() {
  const drift = (view.azimuth / Math.PI) * width * 0.22;
  const blobs = [
    [width * 0.28 - drift, height * 0.34, Math.max(width, height) * 0.55, 'rgba(38, 74, 138, 0.20)'],
    [width * 0.78 - drift, height * 0.72, Math.max(width, height) * 0.48, 'rgba(96, 40, 110, 0.16)'],
    [width * 0.55 - drift, height * 0.12, Math.max(width, height) * 0.40, 'rgba(20, 60, 90, 0.16)'],
  ];
  for (const [x, y, r, color] of blobs) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawStars() {
  ctx.save();
  for (const star of STARS) {
    const p = project(star);
    if (!p.visible || p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
    ctx.fillStyle = `rgba(210, 226, 245, ${star.alpha})`;
    ctx.fillRect(p.x, p.y, star.size, star.size);
  }
  ctx.restore();
}

function drawEmptyState() {
  ctx.save();
  ctx.fillStyle = 'rgba(200, 214, 230, 0.35)';
  ctx.font = '600 13px "Saira Condensed", "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NO TELEMETRY', width / 2, height / 2);
  ctx.restore();
}

/** Concentric rings and spokes on the plane: the map's floor, and its horizon. */
function drawPlane(now) {
  ctx.save();
  ctx.lineWidth = 1;

  for (let r = 0.25; r <= 1.3; r += 0.25) {
    ctx.strokeStyle = `rgba(94, 140, 196, ${r > 1.2 ? 0.05 : 0.1})`;
    ringPath(r);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(94, 140, 196, 0.06)';
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const a = project({ x: 0, y: 0, z: 0 });
    const b = project({ x: Math.cos(angle) * 1.3, y: 0, z: Math.sin(angle) * 1.3 });
    if (!a.visible || !b.visible) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Radar sweep, on the plane rather than the screen, so it reads as part of
  // the world once the view is tilted.
  if (animating) {
    const angle = (now / 9000) % (Math.PI * 2);
    const a = project({ x: 0, y: 0, z: 0 });
    const b = project({ x: Math.cos(angle) * 1.3, y: 0, z: Math.sin(angle) * 1.3 });
    if (a.visible && b.visible) {
      const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      gradient.addColorStop(0, 'rgba(120, 180, 255, 0.16)');
      gradient.addColorStop(1, 'rgba(120, 180, 255, 0)');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  drawSuperEarth(now);
  ctx.restore();
}

function ringPath(radius, segments = 72) {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const p = project({ x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius });
    if (!p.visible) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; } else { ctx.lineTo(p.x, p.y); }
  }
}

function drawSuperEarth(now) {
  const base = project({ x: 0, y: 0, z: 0 });
  if (!base.visible) return;
  const pulse = animating ? 0.5 + 0.5 * Math.sin(now / 900) : 0.7;
  const r = Math.max(3, 0.02 * base.scale);

  // A beacon rising from the plane, so the capital is findable at any tilt.
  const top = project({ x: 0, y: 0.34, z: 0 });
  if (top.visible) {
    const beam = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
    beam.addColorStop(0, 'rgba(245, 197, 24, 0.55)');
    beam.addColorStop(1, 'rgba(245, 197, 24, 0)');
    ctx.strokeStyle = beam;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
  }

  ctx.strokeStyle = `rgba(245, 197, 24, ${0.3 + pulse * 0.4})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(base.x, base.y, r * 2.4 + pulse * 3, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#f5c518';
  ctx.beginPath();
  ctx.arc(base.x, base.y, r, 0, Math.PI * 2);
  ctx.fill();

  // The label is drawn with the rest, so it takes part in collision testing
  // instead of stamping itself over whatever planet name shares the spot.
  superEarthLabel = { x: base.x, y: base.y + r + 15 };
}

/** Screen position for Super Earth's caption, set each frame while drawing. */
let superEarthLabel = null;

function drawSupplyLines() {
  const byIndex = state.planetsByIndex;
  ctx.save();
  ctx.strokeStyle = 'rgba(118, 150, 190, 0.17)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const line of state.supplyLines) {
    const a = byIndex.get(line.a);
    const b = byIndex.get(line.b);
    if (!a || !b) continue;
    const pa = project(worldOf(a, false));
    const pb = project(worldOf(b, false));
    if (!pa.visible || !pb.visible) continue;
    if (offscreen(pa) && offscreen(pb)) continue;
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Footprint and stalk for every planet lifted off the plane. */
function drawStalks() {
  ctx.save();
  for (const planet of state.planets) {
    const h = planetHeight(planet);
    if (h <= 0) continue;
    const base = project(worldOf(planet, false));
    const top = project(worldOf(planet, true));
    if (!base.visible || !top.visible) continue;
    if (offscreen(base) && offscreen(top)) continue;

    const color = faction(planet.currentOwner).color;
    const gradient = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
    gradient.addColorStop(0, withAlpha(color, 0.06));
    gradient.addColorStop(1, withAlpha(color, 0.5));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();

    ctx.fillStyle = withAlpha(color, 0.4);
    ctx.beginPath();
    ctx.arc(base.x, base.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Attack arrows, arced over the plane.
 *
 * A straight line between two worlds lies flat and disappears edge-on at a low
 * tilt; lifting the midpoint keeps the front line readable from every angle and
 * separates crossing routes.
 */
function drawAttacks(now) {
  const byIndex = state.planetsByIndex;
  ctx.save();

  for (const attack of state.attacks) {
    const source = byIndex.get(attack.source);
    const target = byIndex.get(attack.target);
    if (!source || !target) continue;

    const a = worldOf(source, false);
    const b = worldOf(target, false);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const lift = Math.min(0.3, 0.1 + span * 0.32);

    const points = [];
    const SEGMENTS = 26;
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const p = project({
        x: a.x + (b.x - a.x) * t,
        // Parabola through both endpoints, peaking at the midpoint.
        y: a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * lift,
        z: a.z + (b.z - a.z) * t,
      });
      if (!p.visible) { points.length = 0; break; }
      points.push(p);
    }
    if (points.length < 2) continue;

    const color = faction(attack.faction).color;
    ctx.strokeStyle = color;
    ctx.globalAlpha = attack.inferred ? 0.38 : 0.8;
    ctx.lineWidth = attack.inferred ? 1.2 : 2;
    ctx.setLineDash(attack.inferred ? [3, 5] : [9, 6]);
    ctx.lineDashOffset = animating ? -(now / 45) % 15 : 0;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead, aimed along the arc's final segment.
    const tip = points[points.length - 1];
    const prev = points[points.length - 3] || points[points.length - 2];
    const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    const size = clamp(tip.scale * 0.014, 5, 13);
    ctx.globalAlpha = attack.inferred ? 0.5 : 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - Math.cos(angle - 0.42) * size, tip.y - Math.sin(angle - 0.42) * size);
    ctx.lineTo(tip.x - Math.cos(angle + 0.42) * size, tip.y - Math.sin(angle + 0.42) * size);
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Planets, painted back to front.
 *
 * Returns what was drawn, in front-to-back order, so labels and hit testing
 * agree with what the viewer can actually see.
 */
function drawPlanets(now) {
  const selected = state.selectedPlanet;
  const drawn = [];

  // The light is directional, so its screen angle is the same for every planet
  // and is worth computing once per frame rather than per world.
  const lightAngle = Math.atan2(-dot(LIGHT, camera.up), dot(LIGHT, camera.right));
  const spriteRotation = lightAngle - SPRITE_LIGHT_ANGLE;

  for (const planet of state.planets) {
    const p = project(worldOf(planet));
    if (!p.visible) continue;
    const radius = Math.max(1.6, PLANET_RADIUS * p.scale);
    if (offscreen(p, radius + 30)) continue;
    drawn.push({ planet, p, radius });
  }

  drawn.sort((a, b) => b.p.depth - a.p.depth);

  for (const item of drawn) {
    const { planet, p, radius } = item;
    const info = faction(planet.currentOwner);
    const active = Boolean(planet.campaign || planet.event);
    const isSelected = selected === planet.index;
    const isHovered = hovered === planet.index;

    // Expanding ring on live campaigns, so battles pull the eye.
    if (active && animating) {
      const phase = ((now / 1400) + planet.index * 0.13) % 1;
      ctx.strokeStyle = info.color;
      ctx.globalAlpha = (1 - phase) * 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 1.6 + phase * radius * 3.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const sprite = planetSprite(biomeColor(planet.biome), info.color);
    // The sprite's body occupies 0.26 of its width; scale so that lands on `radius`.
    const size = radius / 0.26;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(spriteRotation);
    ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
    ctx.restore();

    if (active && planet.liberation > 0.5) {
      ctx.strokeStyle = planet.event ? '#f5c518' : '#ffffff';
      ctx.lineWidth = Math.max(1.5, radius * 0.22);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 1.45, -Math.PI / 2,
        -Math.PI / 2 + (planet.liberation / 100) * Math.PI * 2);
      ctx.stroke();
    }

    if (isSelected || isHovered) {
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = isSelected ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawn.reverse();
  return drawn;
}

/**
 * Labels, nearest first, skipping any that would collide with one already
 * placed. Without that a dense sector turns into an unreadable smear.
 */
function drawLabels(drawn) {
  const zoom = BASE_DISTANCE / view.distance;
  const placed = [];
  ctx.save();
  ctx.textAlign = 'center';

  // The capital is drawn first and reserves its box, so no planet name can
  // land on top of it.
  if (superEarthLabel) {
    ctx.font = '700 10px "Saira Condensed", "Arial Narrow", sans-serif';
    const w = ctx.measureText('SUPER EARTH').width;
    placed.push({
      x1: superEarthLabel.x - w / 2 - 2, y1: superEarthLabel.y - 10,
      x2: superEarthLabel.x + w / 2 + 2, y2: superEarthLabel.y + 3,
    });
    ctx.fillStyle = 'rgba(5, 8, 13, 0.75)';
    ctx.fillText('SUPER EARTH', superEarthLabel.x + 1, superEarthLabel.y + 1);
    ctx.fillStyle = 'rgba(245, 197, 24, 0.92)';
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
    const y = p.y - radius - 8;
    const box = { x1: x - w / 2 - 2, y1: y - 10, x2: x + w / 2 + 2, y2: y + 3 };

    if (!focused && placed.some((o) => !(box.x2 < o.x1 || box.x1 > o.x2 || box.y2 < o.y1 || box.y1 > o.y2))) {
      continue;
    }
    placed.push(box);

    // A backing shadow keeps names legible over the nebula and the starfield.
    ctx.fillStyle = 'rgba(5, 8, 13, 0.75)';
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = active ? 'rgba(236, 243, 252, 0.96)' : 'rgba(200, 214, 230, 0.75)';
    ctx.fillText(text, x, y);
  }
  ctx.restore();
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
    const radius = Math.max(1.6, PLANET_RADIUS * p.scale);
    const distance = Math.hypot(p.x - sx, p.y - sy);
    // Nearest to the camera wins a tie, matching what is drawn on top.
    if (distance < radius + HIT_PADDING && p.depth < bestDepth) {
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
  // Movement along the plane, from the camera's right and its heading.
  const heading = normalize({ x: camera.forward.x, y: 0, z: camera.forward.z });
  const right = camera.right;
  view.target.x -= (right.x * dxScreen - heading.x * dyScreen) * perPixel;
  view.target.z -= (right.z * dxScreen - heading.z * dyScreen) * perPixel;
  const limit = 2.2;
  view.target.x = clamp(view.target.x, -limit, limit);
  view.target.z = clamp(view.target.z, -limit, limit);
}

/** Pan across the plane, in screen-relative directions at the current scale. */
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
  view.azimuth = -0.6;
  view.elevation = DEFAULT_ELEVATION;
  view.target = { x: 0, y: 0, z: 0 };
  view.distance = BASE_DISTANCE;
  if (!fitToPlanets()) view.distance = BASE_DISTANCE;
  needsDraw = true;
}

/** Look straight down: the old flat map, for when perspective is in the way. */
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
    // Super Earth sits at the origin and is not in the planet list, but it
    // must be inside the frame.
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
      // Shift or a secondary button pans; a plain drag orbits.
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

    // Two fingers: pinch to zoom, drag the midpoint to pan.
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
