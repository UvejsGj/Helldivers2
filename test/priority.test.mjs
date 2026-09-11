/**
 * Front priority scoring.
 *
 * The ordering claims are what matter: a defence on a clock outranks a slow
 * offensive, and an unmeasured front never pretends to a verdict it cannot
 * support.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { byPriority, priorityOf, TIERS } from '../js/priority.js';

const planet = (over = {}) => ({ index: 1, name: 'X', players: 1000, liberation: 50, event: null, ...over });
const projection = (over = {}) => ({
  kind: 'liberation', perHour: 5, stalled: false, losing: false,
  etaHours: 10, spanHours: 3, samples: 4, ...over,
});

test('without a projection the verdict stays neutral and says so', () => {
  const offensive = priorityOf(planet(), null);
  assert.equal(offensive.tier, 'steady');
  assert.match(offensive.reason, /not yet measured/);

  const defence = priorityOf(planet({ event: { faction: 'automatons' } }), null);
  assert.equal(defence.tier, 'urgent', 'an unmeasured attack still outranks an unmeasured advance');
});

test('a defence projected to fail is critical', () => {
  const p = priorityOf(
    planet({ event: { faction: 'terminids' }, liberation: 60 }),
    projection({ kind: 'defence', onTrack: false, projected: 72, hoursLeft: 3 }),
  );
  assert.equal(p.tier, 'critical');
  assert.match(p.reason, /72%/);
});

test('a defence on pace is holding, not urgent', () => {
  const p = priorityOf(
    planet({ event: { faction: 'terminids' } }),
    projection({ kind: 'defence', onTrack: true, projected: 130, hoursLeft: 5 }),
  );
  assert.equal(p.tier, 'holding');
});

test('a defence with no deadline is urgent rather than judged', () => {
  const p = priorityOf(
    planet({ event: { faction: 'terminids' } }),
    projection({ kind: 'defence', onTrack: null, projected: null, hoursLeft: null }),
  );
  assert.equal(p.tier, 'urgent');
  assert.match(p.reason, /no deadline/i);
});

test('losing ground on an offensive is urgent', () => {
  const p = priorityOf(planet(), projection({ losing: true, perHour: -4, etaHours: null }));
  assert.equal(p.tier, 'urgent');
});

test('a liberation within reach is a push', () => {
  const p = priorityOf(planet({ liberation: 92 }), projection({ etaHours: 2, perHour: 4 }));
  assert.equal(p.tier, 'push');
  assert.match(p.reason, /within reach/);
});

test('a distant advance is merely steady', () => {
  const p = priorityOf(planet({ liberation: 10 }), projection({ etaHours: 40, perHour: 2 }));
  assert.equal(p.tier, 'steady');
});

test('a stall is steady, and scored worse the further it has to go', () => {
  const near = priorityOf(planet({ liberation: 90 }), projection({ stalled: true }));
  const far = priorityOf(planet({ liberation: 10 }), projection({ stalled: true }));
  assert.equal(near.tier, 'steady');
  assert.ok(far.score > near.score, 'further from done sorts later within the tier');
});

test('tiers sort in the declared order', () => {
  const rows = [
    { planet: planet({ players: 1 }), priority: priorityOf(planet({ liberation: 10 }), projection({ etaHours: 40 })) },
    { planet: planet({ players: 1 }), priority: priorityOf(planet({ event: {} }), projection({ kind: 'defence', onTrack: false, projected: 50, hoursLeft: 2 })) },
    { planet: planet({ players: 1 }), priority: priorityOf(planet({ liberation: 95 }), projection({ etaHours: 1 })) },
  ];
  const order = [...rows].sort(byPriority).map((r) => r.priority.tier);
  assert.deepEqual(order, ['critical', 'push', 'steady']);
});

test('equal priority breaks toward the busier front', () => {
  const shared = priorityOf(planet(), projection({ etaHours: 40 }));
  const rows = [
    { planet: planet({ players: 10 }), priority: shared },
    { planet: planet({ players: 900 }), priority: shared },
  ];
  assert.equal([...rows].sort(byPriority)[0].planet.players, 900);
});

test('every tier label is unique', () => {
  const labels = Object.values(TIERS).map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length);
});
