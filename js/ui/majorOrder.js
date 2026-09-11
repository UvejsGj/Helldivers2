/**
 * Major Order banner — the current assignment from High Command.
 *
 * The countdown ticks every second off a locally-held expiry timestamp; the
 * rest of the banner only re-renders when the assignment payload changes, so a
 * poll landing mid-read does not flicker the text.
 */

import { majorOrder, selectPlanet, state, subscribe } from '../state.js';
import { describeTask, orderProgress, requiredRate } from '../objectives.js';
import { focusPlanet } from './map.js';
import { compact, countdown, escapeHtml, full, percent } from '../format.js';

const root = document.getElementById('major-order');
let signature = null;
let expiresAt = null;
let tickTimer = null;

/** A cheap value-identity of the order, so we only rebuild when it changes. */
function signatureOf(order) {
  // The status is part of the signature so the empty state can distinguish
  // "High Command issued no order" from "we cannot reach High Command".
  if (!order) return `none:${state.status}`;
  return JSON.stringify([
    order.id, order.title, order.briefing,
    order.tasks.map((t) => [t.type, t.current, t.goal, t.planetRef]),
    // Objectives name their planet once the planet list lands, so a rebuild
    // has to be triggered when it does.
    state.planets.length > 0,
  ]);
}

function render() {
  const order = majorOrder();
  const next = signatureOf(order);
  if (next === signature) {
    updateCountdown();
    return;
  }
  signature = next;

  if (!order) {
    expiresAt = null;
    const unreachable = state.status === 'down';
    root.innerHTML = `
      <div class="mo mo--empty">
        <p class="mo__title">${unreachable ? 'MAJOR ORDER UNAVAILABLE' : 'NO ACTIVE MAJOR ORDER'}</p>
        <p class="mo__brief">${unreachable
          ? 'Orders cannot be retrieved while the uplink is down. Any standing directive remains in force.'
          : 'High Command has issued no directive. Await further orders, Helldiver.'}</p>
      </div>`;
    return;
  }

  expiresAt = order.expiresAt;

  const reward = order.reward || order.rewards[0];
  const rewardHtml = reward && reward.amount
    ? `<div class="mo__reward">
         <span class="mo__reward-amount">${full(reward.amount)}</span>
         <span class="mo__reward-label">${escapeHtml(reward.label)}</span>
       </div>`
    : '';

  // Prefer the briefing (the flavour text) and fall back to the terse
  // machine description when High Command has not written one.
  const body = order.briefing || order.description;
  const showDescription = order.briefing && order.description && order.briefing !== order.description;

  root.innerHTML = `
    <article class="mo" aria-labelledby="mo-title">
      <div class="mo__flag" aria-hidden="true"></div>
      <div class="mo__body">
        <header class="mo__header">
          <h2 class="mo__title" id="mo-title">${escapeHtml(order.title || 'MAJOR ORDER')}</h2>
          <div class="mo__timer">
            <span class="mo__timer-label">TIME REMAINING</span>
            <span class="mo__timer-value" data-countdown>--:--:--</span>
          </div>
        </header>
        ${body ? `<p class="mo__brief">${escapeHtml(body)}</p>` : ''}
        ${showDescription ? `<p class="mo__objective">${escapeHtml(order.description)}</p>` : ''}
        <div class="mo__tasks">
          ${order.tasks.map((task, i) => taskHtml(task, i, order)).join('')}
        </div>
        ${order.tasks.length > 1 ? summaryHtml(order) : ''}
      </div>
      ${rewardHtml}
    </article>`;

  bindPlanetLinks();
  updateCountdown();
}

/** Named objectives jump to their world on the map. */
function bindPlanetLinks() {
  for (const button of root.querySelectorAll('[data-goto]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.goto);
      selectPlanet(index);
      focusPlanet(index, { zoom: 3 });
    });
  }
}

function taskHtml(task, i, order) {
  const pct = Math.max(0, Math.min(100, task.percent));
  const complete = pct >= 100;
  const description = describeTask(task, state.planetsByIndex, i);

  // A binary objective has no meaningful running total — it is taken or it is not.
  const readout = description.binary
    ? (complete ? 'SECURED' : 'IN PROGRESS')
    : `${full(task.current)} / ${full(task.goal)}`;

  const needed = complete ? null : requiredRate(task, order.expiresAt);
  const pace = needed
    ? `needs ${compact(needed.perHour)}${description.unit === 'planet' ? ' planets' : ''}/h`
    : '';

  const named = description.planetIndex !== null;

  // On a named world the meaningful faction is whoever actually holds it, which
  // the planet list knows; the task's own race slot is a convention that says
  // little on a liberation objective.
  const planet = named ? state.planetsByIndex.get(description.planetIndex) : null;
  const accent = planet ? planet.currentOwner : description.faction;

  return `
    <div class="task ${complete ? 'is-complete' : ''} ${named ? 'is-planet' : ''}"
         ${named ? `data-planet="${description.planetIndex}"` : ''}>
      <div class="task__head">
        <span class="task__label">
          ${accent && FACTION_COLOR[accent] ? `<i class="task__dot" style="background:${FACTION_COLOR[accent]}"></i>` : ''}
          ${named
            ? `<button type="button" class="task__link" data-goto="${description.planetIndex}">${escapeHtml(description.label)}</button>`
            : escapeHtml(description.label)}
        </span>
        <span class="task__readout">${readout}</span>
      </div>
      <div class="task__bar" role="progressbar" aria-valuenow="${pct.toFixed(1)}"
           aria-valuemin="0" aria-valuemax="100"
           aria-label="${escapeHtml(description.label)}">
        <div class="task__fill" style="width:${pct}%"></div>
      </div>
      <span class="task__percent">${complete ? '✔' : percent(pct)}</span>
      ${pace ? `<span class="task__pace mono">${escapeHtml(pace)}</span>` : ''}
    </div>`;
}

/** Faction accent for an objective's dot, without importing the whole config. */
const FACTION_COLOR = {
  humans: '#3d8bff',
  terminids: '#ffa41f',
  automatons: '#ff4444',
  illuminate: '#a271ff',
};

/** Aggregate line under a multi-objective order. */
function summaryHtml(order) {
  const overall = orderProgress(order.tasks);
  const done = order.tasks.filter((t) => t.percent >= 100).length;
  return `
    <div class="mo__summary">
      <span class="mo__summary-label">ORDER PROGRESS</span>
      <span class="mo__summary-track">
        <span class="mo__summary-fill" style="width:${overall}%"></span>
      </span>
      <span class="mo__summary-value mono">${percent(overall)}</span>
      <span class="mo__summary-count mono">${done}/${order.tasks.length} objectives</span>
    </div>`;
}

function updateCountdown() {
  const node = root.querySelector('[data-countdown]');
  if (!node) return;
  if (!expiresAt) {
    node.textContent = 'NO DEADLINE';
    return;
  }
  const remaining = expiresAt - Date.now();
  node.textContent = countdown(remaining);
  node.classList.toggle('is-urgent', remaining > 0 && remaining < 6 * 3600_000);
  node.classList.toggle('is-expired', remaining <= 0);
}

export function initMajorOrder() {
  subscribe(render);
  render();
  clearInterval(tickTimer);
  tickTimer = setInterval(updateCountdown, 1000);
}
