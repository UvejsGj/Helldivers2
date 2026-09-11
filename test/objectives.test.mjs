/**
 * Major Order objective descriptions.
 *
 * The risky reading here is slot 12: a planet index on planet-scoped tasks and
 * a count elsewhere. Naming the wrong world would be a confident lie, so most
 * of these tests are about when NOT to name one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeTask, orderProgress, requiredRate, TASK_TYPES } from '../js/objectives.js';

const task = (over = {}) => ({
  type: TASK_TYPES.LIBERATE, goal: 1, current: 0, percent: 0,
  faction: 'unknown', planetRef: undefined, values: [], valueTypes: [], ...over,
});

const planets = new Map([
  [0, { index: 0, name: 'Klen Dahth II' }],
  [42, { index: 42, name: 'Meridia' }],
]);

test('a planet-scoped objective with a goal of one names its world', () => {
  const d = describeTask(task({ type: TASK_TYPES.LIBERATE, goal: 1, planetRef: 42 }), planets);
  assert.equal(d.label, 'LIBERATE MERIDIA');
  assert.equal(d.planetIndex, 42);
  assert.equal(d.binary, true);
});

test('a counted objective never names a planet, even when slot 12 resolves', () => {
  // "Liberate 8 planets" carries a goal of 8 and a zero in slot 12. Planet zero
  // exists, so a naive lookup would confidently name the wrong world.
  const d = describeTask(task({ type: TASK_TYPES.LIBERATE, goal: 8, planetRef: 0 }), planets);
  assert.equal(d.label, 'LIBERATE 8 PLANETS');
  assert.equal(d.planetIndex, null);
});

test('an unresolvable planet reference falls back to the count form', () => {
  const d = describeTask(task({ type: TASK_TYPES.LIBERATE, goal: 1, planetRef: 999 }), planets);
  assert.equal(d.label, 'LIBERATE 1 PLANET');
  assert.equal(d.planetIndex, null);
});

test('no planet list means no planet named', () => {
  const d = describeTask(task({ type: TASK_TYPES.LIBERATE, goal: 1, planetRef: 42 }), null);
  assert.equal(d.planetIndex, null);
  assert.match(d.label, /LIBERATE 1 PLANET/);
});

test('hold and defend name their world too', () => {
  assert.equal(describeTask(task({ type: TASK_TYPES.HOLD, planetRef: 42 }), planets).label,
    'HOLD MERIDIA');
  assert.equal(describeTask(task({ type: TASK_TYPES.DEFEND, planetRef: 42 }), planets).label,
    'DEFEND MERIDIA');
});

test('an elimination names its faction and compacts the goal', () => {
  const d = describeTask(task({ type: TASK_TYPES.ELIMINATE, goal: 2e9, faction: 'automatons' }), planets);
  assert.equal(d.label, 'ELIMINATE 2B AUTOMATONS');
  assert.equal(d.faction, 'automatons');
  assert.equal(d.binary, false);
});

test('an elimination with no faction still reads sensibly', () => {
  const d = describeTask(task({ type: TASK_TYPES.ELIMINATE, goal: 5e6, faction: 'unknown' }), planets);
  assert.equal(d.label, 'ELIMINATE 5M HOSTILES');
  assert.equal(d.faction, null);
});

test('an unmapped objective type stays a numbered label rather than inventing a verb', () => {
  const d = describeTask(task({ type: 97, goal: 3 }), planets, 2);
  assert.equal(d.label, 'OBJECTIVE 03');
  assert.equal(d.unit, null);
});

test('pluralisation follows the goal', () => {
  assert.match(describeTask(task({ goal: 1, planetRef: undefined }), planets).label, /1 PLANET$/);
  assert.match(describeTask(task({ goal: 4 }), planets).label, /4 PLANETS$/);
});

/* ------------------------------------------------------------------ pace */

test('requiredRate divides what is left by the time left', () => {
  const now = Date.now();
  const rate = requiredRate(task({ goal: 100, current: 40 }), now + 2 * 3600_000, now);
  assert.equal(rate.remaining, 60);
  assert.ok(Math.abs(rate.perHour - 30) < 0.01);
});

test('requiredRate stays silent when there is nothing to say', () => {
  const now = Date.now();
  assert.equal(requiredRate(task({ goal: 100, current: 100 }), now + 3600_000, now), null, 'done');
  assert.equal(requiredRate(task({ goal: 1, current: 0 }), now + 3600_000, now), null, 'binary');
  assert.equal(requiredRate(task({ goal: 100, current: 0 }), null, now), null, 'no deadline');
  assert.equal(requiredRate(task({ goal: 100, current: 0 }), now - 1000, now), null, 'expired');
});

/* --------------------------------------------------------------- overall */

test('orderProgress averages the objectives', () => {
  assert.equal(orderProgress([task({ percent: 100 }), task({ percent: 0 })]), 50);
  assert.equal(orderProgress([]), 0);
});

test('orderProgress clamps a stray percentage', () => {
  assert.equal(orderProgress([task({ percent: 150 }), task({ percent: -20 })]), 50);
});
