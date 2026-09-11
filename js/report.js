/**
 * The war as plain text, for pasting somewhere else.
 *
 * Community dashboards get screenshotted into Discord because nothing else
 * leaves the page. A text summary pastes cleanly, stays readable in a monospace
 * channel, and carries the numbers a screenshot makes people squint at.
 *
 * Pure: takes a snapshot, returns a string.
 */

import { FACTIONS, faction } from './config.js';
import { compact, countdown, full, percent } from './format.js';

const RULE = '─'.repeat(46);

/**
 * Build the report. `fronts` is `[{ planet, priority }]` already ordered, so
 * the text matches what is on screen rather than re-deriving its own order.
 */
export function buildReport(state, fronts, rateFor) {
  const lines = [];
  const day = state.war?.started
    ? Math.max(1, Math.floor((Date.now() - state.war.started) / 86400000) + 1)
    : null;

  lines.push(`SUPER EARTH WATCH${day ? ` — WAR DAY ${full(day)}` : ''}`);
  lines.push(RULE);

  const order = state.assignments[0];
  if (order) {
    lines.push(order.title || 'MAJOR ORDER');
    if (order.description) lines.push(`  ${order.description}`);
    order.tasks.forEach((task, i) => {
      const bar = meter(task.percent);
      const counts = task.goal > 1 ? `  ${full(task.current)}/${full(task.goal)}` : '';
      lines.push(`  ${String(i + 1).padStart(2, '0')} ${bar} ${percent(task.percent, 1).padStart(6)}${counts}`);
    });
    if (order.expiresAt) lines.push(`  Expires in ${countdown(order.expiresAt - Date.now())}`);
    lines.push('');
  }

  if (fronts.length) {
    lines.push(`ACTIVE FRONTS (${fronts.length})`);
    for (const { planet, priority } of fronts) {
      const defending = Boolean(planet.event);
      const enemy = faction(defending ? planet.event.faction : planet.currentOwner).label;
      const rate = rateFor ? rateFor(planet) : null;
      lines.push(
        `  ${priority.label.padEnd(8)} ${planet.name.padEnd(20)} `
        + `${(defending ? 'DEFEND' : 'LIBERATE').padEnd(8)} ${enemy.padEnd(11)} `
        + `${percent(planet.liberation, 1).padStart(6)}  ${compact(planet.players).padStart(6)} divers`
        + (rate ? `  ${rate}` : ''),
      );
    }
    lines.push('');
  }

  const control = countControl(state.planets);
  const total = Object.values(control).reduce((a, b) => a + b, 0);
  if (total) {
    lines.push('GALACTIC CONTROL');
    lines.push('  ' + Object.keys(FACTIONS)
      .filter((key) => key !== 'unknown' && control[key])
      .map((key) => `${FACTIONS[key].label} ${control[key]} (${Math.round((control[key] / total) * 100)}%)`)
      .join('  ·  '));
  }

  const stats = state.war?.statistics;
  if (stats) {
    lines.push('');
    lines.push(`DIVERS DEPLOYED  ${full(stats.playerCount)}`);
    lines.push(`KILLS  TRM ${compact(stats.terminidKills)}  `
      + `AUT ${compact(stats.automatonKills)}  ILL ${compact(stats.illuminateKills)}`);
  }

  return lines.join('\n');
}

/** A twenty-cell progress meter that survives a proportional font. */
function meter(pct) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 20);
  return `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;
}

function countControl(planets) {
  const counts = {};
  for (const planet of planets) {
    counts[planet.currentOwner] = (counts[planet.currentOwner] || 0) + 1;
  }
  return counts;
}

/**
 * Put text on the clipboard.
 *
 * The async clipboard API needs a secure context and permission, and is simply
 * unavailable in some embeds — so there is a selection-based fallback, and the
 * caller is told which path (if either) worked.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable; fall through to the old way.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen but focusable: display:none would not be selectable.
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
