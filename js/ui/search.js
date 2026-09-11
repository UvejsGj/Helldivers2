/**
 * Planet search.
 *
 * Two hundred and sixty worlds is more than a map can label at once, so the
 * only reliable way to reach a specific planet is to name it. Matches on planet
 * name and on sector, because "show me everything in Xzar" is the other question
 * people actually ask.
 *
 * Keyboard-first: `/` focuses it from anywhere, arrows move through results,
 * Enter selects, Escape backs out one step at a time.
 */

import { faction } from '../config.js';
import { selectPlanet, state, subscribe } from '../state.js';
import { compact, escapeHtml, percent } from '../format.js';
import { focusPlanet } from './map.js';

const root = document.getElementById('planet-search');
const input = document.getElementById('search-input');
const list = document.getElementById('search-results');

/** More than this and the list stops being scannable. */
const MAX_RESULTS = 8;

let matches = [];
let active = -1;

/**
 * Rank a planet against the query. Lower is better; -1 means no match.
 *
 * An exact name beats a prefix beats a substring, and any name match beats a
 * sector match — typing "meri" should offer Meridia before the eleven worlds of
 * the Meridian sector.
 */
function score(planet, query) {
  const name = planet.name.toLowerCase();
  const sector = (planet.sector || '').toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (sector.startsWith(query)) return 3;
  if (sector.includes(query)) return 4;
  return -1;
}

function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored = [];
  for (const planet of state.planets) {
    const rank = score(planet, q);
    if (rank >= 0) scored.push({ planet, rank });
  }

  scored.sort((a, b) => (
    a.rank - b.rank
    // Within a rank, somewhere a fight is happening comes first, then the
    // busiest world — which is almost always the one being looked for.
    || Number(Boolean(b.planet.campaign || b.planet.event))
       - Number(Boolean(a.planet.campaign || a.planet.event))
    || b.planet.players - a.planet.players
    || a.planet.name.localeCompare(b.planet.name)
  ));

  return scored.slice(0, MAX_RESULTS).map((entry) => entry.planet);
}

function render() {
  if (!matches.length) {
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    return;
  }

  list.innerHTML = matches.map((planet, i) => {
    const info = faction(planet.currentOwner);
    const contested = Boolean(planet.campaign || planet.event);
    const status = contested
      ? `${planet.event ? 'DEFEND' : 'LIBERATE'} ${percent(planet.liberation, 0)}`
      : compact(planet.players);
    return `
      <li id="search-opt-${i}" role="option" aria-selected="${i === active}"
          class="search__item ${i === active ? 'is-active' : ''}" data-index="${i}">
        <span class="search__dot" style="background:${info.color}"></span>
        <span class="search__name">${escapeHtml(planet.name)}</span>
        <span class="search__sector">${escapeHtml(planet.sector || '')}</span>
        <span class="search__status mono ${contested ? 'is-contested' : ''}">${escapeHtml(status)}</span>
      </li>`;
  }).join('');

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  root.classList.add('is-open');
  input.setAttribute('aria-activedescendant', active >= 0 ? `search-opt-${active}` : '');
}

function choose(index) {
  const planet = matches[index];
  if (!planet) return;
  selectPlanet(planet.index);
  focusPlanet(planet.index, { zoom: 3 });
  close();
  input.blur();
}

function close() {
  matches = [];
  active = -1;
  render();
}

function onInput() {
  matches = search(input.value);
  active = matches.length ? 0 : -1;
  render();
}

function onKeyDown(event) {
  switch (event.key) {
    case 'ArrowDown':
      if (!matches.length) return;
      event.preventDefault();
      active = (active + 1) % matches.length;
      render();
      break;
    case 'ArrowUp':
      if (!matches.length) return;
      event.preventDefault();
      active = (active - 1 + matches.length) % matches.length;
      render();
      break;
    case 'Enter':
      if (active >= 0) {
        event.preventDefault();
        choose(active);
      }
      break;
    case 'Escape':
      // One step at a time: close the list, then clear the box, then let go.
      event.preventDefault();
      event.stopPropagation();
      if (matches.length) close();
      else if (input.value) { input.value = ''; close(); }
      else input.blur();
      break;
    default:
  }
}

export function initSearch() {
  if (!root || !input || !list) return;

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('focus', () => { if (input.value) onInput(); });

  // pointerdown, not click: the input's blur would otherwise tear the list down
  // before a click could land on it.
  list.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('[data-index]');
    if (!item) return;
    event.preventDefault();
    choose(Number(item.dataset.index));
  });

  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) close();
  });

  // `/` from anywhere, as long as the keystroke is not meant for a field.
  window.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    event.preventDefault();
    input.focus();
    input.select();
  });

  // A refresh can change a listed planet's owner or garrison under the cursor.
  subscribe(() => { if (matches.length) { matches = search(input.value); render(); } });
}
