/**
 * War statistics panel — the galaxy-wide totals from /war, plus the faction
 * control split derived from the planet list.
 *
 * No chart library: the only shapes needed are a stacked control bar and a set
 * of proportional kill bars, both of which are a div with a width.
 */

import { FACTIONS, faction } from '../config.js';
import { factionControl, state, subscribe, totalPlayers } from '../state.js';
import { compact, duration, escapeHtml, full, percent } from '../format.js';

const root = document.getElementById('war-stats');

function render() {
  const stats = state.war?.statistics;

  if (!stats) {
    root.innerHTML = `
      <div class="panel__empty">
        <p>No war statistics available.</p>
      </div>`;
    return;
  }

  const control = factionControl();
  const totalPlanets = Object.values(control).reduce((a, b) => a + b, 0) || 1;
  const kills = [
    ['terminids', stats.terminidKills],
    ['automatons', stats.automatonKills],
    ['illuminate', stats.illuminateKills],
  ];
  const killTotal = kills.reduce((sum, [, n]) => sum + n, 0) || 1;
  const maxKills = Math.max(...kills.map(([, n]) => n), 1);
  const missionsTotal = stats.missionsWon + stats.missionsLost;

  root.innerHTML = `
    <div class="stats">
      <div class="stats__headline">
        ${headline('DIVERS DEPLOYED', full(totalPlayers()), 'live')}
        ${headline('MISSION SUCCESS', percent(stats.missionSuccessRate, 1))}
        ${headline('ACCURACY', percent(stats.accuracy, 1))}
        ${headline('IMPACT MULTIPLIER', (state.war.impactMultiplier || 0).toFixed(4))}
      </div>

      <section class="stats__block">
        <h3 class="stats__title">GALACTIC CONTROL</h3>
        <div class="control-bar" role="img"
             aria-label="${controlLabel(control, totalPlanets)}">
          ${Object.keys(FACTIONS)
            .filter((key) => key !== 'unknown' && control[key] > 0)
            .map((key) => `<span class="control-bar__seg"
                 style="width:${(control[key] / totalPlanets) * 100}%;background:${FACTIONS[key].color}"
                 title="${FACTIONS[key].label}: ${control[key]} planets"></span>`).join('')}
        </div>
        <ul class="legend">
          ${Object.keys(FACTIONS).filter((key) => key !== 'unknown').map((key) => `
            <li class="legend__item">
              <span class="legend__dot" style="background:${FACTIONS[key].color}"></span>
              <span class="legend__label">${escapeHtml(FACTIONS[key].label)}</span>
              <span class="legend__value mono">${control[key] || 0}</span>
            </li>`).join('')}
        </ul>
      </section>

      <section class="stats__block">
        <h3 class="stats__title">CONFIRMED KILLS</h3>
        <ul class="kill-list">
          ${kills.map(([key, value]) => {
            const info = faction(key);
            return `
              <li class="kill">
                <div class="kill__head">
                  <span class="kill__name" style="color:${info.color}">${escapeHtml(info.label)}</span>
                  <span class="kill__value mono">${compact(value)}</span>
                </div>
                <div class="kill__track">
                  <div class="kill__fill" style="width:${(value / maxKills) * 100}%;background:${info.color}"></div>
                </div>
                <span class="kill__share mono">${percent((value / killTotal) * 100, 1)} of all kills</span>
              </li>`;
          }).join('')}
        </ul>
      </section>

      <section class="stats__block">
        <h3 class="stats__title">MISSIONS</h3>
        <div class="split-bar" role="img"
             aria-label="${full(stats.missionsWon)} missions won, ${full(stats.missionsLost)} lost">
          <span class="split-bar__won"
                style="width:${(stats.missionsWon / (missionsTotal || 1)) * 100}%"></span>
          <span class="split-bar__lost"
                style="width:${(stats.missionsLost / (missionsTotal || 1)) * 100}%"></span>
        </div>
        <div class="split-legend mono">
          <span class="split-legend__won">WON ${compact(stats.missionsWon)}</span>
          <span class="split-legend__lost">LOST ${compact(stats.missionsLost)}</span>
        </div>
      </section>

      <section class="stats__block">
        <h3 class="stats__title">SACRIFICE LEDGER</h3>
        <dl class="ledger">
          ${row('Helldivers lost', full(stats.deaths))}
          ${row('Revives', full(stats.revives))}
          ${row('Friendly fire deaths', full(stats.friendlies), 'is-shame')}
          ${row('Bullets fired', full(stats.bulletsFired))}
          ${row('Bullets hit', full(stats.bulletsHit))}
          ${row('Time played', duration(stats.timePlayed))}
          ${row('Mission time', duration(stats.missionTime))}
        </dl>
        <p class="stats__footnote">
          Friendly fire is a statistical inevitability and not, in itself, evidence of treason.
        </p>
      </section>
    </div>`;
}

function headline(label, value, flag) {
  return `
    <div class="headline ${flag ? `headline--${flag}` : ''}">
      <span class="headline__label">${escapeHtml(label)}</span>
      <span class="headline__value mono">${value}</span>
    </div>`;
}

function row(label, value, className = '') {
  return `
    <div class="ledger__row ${className}">
      <dt>${escapeHtml(label)}</dt>
      <dd class="mono">${value}</dd>
    </div>`;
}

function controlLabel(control, total) {
  return Object.keys(FACTIONS)
    .filter((key) => key !== 'unknown' && control[key] > 0)
    .map((key) => `${FACTIONS[key].label} ${((control[key] / total) * 100).toFixed(0)}%`)
    .join(', ');
}

export function initStats() {
  subscribe(render);
  render();
}
