/**
 * Uplink sequence.
 *
 * A cold-open terminal that reports each feed as it genuinely lands — the lines
 * are driven by the store's own per-feed status, not by a timer, so this is a
 * progress indicator in costume rather than theatre. It dismisses on the first
 * click or key, and on a hard deadline regardless of what the network is doing.
 */

import { ENDPOINTS } from '../config.js';
import { state, subscribe } from '../state.js';
import { confirm as playConfirm, fanfare } from '../audio.js';

const root = document.getElementById('boot');
const SESSION_KEY = 'sew:booted';
/** Never hold the dashboard hostage to a feed that is not coming. */
const HARD_DEADLINE = 7000;

const LABELS = {
  assignments: 'HIGH COMMAND DIRECTIVE',
  planets: 'PLANETARY TELEMETRY',
  war: 'WAR STATUS',
  campaigns: 'ACTIVE CAMPAIGNS',
  planetEvents: 'THREAT ASSESSMENT',
  dispatches: 'MINISTRY BROADCAST',
};

let done = false;
let unsubscribe = null;

function alreadyBooted() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markBooted() {
  try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* not fatal */ }
}

export function initBoot() {
  // Once per session, and never in front of someone who asked for less motion.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!root || alreadyBooted() || reduced) {
    finish(true);
    return;
  }

  const keys = Object.keys(ENDPOINTS);
  root.innerHTML = `
    <div class="boot__inner">
      <p class="boot__brand">SUPER EARTH COMMAND TERMINAL</p>
      <p class="boot__line boot__line--muted">ESTABLISHING SECURE UPLINK…</p>
      <ul class="boot__list">
        ${keys.map((key) => `
          <li class="boot__item" data-feed="${key}">
            <span class="boot__label">${LABELS[key] || key.toUpperCase()}</span>
            <span class="boot__status mono" data-status>····</span>
          </li>`).join('')}
      </ul>
      <p class="boot__done" hidden>UPLINK ESTABLISHED</p>
      <button type="button" class="boot__skip">SKIP</button>
    </div>`;

  root.hidden = false;
  document.body.classList.add('is-booting-uplink');

  root.querySelector('.boot__skip').addEventListener('click', () => finish());
  root.addEventListener('click', () => finish());
  window.addEventListener('keydown', onKey, { once: false });

  unsubscribe = subscribe(update);
  update();
  setTimeout(() => finish(), HARD_DEADLINE);
}

function onKey() { finish(); }

function update() {
  if (done || !root) return;
  let settled = 0;
  const keys = Object.keys(ENDPOINTS);

  for (const key of keys) {
    const item = root.querySelector(`[data-feed="${key}"]`);
    if (!item) continue;
    const source = state.sources[key];
    const node = item.querySelector('[data-status]');
    if (!source) continue;

    settled += 1;
    if (item.dataset.settled) continue;
    item.dataset.settled = '1';
    item.classList.add(source.ok ? 'is-ok' : 'is-failed');
    node.textContent = source.ok ? 'OK' : 'FAIL';
    playConfirm();
  }

  if (settled >= keys.length) {
    const doneLine = root.querySelector('.boot__done');
    if (doneLine) doneLine.hidden = false;
    fanfare();
    setTimeout(() => finish(), 900);
  }
}

function finish(silent = false) {
  if (done) return;
  done = true;
  markBooted();
  window.removeEventListener('keydown', onKey);
  unsubscribe?.();
  document.body.classList.remove('is-booting-uplink');
  if (!root) return;
  if (silent) {
    root.hidden = true;
    return;
  }
  root.classList.add('is-leaving');
  setTimeout(() => { root.hidden = true; root.innerHTML = ''; }, 420);
}
