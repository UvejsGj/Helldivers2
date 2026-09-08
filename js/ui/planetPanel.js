/**
 * Planet detail panel.
 *
 * Shows the selected planet on desktop as a side rail and on mobile as a
 * bottom sheet (purely a CSS difference — the markup is identical). When
 * nothing is selected it falls back to a list of active campaigns, which is
 * the more useful default than an empty box.
 */

import { FACTIONS, faction } from '../config.js';
import { selectPlanet, state, subscribe } from '../state.js';
import { compact, countdown, escapeHtml, full, percent, relativeTime } from '../format.js';
import { focusPlanet } from './map.js';
import { formatRate, projectionFor } from '../trend.js';

const root = document.getElementById('planet-panel');
let tickTimer = null;

function render() {
  const planet = state.selectedPlanet !== null
    ? state.planetsByIndex.get(state.selectedPlanet)
    : null;

  root.innerHTML = planet ? planetHtml(planet) : campaignListHtml();
  root.classList.toggle('is-detail', Boolean(planet));

  root.querySelector('[data-close]')?.addEventListener('click', () => selectPlanet(null));

  for (const node of root.querySelectorAll('[data-planet]')) {
    node.addEventListener('click', () => {
      const index = Number(node.dataset.planet);
      selectPlanet(index);
      focusPlanet(index, { zoom: 2.2 });
    });
  }
}

function planetHtml(planet) {
  const owner = faction(planet.currentOwner);
  const event = planet.event;
  const campaign = planet.campaign;
  const active = Boolean(event || campaign);

  // Which bar we show depends on what is happening: a defence counts down an
  // attacker's hold, a liberation counts up ours, and a quiet planet has neither.
  const barLabel = event ? 'DEFENCE PROGRESS' : campaign ? 'LIBERATION' : 'PLANET INTEGRITY';
  const barValue = active ? planet.liberation : (planet.maxHealth
    ? (planet.health / planet.maxHealth) * 100
    : 100);
  // A liberation bar measures how much of the planet is ours, so it fills in
  // Super Earth blue; a defence fills gold, the colour of the order to hold.
  const barColour = event ? '#f5c518' : campaign ? FACTIONS.humans.color : owner.color;

  const hazards = planet.hazards.length
    ? `<div class="pp__tags">${planet.hazards.map((h) =>
        `<span class="tag" title="${escapeHtml(h.description)}">${escapeHtml(h.name)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="pp">
      <header class="pp__head" style="--accent:${owner.color}">
        <div>
          <p class="pp__sector">${escapeHtml(planet.sector)} Sector · #${planet.index}</p>
          <h2 class="pp__name">${escapeHtml(planet.name)}</h2>
        </div>
        <button class="pp__close" type="button" data-close aria-label="Close planet details">✕</button>
      </header>

      <div class="pp__owner">
        <span class="pp__dot" style="background:${owner.color}"></span>
        <span class="pp__owner-label">${escapeHtml(owner.label)}</span>
        ${active ? `<span class="pp__badge ${event ? 'pp__badge--defend' : 'pp__badge--liberate'}">
          ${event ? 'UNDER ATTACK' : 'ACTIVE CAMPAIGN'}</span>` : ''}
        ${planet.disabled ? '<span class="pp__badge pp__badge--muted">INACCESSIBLE</span>' : ''}
      </div>

      <div class="pp__bar-block">
        <div class="pp__bar-head">
          <span>${barLabel}</span>
          <span class="mono">${percent(barValue, 2)}</span>
        </div>
        <div class="pp__bar" role="progressbar" aria-valuenow="${barValue.toFixed(2)}"
             aria-valuemin="0" aria-valuemax="100" aria-label="${barLabel}">
          <div class="pp__bar-fill" style="width:${Math.max(0, Math.min(100, barValue))}%;background:${barColour}"></div>
        </div>
        <div class="pp__bar-foot mono">
          <span>${event
            ? `${full(event.health)} / ${full(event.maxHealth)} HP held`
            : `${full(planet.health)} / ${full(planet.maxHealth)} HP`}</span>
          ${planet.regenPerSecond
            ? `<span title="Enemy reinforcement: health this planet recovers per hour">
                 +${compact(planet.regenPerSecond * 3600)} HP/hr regen</span>`
            : ''}
        </div>
      </div>

      ${active ? trendHtml(planet) : ''}
      ${event ? eventHtml(event) : ''}

      <dl class="pp__stats">
        ${stat('Divers deployed', full(planet.players))}
        ${stat('Biome', planet.biome ? escapeHtml(planet.biome.name) : '—')}
        ${stat('Missions won', compact(planet.statistics.missionsWon))}
        ${stat('Missions lost', compact(planet.statistics.missionsLost))}
        ${stat('Enemy kills', compact(
          planet.statistics.terminidKills
          + planet.statistics.automatonKills
          + planet.statistics.illuminateKills))}
        ${stat('Diver deaths', compact(planet.statistics.deaths))}
        ${stat('Coordinates', `${planet.position.x.toFixed(4)}, ${planet.position.y.toFixed(4)}`)}
        ${campaign ? stat('Operation', `#${campaign.id} · ${campaign.count} op${campaign.count === 1 ? '' : 's'}`) : ''}
      </dl>

      ${planet.biome?.description
        ? `<p class="pp__biome">${escapeHtml(planet.biome.description)}</p>` : ''}
      ${hazards}
      ${supplyHtml(planet)}
    </div>`;
}

/**
 * Rate of advance and what it implies.
 *
 * Deliberately says "measuring" rather than guessing when the observation
 * window is too short — a confident-looking ETA drawn from four minutes of
 * data would be worse than no ETA at all.
 */
function trendHtml(planet) {
  const projection = projectionFor(planet);

  if (!projection) {
    return `
      <div class="trend trend--waiting">
        <span class="trend__label">RATE OF ADVANCE</span>
        <span class="trend__value mono">MEASURING…</span>
        <p class="trend__note">Awaiting further readings.</p>
      </div>`;
  }

  const rate = formatRate(projection);
  const tone = projection.stalled ? 'stalled' : projection.losing ? 'bad' : 'good';

  let verdict;
  if (projection.kind === 'defence') {
    if (projection.onTrack === null) verdict = 'No deadline reported for this assault.';
    else if (projection.onTrack) {
      verdict = `Holding. On pace to repel with ${formatHours(projection.hoursLeft - (projection.etaHours ?? 0))} to spare.`;
    } else if (projection.losing) {
      verdict = 'Ground is being lost. This planet falls unless reinforced.';
    } else if (projection.stalled) {
      verdict = 'The line is not moving. This planet falls unless reinforced.';
    } else {
      verdict = `Too slow — projected ${projection.projected.toFixed(0)}% at expiry. Reinforcements needed.`;
    }
  } else if (projection.losing) {
    verdict = 'Ground is being lost faster than it is taken.';
  } else if (projection.stalled) {
    verdict = 'Liberation has stalled at this pace.';
  } else {
    verdict = `Liberated in about ${formatHours(projection.etaHours)} at this pace.`;
  }

  return `
    <div class="trend trend--${tone}">
      <span class="trend__label">RATE OF ADVANCE</span>
      <span class="trend__value mono">${escapeHtml(rate)}</span>
      <p class="trend__note">${escapeHtml(verdict)}</p>
      <p class="trend__basis mono">observed over ${formatHours(projection.spanHours)} · ${projection.samples} samples</p>
    </div>`;
}

/** Compact duration for projections: "3h 20m", "45m", "2d 4h". */
function formatHours(hours) {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) {
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    return minutes ? `${whole}h ${minutes}m` : `${whole}h`;
  }
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

function eventHtml(event) {
  const attacker = faction(event.faction);
  const remaining = event.endTime ? event.endTime - Date.now() : null;
  return `
    <div class="pp__event" style="--accent:${attacker.color}">
      <p class="pp__event-title">${escapeHtml(attacker.label)} assault in progress</p>
      <div class="pp__event-grid mono">
        <span>Ends in</span>
        <span data-event-countdown>${remaining === null ? '—' : countdown(remaining)}</span>
        <span>Began</span>
        <span>${event.startTime ? relativeTime(event.startTime) : '—'}</span>
      </div>
    </div>`;
}

function supplyHtml(planet) {
  const links = planet.waypoints
    .map((i) => state.planetsByIndex.get(i))
    .filter(Boolean);
  if (!links.length) return '';
  return `
    <div class="pp__links">
      <p class="pp__links-title">Supply lines</p>
      <div class="pp__links-list">
        ${links.map((p) => `
          <button type="button" class="link-chip" data-planet="${p.index}">
            <span class="pp__dot" style="background:${faction(p.currentOwner).color}"></span>
            ${escapeHtml(p.name)}
          </button>`).join('')}
      </div>
    </div>`;
}

/** Small signed rate beside the percentage, omitted until it means something. */
function rateChip(planet) {
  const projection = projectionFor(planet);
  if (!projection || projection.stalled) return '';
  const tone = projection.losing ? 'bad' : 'good';
  return `<span class="front__rate front__rate--${tone}">${escapeHtml(formatRate(projection))}</span>`;
}

function stat(label, value) {
  return `<div class="pp__stat"><dt>${escapeHtml(label)}</dt><dd class="mono">${value}</dd></div>`;
}

/** The default view: every planet with a live campaign, busiest first. */
function campaignListHtml() {
  const campaigns = state.campaignPlanets;

  if (!campaigns.length) {
    return `
      <div class="pp pp--empty">
        <h2 class="pp__name">ACTIVE FRONTS</h2>
        <p class="pp__hint">${state.status === 'down'
          ? 'No campaign data. Awaiting contact with High Command.'
          : 'No active campaigns reported. Select a planet on the map for details.'}</p>
      </div>`;
  }

  return `
    <div class="pp pp--list">
      <h2 class="pp__name">ACTIVE FRONTS <span class="pp__count">${campaigns.length}</span></h2>
      <p class="pp__hint">Select a world for full telemetry.</p>
      <ul class="front-list">
        ${campaigns.map((planet) => {
          const defending = Boolean(planet.event);
          // On a defence the interesting party is whoever is attacking us, not
          // the flag currently flying over the planet.
          const info = faction(defending ? planet.event.faction : planet.currentOwner);
          return `
            <li>
              <button type="button" class="front" data-planet="${planet.index}">
                <span class="front__bar" style="--accent:${info.color}"></span>
                <span class="front__body">
                  <span class="front__top">
                    <span class="front__name">${escapeHtml(planet.name)}</span>
                    <span class="front__players mono">${compact(planet.players)}</span>
                  </span>
                  <span class="front__meta">
                    <span class="front__faction" style="color:${info.color}">
                      ${defending ? 'DEFEND' : 'LIBERATE'} · ${escapeHtml(info.label)}
                    </span>
                    <span class="front__numbers mono">
                      ${rateChip(planet)}<span>${percent(planet.liberation)}</span>
                    </span>
                  </span>
                  <span class="front__track">
                    <span class="front__fill" style="width:${Math.min(100, planet.liberation)}%;
                      background:${defending ? '#f5c518' : info.color}"></span>
                  </span>
                </span>
              </button>
            </li>`;
        }).join('')}
      </ul>
    </div>`;
}

/** The defence countdown ticks locally between polls. */
function tick() {
  const node = root.querySelector('[data-event-countdown]');
  if (!node) return;
  const planet = state.selectedPlanet !== null
    ? state.planetsByIndex.get(state.selectedPlanet)
    : null;
  if (!planet?.event?.endTime) return;
  node.textContent = countdown(planet.event.endTime - Date.now());
}

export function initPlanetPanel() {
  subscribe(render);
  render();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
}
