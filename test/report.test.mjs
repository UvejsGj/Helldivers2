/** The text report. Layout matters here: it is pasted into monospace channels. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReport } from '../js/report.js';

const planet = (over = {}) => ({
  index: 1, name: 'Meridia', sector: 'Omega', currentOwner: 'terminids',
  liberation: 62.5, players: 41800, event: null, campaign: { id: 1 }, ...over,
});

const baseState = (over = {}) => ({
  war: { started: Date.parse('2024-01-23T20:05:13Z'), statistics: {
    playerCount: 328873, terminidKills: 7.4e10, automatonKills: 4.1e10, illuminateKills: 9.6e9,
  } },
  planets: [planet(), planet({ index: 2, currentOwner: 'humans' })],
  assignments: [],
  ...over,
});

const fronts = (p = planet(), label = 'PUSH') => [{ planet: p, priority: { label } }];

test('reports the war day and a control breakdown', () => {
  const text = buildReport(baseState(), [], null);
  assert.match(text, /SUPER EARTH WATCH — WAR DAY [\d,]+/);
  assert.match(text, /GALACTIC CONTROL/);
  assert.match(text, /Terminids 1 \(50%\)/);
  assert.match(text, /Super Earth 1 \(50%\)/);
});

test('includes the Major Order with a meter per objective', () => {
  const text = buildReport(baseState({
    assignments: [{
      id: 1, title: 'MAJOR ORDER', description: 'Liberate 8 planets.',
      tasks: [{ percent: 50, current: 4, goal: 8 }, { percent: 100, current: 5, goal: 5 }],
      expiresAt: Date.now() + 3600_000,
    }],
  }), [], null);
  assert.match(text, /MAJOR ORDER/);
  assert.match(text, /Liberate 8 planets\./);
  assert.match(text, /\[##########\.{10}\]/, 'a half-done objective fills half the meter');
  assert.match(text, /\[#{20}\]/, 'a finished one fills it');
  assert.match(text, /4\/8/);
  assert.match(text, /Expires in/);
});

test('lists fronts with their priority, side and progress', () => {
  const text = buildReport(baseState(), fronts(), null);
  assert.match(text, /ACTIVE FRONTS \(1\)/);
  assert.match(text, /PUSH/);
  assert.match(text, /Meridia/);
  assert.match(text, /LIBERATE/);
  assert.match(text, /Terminids/);
  assert.match(text, /62\.5%/);
});

test('a defence names the attacker, not the current owner', () => {
  const defended = planet({ currentOwner: 'humans', event: { faction: 'automatons' } });
  const text = buildReport(baseState(), fronts(defended, 'CRITICAL'), null);
  assert.match(text, /DEFEND/);
  assert.match(text, /Automatons/);
  assert.ok(!/DEFEND\s+Super Earth/.test(text));
});

test('appends the measured rate when one is available', () => {
  const text = buildReport(baseState(), fronts(), () => '+4.20%/h');
  assert.match(text, /\+4\.20%\/h/);
});

test('survives a war with nothing in it', () => {
  const text = buildReport({ war: null, planets: [], assignments: [] }, [], null);
  assert.match(text, /SUPER EARTH WATCH/);
  assert.ok(!text.includes('undefined'));
  assert.ok(!text.includes('NaN'));
});
