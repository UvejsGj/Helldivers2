/**
 * Trend maths.
 *
 * trend.js touches localStorage at import time, so the module gets a tiny
 * in-memory stand-in rather than a DOM harness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { clearTrends, formatRate, projectionFor, recordSamples, rateFor } =
  await import('../js/trend.js');

const HOUR = 3600_000;

/** Write a synthetic history directly, so the tests control the clock. */
function seed(index, points) {
  store.set('sew:trend', JSON.stringify({ [index]: points }));
}

/** Re-import with a fresh module registry so the seeded store is read. */
async function freshModule() {
  return import(`../js/trend.js?${Math.random()}`);
}

test('no rate until the observation window is long enough', async () => {
  const now = Date.now();
  seed(1, [[now - 60_000, 10], [now - 30_000, 11], [now, 12]]);
  const trend = await freshModule();
  assert.equal(trend.rateFor(1), null, 'three minutes is not enough to call a slope');
});

test('no rate from a single sample', async () => {
  seed(2, [[Date.now(), 40]]);
  const trend = await freshModule();
  assert.equal(trend.rateFor(2), null);
});

test('a steady climb reads as a positive rate', async () => {
  const now = Date.now();
  // 5%/hour over three hours.
  seed(3, [[now - 3 * HOUR, 10], [now - 2 * HOUR, 15], [now - HOUR, 20], [now, 25]]);
  const trend = await freshModule();
  const rate = trend.rateFor(3);
  assert.ok(rate, 'rate is available');
  assert.ok(Math.abs(rate.perHour - 5) < 0.01, `expected ~5, got ${rate.perHour}`);
  assert.equal(rate.samples, 4);
});

test('regression resists a single noisy reading', async () => {
  const now = Date.now();
  const clean = [[now - 3 * HOUR, 10], [now - 2 * HOUR, 15], [now - HOUR, 20], [now, 25]];
  const noisy = [...clean];
  noisy[2] = [now - HOUR, 5]; // one bad poll
  const trend = await freshModule();

  seed(4, noisy);
  const noisyRate = (await freshModule()).rateFor(4);
  // A first-vs-last reading would be unaffected here, but the slope should
  // still land in the right region rather than swinging wildly.
  assert.ok(noisyRate.perHour > 2 && noisyRate.perHour < 8, `got ${noisyRate.perHour}`);
});

test('liberation projection gives an ETA to 100%', async () => {
  const now = Date.now();
  seed(5, [[now - 2 * HOUR, 60], [now - HOUR, 70], [now, 80]]);
  const trend = await freshModule();
  const projection = trend.projectionFor({ index: 5, liberation: 80, event: null });
  assert.equal(projection.kind, 'liberation');
  assert.ok(Math.abs(projection.perHour - 10) < 0.01);
  assert.ok(Math.abs(projection.etaHours - 2) < 0.05, 'twenty points at ten an hour');
  assert.equal(projection.losing, false);
});

test('a retreat is reported as losing ground, with no ETA', async () => {
  const now = Date.now();
  seed(6, [[now - 2 * HOUR, 80], [now - HOUR, 70], [now, 60]]);
  const trend = await freshModule();
  const projection = trend.projectionFor({ index: 6, liberation: 60, event: null });
  assert.ok(projection.perHour < 0);
  assert.equal(projection.losing, true);
  assert.equal(projection.etaHours, null, 'no ETA when the line is going backwards');
});

test('a defence is judged against its deadline', async () => {
  const now = Date.now();
  seed(7, [[now - 2 * HOUR, 50], [now - HOUR, 60], [now, 70]]);
  const trend = await freshModule();

  // 10%/h with 30 points to go and 5 hours left: comfortably held.
  const holding = trend.projectionFor({
    index: 7, liberation: 70, event: { endTime: now + 5 * HOUR },
  });
  assert.equal(holding.kind, 'defence');
  assert.equal(holding.onTrack, true);

  // Same pace, one hour left: it falls.
  const falling = trend.projectionFor({
    index: 7, liberation: 70, event: { endTime: now + HOUR },
  });
  assert.equal(falling.onTrack, false);
  assert.ok(Math.abs(falling.projected - 80) < 0.5);
});

test('a defence with no deadline reports onTrack as unknown, not false', async () => {
  const now = Date.now();
  seed(8, [[now - 2 * HOUR, 50], [now - HOUR, 60], [now, 70]]);
  const trend = await freshModule();
  const projection = trend.projectionFor({ index: 8, liberation: 70, event: { endTime: null } });
  assert.equal(projection.onTrack, null);
});

test('a flat line reads as stalled rather than a tiny rate', async () => {
  const now = Date.now();
  seed(9, [[now - 2 * HOUR, 40], [now - HOUR, 40.01], [now, 40.02]]);
  const trend = await freshModule();
  const projection = trend.projectionFor({ index: 9, liberation: 40.02, event: null });
  assert.equal(projection.stalled, true);
  assert.equal(trend.formatRate(projection), 'stalled');
});

test('recordSamples restarts the series when a planet flips owner', async () => {
  store.clear();
  const trend = await freshModule();
  trend.recordSamples([{ index: 20, liberation: 95, campaign: {}, event: null }]);
  // A recapture drops liberation to near zero: the old series must not be
  // averaged across the discontinuity.
  trend.recordSamples([{ index: 20, liberation: 2, campaign: {}, event: null }]);
  const stored = JSON.parse(store.get('sew:trend'));
  assert.equal(stored['20'].length, 1);
  assert.equal(stored['20'][0][1], 2);
});

test('a partial feed does not wipe the history', async () => {
  // Regression: the planet graph is rebuilt as each feed lands, so this runs
  // once before /campaigns has arrived. Pruning on that partial list used to
  // delete every series on each page load, so no trend ever accumulated.
  store.clear();
  const trend = await freshModule();
  trend.recordSamples([{ index: 30, liberation: 10, campaign: {}, event: null }]);
  assert.ok(JSON.parse(store.get('sew:trend'))['30'], 'recorded');

  trend.recordSamples([]);                       // planets known, campaigns not yet
  assert.ok(JSON.parse(store.get('sew:trend'))['30'], 'history survives the empty pass');

  trend.recordSamples([{ index: 99, liberation: 5, campaign: {}, event: null }]);
  const after = JSON.parse(store.get('sew:trend'));
  assert.ok(after['30'] && after['99'], 'both series retained');
});

test('history expires by age rather than by absence', async () => {
  const now = Date.now();
  const stale = now - 9 * HOUR;   // older than the six-hour window
  store.set('sew:trend', JSON.stringify({ 40: [[stale, 10], [stale + 60_000, 12]] }));
  const trend = await freshModule();
  trend.recordSamples([{ index: 41, liberation: 5, campaign: {}, event: null }]);
  const after = JSON.parse(store.get('sew:trend'));
  assert.equal(after['40'], undefined, 'stale series dropped');
  assert.ok(after['41'], 'current series kept');
});

test('formatRate signs the number', async () => {
  const trend = await freshModule();
  assert.equal(trend.formatRate({ perHour: 2.456, stalled: false }), '+2.46%/h');
  assert.equal(trend.formatRate({ perHour: -1.5, stalled: false }), '-1.50%/h');
  assert.equal(trend.formatRate(null), null);
});
