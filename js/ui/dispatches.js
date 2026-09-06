/**
 * Dispatch feed — in-game news from the Ministry of Truth, newest first.
 *
 * Dispatch text is API-supplied, so it goes through formatDispatch(), which
 * escapes the string before re-introducing the handful of in-game markup tags
 * the feed actually uses.
 */

import { state, subscribe } from '../state.js';
import { formatDispatch, relativeTime, timestamp } from '../format.js';

const root = document.getElementById('dispatch-feed');
const MAX_ITEMS = 30;
let signature = null;

function render() {
  const dispatches = state.dispatches.slice(0, MAX_ITEMS);
  // Re-rendering the feed on every poll would kill the user's scroll position,
  // so only rebuild when the actual content changes.
  const next = dispatches.map((d) => d.id).join(',');
  if (next === signature) {
    updateAges();
    return;
  }
  signature = next;

  if (!dispatches.length) {
    root.innerHTML = `
      <li class="panel__empty">
        <p>${state.status === 'down'
          ? 'Communications with Super Earth have been interrupted.'
          : 'No dispatches on record.'}</p>
      </li>`;
    return;
  }

  root.innerHTML = dispatches.map((dispatch, i) => `
    <li class="dispatch ${i === 0 ? 'is-latest' : ''}">
      <div class="dispatch__meta">
        <span class="dispatch__tag">${i === 0 ? 'LATEST' : 'DISPATCH'}</span>
        <time class="dispatch__time mono" datetime="${dispatch.published
          ? new Date(dispatch.published).toISOString() : ''}"
          data-epoch="${dispatch.published || ''}"
          title="${timestamp(dispatch.published)}">${relativeTime(dispatch.published)}</time>
      </div>
      <p class="dispatch__body">${formatDispatch(dispatch.message)}</p>
    </li>`).join('');
}

/** Keep the "4h ago" labels honest without rebuilding the list. */
function updateAges() {
  for (const node of root.querySelectorAll('[data-epoch]')) {
    const epoch = Number(node.dataset.epoch);
    if (epoch) node.textContent = relativeTime(epoch);
  }
}

export function initDispatches() {
  subscribe(render);
  render();
  setInterval(updateAges, 60_000);
}
