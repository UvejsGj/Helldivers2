/**
 * Unit tests for the parsing layer.
 *
 * These are the functions with real logic and no DOM: faction aliasing,
 * timestamp handling, the liberation/defence distinction, task-goal extraction
 * and attack derivation. Run with `npm test` — no dependencies, no build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asArray, deriveAttacks, deriveSupplyLines, linkCampaigns, linkEvents,
  normalizeAssignment, normalizeCampaign, normalizeDispatch, normalizeEvent,
  normalizeFaction, normalizePlanet, normalizeStatistics, normalizeWar,
  num, pick, planetIndexOf, toEpoch,
} from '../js/normalize.js';

/* ------------------------------------------------------------- primitives */

test('pick returns the first defined key', () => {
  assert.equal(pick({ b: 2 }, ['a', 'b']), 2);
  assert.equal(pick({ a: null, b: 0 }, ['a', 'b']), 0, 'null skipped, 0 kept');
  assert.equal(pick(null, ['a'], 'fallback'), 'fallback');
});

test('num coerces strings and rejects nonsense', () => {
  assert.equal(num('42'), 42);
  assert.equal(num(undefined), 0);
  assert.equal(num('abc', 7), 7);
  assert.equal(num(NaN, 3), 3);
  assert.equal(num(Infinity, 3), 3);
});

test('asArray unwraps the containers the API has used', () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray({ data: [1] }), [1]);
  assert.deepEqual(asArray({ items: [2] }), [2]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(5), [5]);
});

test('toEpoch treats naive timestamps as UTC', () => {
  // The API sometimes omits the Z. Parsed as local time the countdown would
  // drift by the viewer's offset, which is the bug this guards.
  assert.equal(toEpoch('2026-09-06T04:00:00'), Date.parse('2026-09-06T04:00:00Z'));
  assert.equal(toEpoch('2026-09-06T04:00:00Z'), Date.parse('2026-09-06T04:00:00Z'));
  assert.equal(toEpoch(1788667200000), 1788667200000);
  assert.equal(toEpoch(1788667200), 1788667200000, 'seconds promoted to ms');
  assert.equal(toEpoch('garbage'), null);
  assert.equal(toEpoch(null), null);
});

test('normalizeFaction maps every spelling onto one key', () => {
  for (const input of ['Humans', 'human', 'SUPER EARTH', 'Super Earth']) {
    assert.equal(normalizeFaction(input), 'humans', input);
  }
  assert.equal(normalizeFaction('Automaton'), 'automatons');
  assert.equal(normalizeFaction('Automatons'), 'automatons');
  assert.equal(normalizeFaction('bots'), 'automatons');
  assert.equal(normalizeFaction('Terminids'), 'terminids');
  assert.equal(normalizeFaction('Illuminate'), 'illuminate');
  assert.equal(normalizeFaction(1), 'humans', 'numeric faction ids');
  assert.equal(normalizeFaction(4), 'automatons');
  assert.equal(normalizeFaction('Gundam'), 'unknown');
  assert.equal(normalizeFaction(undefined), 'unknown');
});

test('planetIndexOf accepts a number, a string or a nested planet', () => {
  assert.equal(planetIndexOf(3), 3);
  assert.equal(planetIndexOf('3'), 3);
  assert.equal(planetIndexOf({ index: 9 }), 9);
  assert.equal(planetIndexOf(null), null);
});

/* ------------------------------------------------------------- statistics */

test('normalizeStatistics derives accuracy when the API omits it', () => {
  const stats = normalizeStatistics({ bulletsFired: 1000, bulletsHit: 610 });
  assert.equal(Math.round(stats.accuracy), 61);
});

test('normalizeStatistics prefers a reported rate over a derived one', () => {
  const stats = normalizeStatistics({ bulletsFired: 1000, bulletsHit: 610, accuracy: 55 });
  assert.equal(stats.accuracy, 55);
});

test('normalizeStatistics derives the mission success rate', () => {
  const stats = normalizeStatistics({ missionsWon: 90, missionsLost: 10 });
  assert.equal(stats.missionSuccessRate, 90);
});

test('normalizeStatistics survives a total absence of data', () => {
  const stats = normalizeStatistics(undefined);
  assert.equal(stats.accuracy, 0);
  assert.equal(stats.missionSuccessRate, 0);
  assert.equal(stats.deaths, 0);
});

/* ---------------------------------------------------------------- planets */

const basePlanet = (over = {}) => ({
  index: 1, name: 'Fenrir III', sector: 'Umlaut',
  position: { x: 0.4, y: -0.3 },
  maxHealth: 1000000, health: 1000000,
  currentOwner: 'Terminids', initialOwner: 'Humans',
  waypoints: [0], statistics: { playerCount: 500 },
  ...over,
});

test('normalizePlanet rejects junk but keeps a bare index', () => {
  assert.equal(normalizePlanet(null), null);
  assert.equal(normalizePlanet({ name: 'no index' }), null);
  const bare = normalizePlanet({ index: 5 });
  assert.equal(bare.name, 'Planet 5');
  assert.equal(bare.currentOwner, 'unknown');
  assert.equal(bare.liberation, 0);
});

test('liberation is the damage taken on a contested planet', () => {
  const planet = normalizePlanet(basePlanet({ health: 380000 }));
  assert.equal(Number(planet.liberation.toFixed(1)), 62.0);
});

test('a planet under attack reports defence progress, not its own health', () => {
  // Regression: a defended planet's own health stays full while the fight runs
  // on the event's separate pool, so the health ratio reads a flat 0%.
  const planet = normalizePlanet(basePlanet({
    currentOwner: 'Humans',
    health: 1000000,
    event: { eventType: 1, faction: 'Automaton', health: 210000, maxHealth: 750000 },
  }));
  assert.equal(Number(planet.liberation.toFixed(1)), 72.0);
  assert.equal(planet.event.faction, 'automatons');
});

test('normalizeEvent clamps progress into range', () => {
  assert.equal(normalizeEvent({ health: 0, maxHealth: 100 }).progress, 100);
  assert.equal(normalizeEvent({ health: 100, maxHealth: 100 }).progress, 0);
  assert.equal(normalizeEvent({ health: -50, maxHealth: 100 }).progress, 100, 'no overshoot');
  assert.equal(normalizeEvent(null), null);
});

/* -------------------------------------------------------------- campaigns */

test('normalizeCampaign pulls the index out of an embedded planet', () => {
  assert.equal(normalizeCampaign({ id: 1, planet: { index: 7 } }).planetIndex, 7);
  assert.equal(normalizeCampaign({ id: 1, planet: 7 }).planetIndex, 7);
  assert.equal(normalizeCampaign({ id: 1 }), null, 'no planet, no campaign');
});

/* ------------------------------------------------------------ assignments */

test('normalizeAssignment reads goals from the valueTypes positions', () => {
  const order = normalizeAssignment({
    id32: 1, progress: [3, 812000000], expiresIn: 3600,
    setting: {
      overrideTitle: 'MAJOR ORDER', overrideBrief: 'Hold the line.',
      tasks: [
        { type: 11, values: [1, 8, 0], valueTypes: [1, 3, 12] },
        { type: 3, values: [1, 2000000000, 0], valueTypes: [1, 3, 12] },
      ],
      reward: { type: 1, amount: 55 },
    },
  });

  assert.equal(order.title, 'MAJOR ORDER');
  assert.equal(order.tasks[0].goal, 8);
  assert.equal(order.tasks[0].current, 3);
  assert.equal(order.tasks[0].percent, 37.5);
  assert.equal(order.tasks[1].goal, 2000000000);
  assert.equal(order.reward.amount, 55);
  assert.equal(order.reward.label, 'Medals');
  // expiresIn is resolved to an absolute instant once, at parse time.
  assert.ok(Math.abs(order.expiresAt - (Date.now() + 3600000)) < 2000);
});

test('assignment progress never exceeds 100 percent', () => {
  const order = normalizeAssignment({
    progress: [12], setting: { tasks: [{ values: [1, 8], valueTypes: [1, 3] }] },
  });
  assert.equal(order.tasks[0].percent, 100);
});

test('normalizeAssignment survives an empty setting', () => {
  const order = normalizeAssignment({ setting: {} });
  assert.deepEqual(order.tasks, []);
  assert.equal(order.expiresAt, null);
});

/* ------------------------------------------------------------- dispatches */

test('normalizeDispatch keeps the message and parses the timestamp', () => {
  const d = normalizeDispatch({ id: 1, published: '2026-09-06T18:00:00Z', message: 'Liberty.' });
  assert.equal(d.message, 'Liberty.');
  assert.equal(d.published, Date.parse('2026-09-06T18:00:00Z'));
});

/* -------------------------------------------------------------------- war */

test('normalizeWar lifts the nested statistics', () => {
  const war = normalizeWar({
    started: '2024-01-23T20:05:13Z', impactMultiplier: 0.032,
    factions: ['Humans', 'Automaton'],
    statistics: { playerCount: 328873, deaths: 5 },
  });
  assert.equal(war.statistics.playerCount, 328873);
  assert.equal(war.impactMultiplier, 0.032);
  assert.deepEqual(war.factions, ['humans', 'automatons']);
});

/* ------------------------------------------------------ derived structures */

function graph() {
  const planets = [
    normalizePlanet(basePlanet({ index: 0, name: 'Home', currentOwner: 'Humans', waypoints: [1, 2] })),
    normalizePlanet(basePlanet({ index: 1, name: 'Bug World', currentOwner: 'Terminids', waypoints: [0] })),
    normalizePlanet(basePlanet({ index: 2, name: 'Bot World', currentOwner: 'Automaton', waypoints: [0, 3] })),
    normalizePlanet(basePlanet({ index: 3, name: 'Far Bot', currentOwner: 'Automaton', waypoints: [2] })),
  ];
  return new Map(planets.map((p) => [p.index, p]));
}

test('deriveSupplyLines dedupes the undirected pairs', () => {
  const lines = deriveSupplyLines(graph());
  assert.equal(lines.length, 3, '0-1, 0-2, 2-3');
});

test('an explicit attacking list produces a reported arrow', () => {
  const byIndex = graph();
  byIndex.get(2).attacking = [0];
  const attacks = deriveAttacks(byIndex, []);
  const arrow = attacks.find((a) => a.source === 2 && a.target === 0);
  assert.ok(arrow, 'arrow 2 -> 0 exists');
  assert.equal(arrow.inferred, false);
  assert.equal(arrow.faction, 'automatons');
});

test('a defence with no explicit source infers one from adjacency', () => {
  const byIndex = graph();
  const defended = byIndex.get(0);
  defended.event = normalizeEvent({ faction: 'Automaton', health: 5, maxHealth: 10 }, 0);
  const attacks = deriveAttacks(byIndex, [defended.event]);
  const arrow = attacks.find((a) => a.target === 0);
  assert.ok(arrow);
  assert.equal(arrow.source, 2, 'the adjacent Automaton world');
  assert.equal(arrow.inferred, true, 'flagged so the map can draw it differently');
});

test('an active liberation is drawn as our own push', () => {
  const byIndex = graph();
  byIndex.get(1).campaign = normalizeCampaign({ id: 1, planet: 1 });
  const arrow = deriveAttacks(byIndex, []).find((a) => a.target === 1);
  assert.ok(arrow);
  assert.equal(arrow.source, 0);
  assert.equal(arrow.faction, 'humans');
  assert.equal(arrow.inferred, true);
});

test('a reported arrow beats an inferred one for the same target', () => {
  const byIndex = graph();
  byIndex.get(3).attacking = [0];
  byIndex.get(0).event = normalizeEvent({ faction: 'Automaton', health: 5, maxHealth: 10 }, 0);
  const attacks = deriveAttacks(byIndex, [byIndex.get(0).event]);
  const incoming = attacks.filter((a) => a.target === 0);
  assert.equal(incoming.length, 1, 'inference skipped once a real link exists');
  assert.equal(incoming[0].source, 3);
  assert.equal(incoming[0].inferred, false);
});

test('linkCampaigns and linkEvents attach to the right planets', () => {
  const byIndex = graph();
  linkCampaigns(byIndex, [normalizeCampaign({ id: 42, planet: 1 })]);
  assert.equal(byIndex.get(1).campaign.id, 42);

  linkEvents(byIndex, [normalizeEvent({ faction: 'Terminids', health: 25, maxHealth: 100 }, 2)]);
  assert.equal(byIndex.get(2).event.faction, 'terminids');
  assert.equal(byIndex.get(2).liberation, 75, 'defence progress overrides the health reading');
});

/* ------------------------------------------------------------------ steam */

test('normalizeSteamPost reduces Steam markup to plain text', async () => {
  const { normalizeSteamPost } = await import('../js/normalize.js');
  const post = normalizeSteamPost({
    id: 'x', title: 'PATCH 01.003.204', publishedAt: '2026-09-01T10:00:00Z',
    url: 'https://store.steampowered.com/news/',
    content: '[h1]Balance[/h1]\n[list]\n[*] Less recoil.\n[*] Fewer crashes.\n[/list]\n'
      + 'Democracy is [b]iterative[/b]. [url=https://x.invalid]notes[/url]',
  });
  assert.equal(post.title, 'PATCH 01.003.204');
  assert.ok(!post.content.includes('['), 'no markup survives');
  assert.match(post.content, /• Less recoil\./);
  assert.match(post.content, /Democracy is iterative\./);
  assert.match(post.content, /notes/, 'link text is kept even though the tag is dropped');
});

test('normalizeSteamPost only keeps http(s) links', async () => {
  const { normalizeSteamPost } = await import('../js/normalize.js');
  // An href is the one place a feed could smuggle a script URL into the page.
  assert.equal(normalizeSteamPost({ title: 'a', url: 'javascript:alert(1)' }).url, null);
  assert.equal(normalizeSteamPost({ title: 'a', url: 'data:text/html,x' }).url, null);
  assert.equal(normalizeSteamPost({ title: 'a', url: 'https://ok.example' }).url, 'https://ok.example');
});

test('normalizeSteamPost rejects an empty post but survives a partial one', async () => {
  const { normalizeSteamPost } = await import('../js/normalize.js');
  assert.equal(normalizeSteamPost({}), null);
  assert.equal(normalizeSteamPost(null), null);
  const bare = normalizeSteamPost({ content: 'Just a body.' });
  assert.equal(bare.title, 'Untitled');
  assert.equal(bare.published, null);
});
