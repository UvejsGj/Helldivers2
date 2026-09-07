/**
 * Connection status bar: source toggle, freshness readout, and the outage
 * banner.
 *
 * The rule here is that a failed poll never blanks the dashboard. If we have
 * data from an earlier poll we keep showing it and say how old it is; only a
 * cold start with no data at all gets the full "war data unavailable" screen.
 */

import { getSource, isAnonymous, setSource } from '../api.js';
import { refresh, state, subscribe } from '../state.js';
import { ENDPOINTS, POLL_INTERVAL } from '../config.js';
import { escapeHtml, relativeTime } from '../format.js';

const bar = document.getElementById('status-bar');
const outage = document.getElementById('outage');
const sourceToggle = document.getElementById('source-toggle');
const refreshButton = document.getElementById('refresh-now');

const STATUS_TEXT = {
  boot: ['CONNECTING', 'Establishing uplink to Super Earth Command…'],
  ready: ['UPLINK NOMINAL', 'All feeds reporting.'],
  degraded: ['PARTIAL UPLINK', 'Some feeds are unreachable. Showing last known positions.'],
  down: ['UPLINK LOST', 'War data unavailable.'],
};

function render() {
  let [label, detail] = STATUS_TEXT[state.status] || STATUS_TEXT.boot;
  const failed = Object.entries(state.sources).filter(([, s]) => s && !s.ok).map(([key]) => key);

  // Restored data is not a degraded live feed — it is a photograph. Say so,
  // rather than implying these are current positions.
  if (state.restoredFrom) {
    label = 'LAST KNOWN POSITIONS';
    detail = `Showing the war as of ${relativeTime(state.restoredFrom)}. Reconnecting…`;
  }

  bar.dataset.status = state.restoredFrom ? 'restored' : state.status;
  bar.innerHTML = `
    <div class="status__left">
      <span class="status__lamp" aria-hidden="true"></span>
      <span class="status__label">${escapeHtml(label)}</span>
      <span class="status__detail">${escapeHtml(detail)}</span>
    </div>
    <div class="status__right mono">
      ${state.refreshing ? '<span class="status__working">SYNCING…</span>' : ''}
      <span class="status__age" title="Last successful update">
        ${state.lastSuccessfulUpdate ? `UPDATED ${relativeTime(state.lastSuccessfulUpdate).toUpperCase()}` : 'NO DATA'}
      </span>
      ${failed.length ? `<span class="status__failed" title="Failed feeds: ${escapeHtml(failed.join(', '))}">
        ${failed.length} FEED${failed.length === 1 ? '' : 'S'} DOWN</span>` : ''}
      ${isAnonymous() ? `<span class="status__anon"
        title="The API rejected the CORS preflight for the X-Super-* identification headers, so requests are being sent without them.">UNIDENTIFIED</span>` : ''}
    </div>`;

  renderOutage();
  syncToggle();
}

function renderOutage() {
  // With a restored snapshot on screen there is something to look at, so the
  // full-page notice would be in the way; the status bar carries the warning.
  const isDown = state.status === 'down' && !state.restoredFrom;
  outage.hidden = !isDown;
  if (!isDown) return;

  // Read from state.sources rather than state.errors: sources is filled in as
  // each feed reports, so the notice can name what actually failed while the
  // remaining feeds are still resolving.
  const failures = Object.entries(state.sources).filter(([, s]) => s && !s.ok);
  const reasons = failures.length
    ? failures.map(([key, s]) => `<li class="mono">${escapeHtml(key)}: ${escapeHtml(s.error || 'no response')}</li>`).join('')
    : '<li class="mono">No response from the war feed.</li>';

  outage.innerHTML = `
    <div class="outage__inner">
      <p class="outage__eyebrow">MINISTRY OF TRUTH — SIGNAL INTERRUPTED</p>
      <h2 class="outage__title">WAR DATA UNAVAILABLE</h2>
      <p class="outage__body">
        The dashboard cannot reach the Helldivers 2 community API. The galactic war
        continues regardless; only our view of it has been interrupted.
      </p>
      <ul class="outage__reasons">${reasons}</ul>
      <div class="outage__actions">
        <button type="button" class="btn btn--primary" data-outage-retry>RETRY UPLINK</button>
        <button type="button" class="btn" data-outage-mock>VIEW ARCHIVE FOOTAGE</button>
      </div>
      <p class="outage__hint">
        Archive footage is a generated sample of the war, for when the live feed is
        unreachable. Retries continue automatically every ${Math.round(POLL_INTERVAL / 1000)}s.
      </p>
    </div>`;

  outage.querySelector('[data-outage-retry]')?.addEventListener('click', () => refresh({ force: true }));
  outage.querySelector('[data-outage-mock]')?.addEventListener('click', () => switchSource('mock'));
}

function syncToggle() {
  const source = getSource();
  for (const button of sourceToggle.querySelectorAll('[data-source]')) {
    const active = button.dataset.source === source;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  sourceToggle.dataset.source = source;
}

function switchSource(next) {
  if (next === getSource()) return;
  setSource(next);
  // Clear the visible war so a stale live snapshot cannot linger under the
  // mock data (or the other way round) while the first fetch is in flight.
  state.status = 'boot';
  state.errors = [];
  refresh({ force: true });
  syncToggle();
}

export function initStatus() {
  subscribe(render);

  sourceToggle.addEventListener('click', (event) => {
    const button = event.target.closest('[data-source]');
    if (button) switchSource(button.dataset.source);
  });

  refreshButton.addEventListener('click', () => refresh({ force: true }));

  // A tooltip listing every feed and when it last landed.
  refreshButton.addEventListener('mouseenter', () => {
    const lines = Object.keys(ENDPOINTS).map((key) => {
      const s = state.sources[key];
      if (!s) return `${key}: pending`;
      return `${key}: ${s.ok ? 'ok' : 'FAILED'}${s.fetchedAt ? ` (${relativeTime(s.fetchedAt)})` : ''}`;
    });
    refreshButton.title = `Force refresh\n\n${lines.join('\n')}`;
  });

  render();
  setInterval(() => { if (!state.refreshing) render(); }, 15_000);
}
