/**
 * Major Order banner — the current assignment from High Command.
 *
 * The countdown ticks every second off a locally-held expiry timestamp; the
 * rest of the banner only re-renders when the assignment payload changes, so a
 * poll landing mid-read does not flicker the text.
 */

import { majorOrder, state, subscribe } from '../state.js';
import { countdown, escapeHtml, full, percent } from '../format.js';

const root = document.getElementById('major-order');
let signature = null;
let expiresAt = null;
let tickTimer = null;

/** A cheap value-identity of the order, so we only rebuild when it changes. */
function signatureOf(order) {
  // The status is part of the signature so the empty state can distinguish
  // "High Command issued no order" from "we cannot reach High Command".
  if (!order) return `none:${state.status}`;
  return JSON.stringify([order.id, order.title, order.briefing, order.tasks.map((t) => [t.current, t.goal])]);
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
        <div class="mo__tasks">${order.tasks.map(taskHtml).join('')}</div>
      </div>
      ${rewardHtml}
    </article>`;

  updateCountdown();
}

function taskHtml(task, i) {
  const pct = Math.max(0, Math.min(100, task.percent));
  const complete = pct >= 100;
  // Binary objectives ("hold the line") have no meaningful running total.
  const isBinary = task.goal <= 1;
  const readout = isBinary
    ? (complete ? 'COMPLETE' : 'IN PROGRESS')
    : `${full(task.current)} / ${full(task.goal)}`;

  return `
    <div class="task ${complete ? 'is-complete' : ''}">
      <div class="task__head">
        <span class="task__label">OBJECTIVE ${String(i + 1).padStart(2, '0')}</span>
        <span class="task__readout">${readout}</span>
      </div>
      <div class="task__bar" role="progressbar" aria-valuenow="${pct.toFixed(1)}"
           aria-valuemin="0" aria-valuemax="100"
           aria-label="Objective ${i + 1} progress">
        <div class="task__fill" style="width:${pct}%"></div>
      </div>
      <span class="task__percent">${percent(pct)}</span>
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
