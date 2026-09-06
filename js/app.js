/**
 * Bootstrap and the auto-refresh loop.
 *
 * Refreshing is silent by design: state.refresh() mutates one snapshot and each
 * view re-renders only the parts that actually changed, so a poll landing
 * mid-read does not scroll the dispatch feed, close the planet panel, or reset
 * the map view.
 */

import { POLL_INTERVAL } from './config.js';
import { refresh, selectPlanet, state, subscribe } from './state.js';
import { initMajorOrder } from './ui/majorOrder.js';
import { initMap } from './ui/map.js';
import { initPlanetPanel } from './ui/planetPanel.js';
import { initStats } from './ui/stats.js';
import { initDispatches } from './ui/dispatches.js';
import { initStatus } from './ui/status.js';

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

/** Mobile: the planet panel is a sheet, so it needs a visible open/close state. */
function bindLayout() {
  const shell = document.querySelector('.shell');
  subscribe((s, reason) => {
    if (reason !== 'selection') return;
    shell.classList.toggle('has-selection', s.selectedPlanet !== null);
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

function boot() {
  initStatus();
  initMajorOrder();
  initMap();
  initPlanetPanel();
  initStats();
  initDispatches();
  bindLayout();
  bindLifecycle();

  document.body.classList.remove('is-booting');
  refresh({ force: true }).then(startPolling);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Handy for poking at the war from the console.
window.superEarthWatch = { state, refresh };
