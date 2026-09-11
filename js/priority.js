/**
 * Which front needs bodies.
 *
 * The API reports where every fight is; it does not rank them, and "where
 * should I dive" is the question a war tracker actually gets opened to answer.
 * Ranking is arithmetic over things already on screen — liberation, the
 * measured rate, the defence deadline — so nothing here is invented.
 *
 * Pure over a planet plus its projection, so the scoring is testable without a
 * DOM, a network, or a stored history.
 */

/** Tiers, worst first. The label is what the reader sees. */
export const TIERS = {
  critical: { rank: 0, label: 'CRITICAL' },
  urgent: { rank: 1, label: 'URGENT' },
  push: { rank: 2, label: 'PUSH' },
  steady: { rank: 3, label: 'STEADY' },
  holding: { rank: 4, label: 'HOLDING' },
};

/**
 * Score one front. `projection` is trend.projectionFor(planet), or null when
 * the war has not been watched long enough to have a rate yet.
 *
 * Returns `{ tier, label, score, reason }`. `score` sorts ascending: lower is
 * more urgent. Without a projection the verdict is deliberately neutral —
 * guessing urgency from a single snapshot would be a confident-looking lie.
 */
export function priorityOf(planet, projection) {
  const defence = Boolean(planet.event);
  const remaining = Math.max(0, 100 - planet.liberation);

  if (!projection) {
    return defence
      ? tier('urgent', 0.5, 'Under attack. Rate not yet measured.')
      : tier('steady', 0.5, 'Liberation under way. Rate not yet measured.');
  }

  if (defence) {
    // A defence that will not finish before its deadline is the one thing on
    // the map that is actively being lost on a clock.
    if (projection.onTrack === false) {
      const hours = projection.hoursLeft ?? 0;
      // Sooner and further behind both make it worse.
      const shortfall = Math.max(0, 100 - (projection.projected ?? 0)) / 100;
      return tier('critical', clamp01(hours / 24) * 0.5 + (1 - shortfall) * 0.5,
        projection.stalled || projection.losing
          ? 'Losing ground with a deadline running.'
          : `Too slow — projected ${Math.round(projection.projected)}% at expiry.`);
    }
    if (projection.onTrack === true) {
      return tier('holding', 1 - clamp01(planet.liberation / 100),
        'On pace to repel without reinforcement.');
    }
    return tier('urgent', 0.5, 'Under attack, with no deadline reported.');
  }

  // Offensives: ground being lost outranks one that is merely slow.
  if (projection.losing) {
    return tier('urgent', clamp01(1 - Math.min(1, Math.abs(projection.perHour) / 10)),
      'Ground is being lost faster than it is taken.');
  }

  if (projection.stalled) {
    return tier('steady', 1 - clamp01(planet.liberation / 100), 'Stalled at this pace.');
  }

  // Close to flipping and still moving: the cheapest win on the board.
  const etaHours = projection.etaHours ?? Infinity;
  if (etaHours <= 12) {
    return tier('push', clamp01(etaHours / 12),
      `Liberation within reach — about ${formatHours(etaHours)} at this pace.`);
  }

  return tier('steady', clamp01(remaining / 100), 'Advancing.');
}

function tier(key, within, reason) {
  const t = TIERS[key];
  // Sort key: tier first, then position inside it.
  return { tier: key, label: t.label, score: t.rank + clamp01(within), reason };
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 1));

function formatHours(hours) {
  if (!Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  return `${Math.round(hours)}h`;
}

/** Sort a list of `{ planet, priority }` most urgent first. */
export function byPriority(a, b) {
  return a.priority.score - b.priority.score || b.planet.players - a.planet.players;
}
