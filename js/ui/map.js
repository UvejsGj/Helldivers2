/**
 * Galactic map.
 *
 * Canvas rather than SVG: ~180 planets plus supply lines, attack arrows and
 * animated campaign rings redraw every frame while panning, and a canvas keeps
 * that to one draw call per element instead of ~600 live DOM nodes.
 *
 * Coordinate spaces:
 *   world  — the API's own units, roughly [-1, 1] on both axes, origin at
 *            Super Earth. y is flipped on the way out so the map matches the
 *            in-game orientation (north is up).
 *   screen — CSS pixels within the canvas.
 *
 *   screen = (world * BASE_SCALE * zoom) + offset + centre
 */

import { faction } from '../config.js';
import { selectPlanet, state, subscribe } from '../state.js';
import { compact, percent } from '../format.js';

const canvas = document.getElementById('galaxy');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('map-tooltip');
const zoomReadout = document.getElementById('zoom-readout');

/** World units are ~[-1,1]; this maps that onto a sensible pixel span. */
const BASE_SCALE = 420;
/* Low enough that fitToPlanets() can frame the whole galaxy on a 320px screen
   rather than clipping the rim against the clamp. */
const MIN_ZOOM = 0.28;
const MAX_ZOOM = 9;
const PLANET_RADIUS = 4.2;
const HIT_PADDING = 8;

const view = { zoom: 1, x: 0, y: 0 };
let width = 0;
let height = 0;
let dpr = 1;

let hovered = null;
let needsDraw = true;
let animating = true;
/** The galaxy is only framed automatically once, so a poll never yanks the view. */
let hasFitted = false;

/* --------------------------------------------------------------- transforms */

function worldToScreen(wx, wy) {
  return {
    x: wx * BASE_SCALE * view.zoom + view.x + width / 2,
    y: -wy * BASE_SCALE * view.zoom + view.y + height / 2,
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - width / 2 - view.x) / (BASE_SCALE * view.zoom),
    y: -(sy - height / 2 - view.y) / (BASE_SCALE * view.zoom),
  };
}

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

  // Reframe on a resize only while the view is still the one we chose; once the
  // user has panned or zoomed, their framing is theirs to keep.
  if (!userMovedView) hasFitted = fitToPlanets();
  needsDraw = true;
}

/** Set the moment the user pans or zooms, so auto-framing stops interfering. */
let userMovedView = false;

/* ------------------------------------------------------------------ drawing */

function draw(now) {
  if (!width || !height) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  drawBackdrop(now);

  const planets = state.planets;
  if (!planets.length) {
    drawEmptyState();
    return;
  }

  drawSupplyLines();
  drawAttacks(now);
  drawSuperEarth(now);
  drawPlanets(planets, now);

  if (zoomReadout) zoomReadout.textContent = `${view.zoom.toFixed(2)}×`;
}

/** Starfield and the faint concentric range rings around Super Earth. */
function drawBackdrop(now) {
  ctx.save();
  ctx.strokeStyle = 'rgba(90, 130, 180, 0.09)';
  ctx.lineWidth = 1;
  for (let r = 0.25; r <= 1.25; r += 0.25) {
    const centre = worldToScreen(0, 0);
    const radius = r * BASE_SCALE * view.zoom;
    if (radius > Math.hypot(width, height)) continue;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // A slow sweep line, like a war-room radar plot.
  const centre = worldToScreen(0, 0);
  const sweepAngle = (now / 9000) % (Math.PI * 2);
  const sweepLength = Math.hypot(width, height);
  const gradient = ctx.createLinearGradient(
    centre.x, centre.y,
    centre.x + Math.cos(sweepAngle) * sweepLength,
    centre.y + Math.sin(sweepAngle) * sweepLength,
  );
  gradient.addColorStop(0, 'rgba(120, 180, 255, 0.10)');
  gradient.addColorStop(1, 'rgba(120, 180, 255, 0)');
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centre.x, centre.y);
  ctx.lineTo(centre.x + Math.cos(sweepAngle) * sweepLength, centre.y + Math.sin(sweepAngle) * sweepLength);
  ctx.stroke();
  ctx.restore();
}

function drawEmptyState() {
  ctx.save();
  ctx.fillStyle = 'rgba(200, 214, 230, 0.35)';
  ctx.font = '600 13px "Saira Condensed", "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '2px';
  ctx.fillText('NO TELEMETRY', width / 2, height / 2);
  ctx.restore();
}

function drawSupplyLines() {
  const byIndex = state.planetsByIndex;
  ctx.save();
  ctx.lineWidth = Math.max(0.5, 0.7 * Math.min(view.zoom, 2));
  ctx.strokeStyle = 'rgba(120, 150, 190, 0.16)';
  ctx.beginPath();
  for (const line of state.supplyLines) {
    const a = byIndex.get(line.a);
    const b = byIndex.get(line.b);
    if (!a || !b) continue;
    const pa = worldToScreen(a.position.x, a.position.y);
    const pb = worldToScreen(b.position.x, b.position.y);
    if (offscreen(pa) && offscreen(pb)) continue;
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Directional arrows for planets under attack, with a marching dash. */
function drawAttacks(now) {
  const byIndex = state.planetsByIndex;
  ctx.save();
  for (const attack of state.attacks) {
    const source = byIndex.get(attack.source);
    const target = byIndex.get(attack.target);
    if (!source || !target) continue;

    const from = worldToScreen(source.position.x, source.position.y);
    const to = worldToScreen(target.position.x, target.position.y);
    if (offscreen(from) && offscreen(to)) continue;

    const colour = faction(attack.faction).color;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    // Stop the shaft short of the target so the arrowhead sits clear of the disc.
    const gap = PLANET_RADIUS * Math.min(view.zoom, 2.2) + 7;
    const tip = { x: to.x - Math.cos(angle) * gap, y: to.y - Math.sin(angle) * gap };

    ctx.strokeStyle = colour;
    ctx.globalAlpha = attack.inferred ? 0.4 : 0.85;
    ctx.lineWidth = attack.inferred ? 1.2 : 2;
    ctx.setLineDash(attack.inferred ? [3, 5] : [9, 6]);
    ctx.lineDashOffset = -(now / 45) % 15;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.globalAlpha = attack.inferred ? 0.55 : 1;
    ctx.fillStyle = colour;
    const head = 7 + Math.min(view.zoom, 2) * 2;
    ctx.beginPath();
    ctx.moveTo(tip.x + Math.cos(angle) * head, tip.y + Math.sin(angle) * head);
    ctx.lineTo(tip.x + Math.cos(angle + 2.5) * head, tip.y + Math.sin(angle + 2.5) * head);
    ctx.lineTo(tip.x + Math.cos(angle - 2.5) * head, tip.y + Math.sin(angle - 2.5) * head);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Super Earth itself sits at the origin and is not in the planet list. */
function drawSuperEarth(now) {
  const p = worldToScreen(0, 0);
  if (offscreen(p, 60)) return;
  const pulse = 0.5 + 0.5 * Math.sin(now / 900);

  ctx.save();
  ctx.strokeStyle = `rgba(245, 197, 24, ${0.35 + pulse * 0.35})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10 + pulse * 3, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#f5c518';
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
  ctx.fill();

  if (view.zoom > 0.8) {
    ctx.fillStyle = 'rgba(245, 197, 24, 0.9)';
    ctx.font = '700 10px "Saira Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SUPER EARTH', p.x, p.y + 24);
  }
  ctx.restore();
}

function drawPlanets(planets, now) {
  const selected = state.selectedPlanet;
  const zoomedRadius = PLANET_RADIUS * Math.min(view.zoom, 2.2);
  const labelThreshold = 1.9;

  for (const planet of planets) {
    const p = worldToScreen(planet.position.x, planet.position.y);
    if (offscreen(p, 40)) continue;

    const info = faction(planet.currentOwner);
    const isActive = Boolean(planet.campaign || planet.event);
    const isSelected = selected === planet.index;
    const isHovered = hovered === planet.index;

    // Player presence reads as a soft halo, so busy fronts are obvious at a glance.
    if (planet.players > 500) {
      const halo = Math.min(26, 6 + Math.log10(planet.players) * 5) * Math.min(view.zoom, 1.8);
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
      gradient.addColorStop(0, info.glow);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, halo, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Active campaign: an expanding ring, so live battles pull the eye.
    if (isActive) {
      const phase = ((now / 1400) + planet.index * 0.13) % 1;
      ctx.strokeStyle = info.color;
      ctx.globalAlpha = (1 - phase) * 0.75;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, zoomedRadius + 3 + phase * 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, zoomedRadius, 0, Math.PI * 2);
    ctx.fill();

    // A liberation arc traces progress around the disc.
    if (isActive && planet.liberation > 0.5) {
      ctx.strokeStyle = planet.event ? '#f5c518' : '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, zoomedRadius + 2.5, -Math.PI / 2,
        -Math.PI / 2 + (planet.liberation / 100) * Math.PI * 2);
      ctx.stroke();
    }

    if (isSelected || isHovered) {
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = isSelected ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, zoomedRadius + 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    const label = view.zoom >= labelThreshold || isActive || isSelected || isHovered;
    if (label) {
      ctx.fillStyle = isActive ? 'rgba(233, 240, 250, 0.95)' : 'rgba(200, 214, 230, 0.7)';
      ctx.font = `${isActive ? 600 : 400} 10px "Saira Condensed", "Arial Narrow", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(planet.name, p.x, p.y - zoomedRadius - 7);
    }
  }
  ctx.globalAlpha = 1;
}

function offscreen(p, margin = 8) {
  return p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin;
}

/* ------------------------------------------------------------- hit testing */

function planetAt(sx, sy) {
  const threshold = PLANET_RADIUS * Math.min(view.zoom, 2.2) + HIT_PADDING;
  let best = null;
  let bestDistance = Infinity;
  for (const planet of state.planets) {
    const p = worldToScreen(planet.position.x, planet.position.y);
    const distance = Math.hypot(p.x - sx, p.y - sy);
    if (distance < threshold && distance < bestDistance) {
      best = planet;
      bestDistance = distance;
    }
  }
  return best;
}

/* -------------------------------------------------------------- navigation */

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Zoom about a screen point, so the world under the cursor stays put. */
function zoomAt(sx, sy, factor) {
  userMovedView = true;
  const before = screenToWorld(sx, sy);
  view.zoom = clampZoom(view.zoom * factor);
  const after = screenToWorld(sx, sy);
  view.x += (after.x - before.x) * BASE_SCALE * view.zoom;
  view.y -= (after.y - before.y) * BASE_SCALE * view.zoom;
  needsDraw = true;
}

/** Centre the view on a planet without changing zoom. */
export function focusPlanet(index, { zoom } = {}) {
  const planet = state.planetsByIndex.get(index);
  if (!planet) return;
  userMovedView = true;
  if (zoom) view.zoom = clampZoom(zoom);
  view.x = -planet.position.x * BASE_SCALE * view.zoom;
  view.y = planet.position.y * BASE_SCALE * view.zoom;
  needsDraw = true;
}

export function resetView() {
  userMovedView = false;
  if (!fitToPlanets()) {
    view.zoom = 1;
    view.x = 0;
    view.y = 0;
  }
  needsDraw = true;
}

/**
 * Frame the whole galaxy in the canvas.
 *
 * The API's coordinate space is nominally [-1, 1], but the occupied span and
 * the canvas aspect ratio both vary, so a fixed default zoom either crops the
 * rim or strands the arms in empty space. Measuring the planets and solving for
 * the zoom that fits them is the only thing that works across viewports.
 */
function fitToPlanets() {
  const planets = state.planets;
  if (!planets.length || !width || !height) return false;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const planet of planets) {
    minX = Math.min(minX, planet.position.x);
    maxX = Math.max(maxX, planet.position.x);
    minY = Math.min(minY, planet.position.y);
    maxY = Math.max(maxY, planet.position.y);
  }
  // Super Earth sits at the origin and is not in the list, but it must be visible.
  minX = Math.min(minX, 0); maxX = Math.max(maxX, 0);
  minY = Math.min(minY, 0); maxY = Math.max(maxY, 0);

  const spanX = Math.max(maxX - minX, 0.001);
  const spanY = Math.max(maxY - minY, 0.001);
  // Padding leaves room for the labels and rings that overhang each planet.
  const padding = 0.88;
  const zoom = clampZoom(Math.min(
    (width * padding) / (spanX * BASE_SCALE),
    (height * padding) / (spanY * BASE_SCALE),
  ));

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  view.zoom = zoom;
  view.x = -centreX * BASE_SCALE * zoom;
  view.y = centreY * BASE_SCALE * zoom;
  return true;
}

/* ------------------------------------------------------------------ events */

function bindPointer() {
  const pointers = new Map();
  let dragging = false;
  let moved = 0;
  let last = null;
  let pinchDistance = 0;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      dragging = true;
      moved = 0;
      last = { x: event.clientX, y: event.clientY };
    } else if (pointers.size === 2) {
      dragging = false;
      pinchDistance = pointerSpread(pointers);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();

    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // Two fingers: pinch to zoom about the midpoint.
    if (pointers.size === 2) {
      const spread = pointerSpread(pointers);
      if (pinchDistance > 0 && spread > 0) {
        const mid = pointerMidpoint(pointers);
        zoomAt(mid.x - rect.left, mid.y - rect.top, spread / pinchDistance);
      }
      pinchDistance = spread;
      return;
    }

    if (dragging && last) {
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      view.x += dx;
      view.y += dy;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 6) userMovedView = true;
      last = { x: event.clientX, y: event.clientY };
      needsDraw = true;
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
    const wasDragging = dragging;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) {
      dragging = false;
      last = null;
      canvas.classList.remove('is-panning');
      // A drag that barely moved is a click, not a pan.
      if (wasDragging && moved < 6) {
        const planet = planetAt(event.clientX - rect.left, event.clientY - rect.top);
        selectPlanet(planet ? planet.index : null);
      }
    }
  };

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    hideTooltip();
    needsDraw = true;
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    // Normalise line- and page-scroll deltas so trackpads and mice agree.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    const factor = Math.exp(-event.deltaY * unit * 0.0016);
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
  }, { passive: false });

  canvas.addEventListener('dblclick', (event) => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, 1.6);
  });

  // Keyboard access: the canvas is focusable and pans/zooms with the arrows.
  canvas.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 120 : 45;
    const actions = {
      ArrowLeft: () => { view.x += step; },
      ArrowRight: () => { view.x -= step; },
      ArrowUp: () => { view.y += step; },
      ArrowDown: () => { view.y -= step; },
      '+': () => zoomAt(width / 2, height / 2, 1.25),
      '=': () => zoomAt(width / 2, height / 2, 1.25),
      '-': () => zoomAt(width / 2, height / 2, 0.8),
      '0': () => resetView(),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
    needsDraw = true;
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
    ${active ? `<span class="tip__row tip__row--stat">${planet.event ? 'DEFENCE' : 'LIBERATION'} ${percent(planet.liberation)}</span>` : ''}
    <span class="tip__row tip__row--stat">${compact(planet.players)} divers</span>`;
  tooltip.hidden = false;

  // Keep the tooltip inside the canvas; flip it when it would overflow.
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

  // Respect reduced-motion: stop the ambient animation and only redraw on
  // interaction or data change.
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = () => { animating = !motionQuery.matches; needsDraw = true; };
  applyMotion();
  motionQuery.addEventListener('change', applyMotion);

  subscribe(() => {
    needsDraw = true;
    if (!hasFitted && state.planets.length) hasFitted = fitToPlanets();
  });
  requestAnimationFrame(frame);

  document.getElementById('map-reset')?.addEventListener('click', resetView);
  document.getElementById('map-zoom-in')?.addEventListener('click',
    () => zoomAt(width / 2, height / 2, 1.3));
  document.getElementById('map-zoom-out')?.addEventListener('click',
    () => zoomAt(width / 2, height / 2, 1 / 1.3));
}
