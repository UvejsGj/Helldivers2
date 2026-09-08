/**
 * Alert stack: the war interrupting you.
 *
 * Events arrive from the store already ranked and capped, so this only has to
 * present them: newest on top, auto-dismissed, and clickable through to the
 * planet the event happened on.
 */

import { faction } from '../config.js';
import { selectPlanet, state, subscribe } from '../state.js';
import { escapeHtml } from '../format.js';
import { alert as playAlert } from '../audio.js';
import { focusPlanet } from './map.js';

const root = document.getElementById('alerts');

/** Long enough to read, short enough not to stack up during a busy poll. */
const DISMISS_AFTER = 11_000;
const MAX_VISIBLE = 4;

const timers = new Map();

function render(_, reason) {
  if (reason !== 'events' || !state.events.length) return;

  for (const event of state.events) {
    add(event);
  }
  // One cue per batch, pitched to the worst news in it — a klaxon per planet
  // during a galaxy-wide push would be unbearable.
  playAlert(state.events[0].severity);
  state.events = [];
}

function add(event) {
  const node = document.createElement('article');
  node.className = `alert alert--${event.severity}`;
  if (event.faction) node.style.setProperty('--accent', faction(event.faction).color);

  const clickable = typeof event.planetIndex === 'number';
  node.innerHTML = `
    <span class="alert__mark" aria-hidden="true">${markFor(event.kind)}</span>
    <div class="alert__body">
      <p class="alert__title">${escapeHtml(event.title)}</p>
      <p class="alert__detail">${escapeHtml(event.detail)}</p>
    </div>
    <button type="button" class="alert__close" aria-label="Dismiss">✕</button>`;

  if (clickable) {
    node.classList.add('is-clickable');
    node.addEventListener('click', (e) => {
      if (e.target.closest('.alert__close')) return;
      selectPlanet(event.planetIndex);
      focusPlanet(event.planetIndex, { zoom: 2.6 });
      dismiss(node);
    });
  }
  node.querySelector('.alert__close').addEventListener('click', () => dismiss(node));

  root.prepend(node);
  // Oldest go first once the stack is full.
  while (root.children.length > MAX_VISIBLE) dismiss(root.lastElementChild, true);

  timers.set(node, setTimeout(() => dismiss(node), DISMISS_AFTER));
}

function dismiss(node, immediate = false) {
  if (!node || node.dataset.leaving) return;
  clearTimeout(timers.get(node));
  timers.delete(node);
  node.dataset.leaving = '1';
  if (immediate) {
    node.remove();
    return;
  }
  node.classList.add('is-leaving');
  // Matches the leave transition; removed on a timer rather than transitionend
  // so a backgrounded tab still cleans up.
  setTimeout(() => node.remove(), 320);
}

function markFor(kind) {
  return {
    liberated: '★',
    captured: '⚠',
    seized: '⇄',
    defence: '⚑',
    'defence-held': '✔',
    campaign: '▶',
    order: '▲',
    'order-complete': '✔',
    dispatch: '✉',
  }[kind] || '•';
}

export function initAlerts() {
  subscribe(render);
}
