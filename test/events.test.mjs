/**
 * War event detection.
 *
 * These are the cases that matter: priming must stay silent, a flip must not
 * also report the campaign churn around it, and a defence that ends has two
 * completely different meanings depending on who holds the planet afterwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { diffSnapshots, snapshotOf } from '../js/events.js';

/** Minimal store shape, with only the fields snapshotOf reads. */
function store(planets, { assignments = [], dispatches = [] } = {}) {
  return { planets, assignments, dispatches };
}

const planet = (over = {}) => ({
  index: 1, name: 'Fenrir III', currentOwner: 'terminids', liberation: 40,
  players: 1000, campaign: null, event: null, ...over,
});

const kinds = (events) => events.map((e) => e.kind);

test('the first observation primes and emits nothing', () => {
  const after = snapshotOf(store([planet()]));
  assert.deepEqual(diffSnapshots(null, after), [], 'no baseline, no events');
});

test('an unchanged war produces no events', () => {
  const a = snapshotOf(store([planet()]));
  const b = snapshotOf(store([planet()]));
  assert.deepEqual(diffSnapshots(a, b), []);
});

test('a planet taken from the enemy is a liberation', () => {
  const before = snapshotOf(store([planet({ currentOwner: 'automatons' })]));
  const after = snapshotOf(store([planet({ currentOwner: 'humans' })]));
  const [event] = diffSnapshots(before, after);
  assert.equal(event.kind, 'liberated');
  assert.equal(event.severity, 'good');
  assert.equal(event.planetIndex, 1);
  assert.match(event.title, /FENRIR III/);
});

test('a planet lost to the enemy is critical, and names the faction', () => {
  const before = snapshotOf(store([planet({ currentOwner: 'humans' })]));
  const after = snapshotOf(store([planet({ currentOwner: 'terminids' })]));
  const [event] = diffSnapshots(before, after);
  assert.equal(event.kind, 'captured');
  assert.equal(event.severity, 'critical');
  assert.equal(event.faction, 'terminids');
});

test('a flip reports the flip alone, not the campaign churn around it', () => {
  // A planet changing hands also loses its campaign in the same payload; both
  // firing would double-report one event.
  const before = snapshotOf(store([planet({ currentOwner: 'humans', event: { faction: 'automatons' } })]));
  const after = snapshotOf(store([planet({ currentOwner: 'automatons', event: null })]));
  assert.deepEqual(kinds(diffSnapshots(before, after)), ['captured']);
});

test('a defence beginning is reported with its attacker', () => {
  const before = snapshotOf(store([planet({ currentOwner: 'humans' })]));
  const after = snapshotOf(store([
    planet({ currentOwner: 'humans', event: { faction: 'automatons' } }),
  ]));
  const [event] = diffSnapshots(before, after);
  assert.equal(event.kind, 'defence');
  assert.equal(event.faction, 'automatons');
});

test('a defence ending on a planet we still hold is a win', () => {
  const before = snapshotOf(store([
    planet({ currentOwner: 'humans', event: { faction: 'terminids' } }),
  ]));
  const after = snapshotOf(store([planet({ currentOwner: 'humans', event: null })]));
  const [event] = diffSnapshots(before, after);
  assert.equal(event.kind, 'defence-held');
  assert.equal(event.severity, 'good');
});

test('an opening offensive is reported once', () => {
  const before = snapshotOf(store([planet()]));
  const after = snapshotOf(store([planet({ campaign: { id: 5 } })]));
  assert.deepEqual(kinds(diffSnapshots(before, after)), ['campaign']);
  // And not again on the next poll.
  const later = snapshotOf(store([planet({ campaign: { id: 5 } })]));
  assert.deepEqual(diffSnapshots(after, later), []);
});

test('a planet we had not seen before is not treated as a change', () => {
  const before = snapshotOf(store([planet({ index: 1 })]));
  const after = snapshotOf(store([planet({ index: 1 }), planet({ index: 2, name: 'New' })]));
  assert.deepEqual(diffSnapshots(before, after), []);
});

test('a new Major Order is announced', () => {
  const order = (id, percent) => ({ id, tasks: [{ percent }] });
  const before = snapshotOf(store([planet()], { assignments: [order(1, 50)] }));
  const after = snapshotOf(store([planet()], { assignments: [order(2, 0)] }));
  const [event] = diffSnapshots(before, after);
  assert.equal(event.kind, 'order');
  assert.equal(event.severity, 'critical');
});

test('a Major Order reaching 100% is announced once', () => {
  const order = (percent) => ({ id: 7, tasks: [{ percent }] });
  const before = snapshotOf(store([planet()], { assignments: [order(80)] }));
  const after = snapshotOf(store([planet()], { assignments: [order(100)] }));
  assert.deepEqual(kinds(diffSnapshots(before, after)), ['order-complete']);
  const later = snapshotOf(store([planet()], { assignments: [order(100)] }));
  assert.deepEqual(diffSnapshots(after, later), [], 'not repeated while it stays complete');
});

test('new dispatches collapse into a single event', () => {
  const d = (id) => ({ id, message: 'x' });
  const before = snapshotOf(store([planet()], { dispatches: [d(1)] }));
  const after = snapshotOf(store([planet()], { dispatches: [d(3), d(2), d(1)] }));
  const [event] = diffSnapshots(before, after);
  assert.equal(event.kind, 'dispatch');
  assert.match(event.title, /2 NEW DISPATCHES/);
});

test('a busy poll is capped and ordered worst-first', () => {
  const many = (owner) => Array.from({ length: 12 }, (_, i) =>
    planet({ index: i, name: `P${i}`, currentOwner: owner }));
  const before = snapshotOf(store(many('humans')));
  const after = snapshotOf(store(many('terminids')));
  const events = diffSnapshots(before, after);
  assert.equal(events.length, 6, 'capped so one poll cannot bury the reader');
  assert.ok(events.every((e) => e.severity === 'critical'));
});

test('events carry a timestamp and a unique id', () => {
  const before = snapshotOf(store([planet({ index: 1, currentOwner: 'humans' }),
                                   planet({ index: 2, currentOwner: 'humans' })]));
  const after = snapshotOf(store([planet({ index: 1, currentOwner: 'terminids' }),
                                  planet({ index: 2, currentOwner: 'terminids' })]));
  const events = diffSnapshots(before, after, 1234);
  assert.ok(events.every((e) => e.at === 1234));
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});
