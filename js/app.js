/**
 * Bootstrap and the auto-refresh loop.
 *
 * Refreshing is silent by design: state.refresh() mutates one snapshot and each
 * view re-renders only the parts that actually changed, so a poll landing
 * mid-read does not scroll the dispatch feed, close the planet panel, or reset
 * the map view.
 */

import { POLL_INTERVAL } from './config.js';
import { hydrate, refresh, selectPlanet, state, subscribe } from './state.js';
import { initMajorOrder } from './ui/majorOrder.js';
import { focusPlanet, initMap } from './ui/map.js';
import { initPlanetPanel } from './ui/planetPanel.js';
import { initStats } from './ui/stats.js';
import { initDispatches } from './ui/dispatches.js';
import { initStatus } from './ui/status.js';
import { initAlerts } from './ui/alerts.js';
import { initBoot } from './ui/boot.js';
import { initSearch } from './ui/search.js';
import { chirp, isEnabled, loadPreference, setEnabled } from './audio.js';

let pollTimer = null;

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // Nothing to show and nothing to gain from polling a background tab; the
    // visibilitychange handler catches us up the moment it returns.
    if (document.hidden) return;
    refresh();
  }, POLL_INTERVAL);
}

function bindLifecycle() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  // Coming back online is the one moment a forced refresh is clearly worth it.
  window.addEventListener('online', () => refresh({ force: true }));

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectedPlanet !== null) selectPlanet(null);
    if (event.key === 'r' && !event.metaKey && !event.ctrlKey
        && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) {
      refresh({ force: true });
    }
  });
}

/* ------------------------------------------------------------- deep links

   ?planet=Meridia (or an index) opens straight onto that world, and selecting
   one rewrites the URL, so a view of a specific front is shareable. Matching is
   by name because that is what someone would type or paste to a squadmate;
   the index is accepted as a fallback.                                       */

let deepLinkApplied = false;

function findPlanet(token) {
  if (!token) return null;
  const wanted = decodeURIComponent(token).trim().toLowerCase();
  if (!wanted) return null;

  for (const planet of state.planets) {
    if (planet.name.toLowerCase() === wanted) return planet;
  }
  // Numeric fallback, checked second so a planet literally named "12" wins.
  if (/^\d+$/.test(wanted)) return state.planetsByIndex.get(Number(wanted)) || null;
  return null;
}

/** Honour ?planet= once, as soon as there are planets to match against. */
function applyDeepLink() {
  if (deepLinkApplied || !state.planets.length) return;
  const token = new URLSearchParams(location.search).get('planet');
  if (!token) {
    deepLinkApplied = true;
    return;
  }
  const planet = findPlanet(token);
  deepLinkApplied = true;
  if (!planet) return;

  selectPlanet(planet.index);
  focusPlanet(planet.index, { zoom: 2.4 });
}

/** Keep the address bar in step with the selection, without adding history. */
function syncDeepLink() {
  const params = new URLSearchParams(location.search);
  const planet = state.selectedPlanet !== null
    ? state.planetsByIndex.get(state.selectedPlanet)
    : null;

  if (planet) params.set('planet', planet.name);
  else params.delete('planet');

  const query = params.toString();
  const next = `${location.pathname}${query ? `?${query}` : ''}`;
  // replaceState, not pushState: clicking through planets should not build a
  // back-button trail the reader has to unwind.
  history.replaceState(null, '', next);
}

/** Mobile: the planet panel is a sheet, so it needs a visible open/close state. */
function bindLayout() {
  const shell = document.querySelector('.shell');
  subscribe((s, reason) => {
    if (reason !== 'selection') return;
    shell.classList.toggle('has-selection', s.selectedPlanet !== null);
    syncDeepLink();
  });

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      for (const other of document.querySelectorAll('[data-tab]')) {
        const active = other === tab;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-selected', String(active));
      }
      for (const pane of document.querySelectorAll('[data-pane]')) {
        pane.hidden = pane.dataset.pane !== target;
      }
    });
  }
}

/**
 * "WAR DAY 1,324" from the war's real start date, which the API already sends
 * and nothing displayed until now.
 */
function bindWarDay() {
  const node = document.getElementById('war-day');
  if (!node) return;
  subscribe(() => {
    const started = state.war?.started;
    if (!started) {
      node.hidden = true;
      return;
    }
    const days = Math.max(1, Math.floor((Date.now() - started) / 86400000) + 1);
    node.textContent = `· WAR DAY ${days.toLocaleString('en-US')}`;
    node.hidden = false;
  });
}

function bindAudio() {
  const button = document.getElementById('audio-toggle');
  if (!button) return;
  const icon = button.querySelector('[data-audio-icon]');

  const paint = () => {
    const on = isEnabled();
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Sound: on' : 'Sound: off';
    button.classList.toggle('is-active', on);
    if (icon) icon.textContent = on ? '🔊' : '🔇';
  };

  // A stored preference cannot start audio on its own: browsers keep a context
  // suspended until the page has been interacted with. Arm it on the first
  // gesture so the choice survives a reload without a second click on the icon.
  if (loadPreference()) {
    const resume = () => setEnabled(true);
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
  }
  paint();

  button.addEventListener('click', () => {
    // Toggling is the user gesture the audio context needs to start.
    setEnabled(!isEnabled());
    paint();
    if (isEnabled()) chirp();
  });
}

function boot() {
  initStatus();
  initMajorOrder();
  initMap();
  initPlanetPanel();
  initStats();
  initDispatches();
  initAlerts();
  initSearch();
  bindWarDay();
  bindAudio();
  bindLayout();
  bindLifecycle();
  initBoot();

  document.body.classList.remove('is-booting');

  // Show the last known war immediately, then go and get the real one.
  hydrate();
  applyDeepLink();

  refresh({ force: true }).then(() => {
    applyDeepLink();
    startPolling();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Handy for poking at the war from the console.
window.superEarthWatch = { state, refresh };
