/**
 * Liberation trend: how fast a front is actually moving, and what that implies.
 *
 * The API reports a position, never a velocity — but the question players
 * actually have is "will this planet fall in time?". Answering it means keeping
 * our own short history of liberation percentages and reading the slope.
 *
 * Samples live in localStorage so the history survives a reload, and only
 * planets with a live campaign are tracked, which keeps the store to a few
 * kilobytes rather than one series per planet in the galaxy.
 */

/**
 * Histories are kept per data source. The archive galaxy moves on its own
 * schedule, so mixing its samples with live ones would average across two
 * unrelated wars and report a rate belonging to neither.
 */
const STORE_KEYS = { live: 'sew:trend', mock: 'sew:trend:mock' };
let scope = 'live';

/**
 * Point the store at a data source. Called by the store when the source
 * changes; passed in rather than imported so this module stays free of any
 * dependency on the browser and can be unit-tested directly.
 */
export function setScope(next) {
  if (next === scope || !STORE_KEYS[next]) return;
  scope = next;
  series = load();
}

const storeKey = () => STORE_KEYS[scope];

/** Keep roughly six hours of history, at most this many points per planet. */
const MAX_AGE = 6 * 3600_000;
const MAX_SAMPLES = 24;

/** Do not record more often than this; consecutive polls barely differ. */
const MIN_SAMPLE_GAP = 90_000;

/**
 * Below this span the slope is dominated by rounding in the reported
 * percentage rather than by the battle, so we report no rate at all instead of
 * a confident-looking wrong one.
 */
const MIN_SPAN_FOR_RATE = 12 * 60_000;
const MIN_SAMPLES_FOR_RATE = 3;

/** index -> [[epochMs, liberationPercent], ...], oldest first. */
let series = new Map();

function load() {
  try {
    const raw = localStorage.getItem(storeKey());
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return new Map();
    const map = new Map();
    for (const [key, points] of Object.entries(parsed)) {
      if (!Array.isArray(points)) continue;
      const clean = points
        .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (clean.length) map.set(Number(key), clean);
    }
    return map;
  } catch {
    // Blocked storage or corrupt JSON: start over in memory.
    return new Map();
  }
}

function save() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(Object.fromEntries(series)));
  } catch {
    // Quota or private mode. History is a nicety, not a requirement.
  }
}

series = load();

/**
 * Record the current liberation reading for every planet with a live campaign.
 * Call after each successful planets refresh.
 */
export function recordSamples(planets) {
  const now = Date.now();
  let changed = false;

  for (const planet of planets) {
    if (!planet.campaign && !planet.event) continue;

    const points = series.get(planet.index) || [];
    const last = points[points.length - 1];

    // A planet that flipped owner starts a new fight; the old series would
    // otherwise average across a discontinuity and report nonsense.
    if (last && planet.liberation < last[1] - 40) {
      series.set(planet.index, [[now, planet.liberation]]);
      changed = true;
      continue;
    }

    if (last && now - last[0] < MIN_SAMPLE_GAP) continue;

    points.push([now, planet.liberation]);
    const pruned = points
      .filter(([t]) => now - t <= MAX_AGE)
      .slice(-MAX_SAMPLES);
    series.set(planet.index, pruned);
    changed = true;
  }

  // Expire by age, not by absence from `planets`.
  //
  // The store rebuilds the planet graph as each feed lands, so this is called
  // once with only the defence events known and again once campaigns arrive.
  // Deleting every series missing from that partial list would wipe the whole
  // history on every page load — the bug this replaced. Age expiry bounds the
  // store just as well and does not care what order the feeds turn up in.
  for (const [index, points] of series) {
    const newest = points.length ? points[points.length - 1][0] : 0;
    if (now - newest > MAX_AGE) {
      series.delete(index);
      changed = true;
    }
  }

  if (changed) save();
}

/**
 * Least-squares slope of liberation against time, in percent per hour.
 *
 * Regression rather than first-vs-last: a single noisy endpoint would otherwise
 * swing the reading, and campaigns genuinely do stall and restart.
 */
export function rateFor(index) {
  const points = series.get(index);
  if (!points || points.length < MIN_SAMPLES_FOR_RATE) return null;

  const spanMs = points[points.length - 1][0] - points[0][0];
  if (spanMs < MIN_SPAN_FOR_RATE) return null;

  const n = points.length;
  const hours = points.map(([t]) => t / 3600_000);
  const meanX = hours.reduce((a, b) => a + b, 0) / n;
  const meanY = points.reduce((a, [, y]) => a + y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = hours[i] - meanX;
    numerator += dx * (points[i][1] - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;

  return {
    perHour: numerator / denominator,
    spanHours: spanMs / 3600_000,
    samples: n,
  };
}

/**
 * Turn a rate into the thing worth saying out loud.
 *
 * Liberation: how long until the planet is ours at this pace.
 * Defence: whether the current pace clears 100% before the event expires.
 * Either way, `null` when we have not watched long enough to know.
 */
export function projectionFor(planet) {
  const rate = rateFor(planet.index);
  if (!rate) return null;

  const remaining = 100 - planet.liberation;
  const defence = Boolean(planet.event);
  const perHour = rate.perHour;

  // Under a tenth of a percent an hour is noise, not progress.
  const stalled = Math.abs(perHour) < 0.1;
  const etaHours = !stalled && perHour > 0 ? remaining / perHour : null;

  if (!defence) {
    return {
      kind: 'liberation', perHour, stalled, etaHours,
      spanHours: rate.spanHours, samples: rate.samples,
      losing: perHour < -0.1,
    };
  }

  const endTime = planet.event.endTime;
  const hoursLeft = endTime ? (endTime - Date.now()) / 3600_000 : null;
  const projected = hoursLeft === null ? null : planet.liberation + perHour * hoursLeft;

  return {
    kind: 'defence', perHour, stalled, etaHours,
    spanHours: rate.spanHours, samples: rate.samples,
    losing: perHour < -0.1,
    hoursLeft,
    projected,
    // Null rather than false when there is no deadline to measure against.
    onTrack: projected === null ? null : projected >= 100,
  };
}

/** Human-readable rate, e.g. "+2.4%/h" or "stalled". */
export function formatRate(projection) {
  if (!projection) return null;
  if (projection.stalled) return 'stalled';
  const sign = projection.perHour > 0 ? '+' : '';
  return `${sign}${projection.perHour.toFixed(2)}%/h`;
}

/**
 * The stored history for one planet, oldest first, as [epochMs, percent] pairs.
 * A copy, so a caller cannot mutate the series out from under the maths.
 */
export function seriesFor(index) {
  const points = series.get(index);
  return points ? points.map((p) => [p[0], p[1]]) : [];
}

/** Only used by the tests and by a hard reset. */
export function clearTrends() {
  series = new Map();
  try { localStorage.removeItem(storeKey()); } catch { /* ignore */ }
}
