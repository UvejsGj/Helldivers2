/**
 * Offline dataset.
 *
 * Generates a plausible galactic war — ~180 planets in a spiral, three enemy
 * fronts, live campaigns, a Major Order and a dispatch feed — in the exact
 * shapes the real API returns, so the whole UI can be built and exercised
 * without touching the network.
 *
 * The generator is seeded, so the galaxy is identical on every load; only the
 * values that should move over time (health, player counts, kill totals) drift,
 * which makes auto-refresh visibly do something in mock mode.
 */

/** Mulberry32 — small, fast, deterministic. */
function seeded(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTORS = [
  'Altus', 'Andromeda', 'Barnard', 'Borgus', 'Cantolus', 'Celeste', 'Draco',
  'Falstaff', 'Farsight', 'Gallux', 'Gothmar', 'Guang', 'Hydra', 'Idun',
  'Iptus', 'Jin Xi', 'Kelvinor', 'Korpus', 'Lacaille', 'Marspira', 'Meridian',
  'Mirin', 'Morgon', 'Nanos', 'Omega', 'Orion', 'Quintus', 'Rictus', 'Rigel',
  'Saggarius', 'Severin', 'Sten', 'Tanis', 'Tarragon', 'Theseus', 'Trigon',
  'Ursa', 'Valdis', 'Xzar', 'Ymir',
];

const NAME_ROOTS = [
  'Klen', 'Fenrir', 'Hellmire', 'Malevelon', 'Draupnir', 'Estanu', 'Ustotu',
  'Veld', 'Vernen', 'Erata', 'Heeth', 'Angel', 'Mantes', 'Vandalon', 'Choohe',
  'Penta', 'Oshaune', 'Marfark', 'Wasat', 'Charbal', 'Meridia', 'Gaellivare',
  'Vega', 'Troost', 'Zagon', 'Kelvinor', 'Bore', 'Tarsh', 'Skitter', 'Nublaria',
  'Pilen', 'Achird', 'Acamar', 'Bellatrix', 'Alairt', 'Caph', 'Castor', 'Cyberstan',
  'Durgen', 'Emeria', 'Fori', 'Gacrux', 'Hadar', 'Herthon', 'Ivis', 'Julheim',
  'Kirrik', 'Lesath', 'Menkent', 'Mort', 'Nivel', 'Oasis', 'Phact', 'Ras',
  'Seasse', 'Shete', 'Turing', 'Ubanea', 'Valgaard', 'Widow', 'Xzar', 'Yed',
  'Zefia', 'Zosma', 'Alta', 'Borea', 'Crimsica', 'Deneb', 'Erson', 'Fort',
];

const NAME_SUFFIXES = ['', '', '', ' II', ' III', ' IV', ' V', ' Prime', ' Secundus', "'s Rest", ' Station'];

const BIOMES = [
  ['Rainforest', 'Dense jungle. Visibility is poor and the wildlife is worse.'],
  ['Desert', 'Arid wastes under a punishing sun. Hydration is a luxury.'],
  ['Ice Waste', 'A frozen shelf of nothing. Equipment fails in the cold.'],
  ['Swamp', 'Waterlogged lowlands. Every step is a negotiation.'],
  ['Moon', 'Airless rock. Low gravity, high consequences.'],
  ['Highlands', 'Windswept ridges and long sightlines.'],
  ['Canyon', 'Deep cuts in old stone. Ambush country.'],
  ['Toxic', 'The atmosphere itself is hostile to human life.'],
  ['Ashland', 'Volcanic plains beneath a permanent cinder sky.'],
  ['Mesa', 'Flat-topped rises over cracked hardpan.'],
];

const HAZARDS = [
  ['Meteor Storm', 'Meteor showers cause severe damage.'],
  ['Ion Storm', 'Ion storms disable stratagems.'],
  ['Fire Tornadoes', 'Roaming tornadoes of fire. Do not touch.'],
  ['Sandstorm', 'Reduces visibility to almost nothing.'],
  ['Tremors', 'Seismic activity staggers everything on the surface.'],
  ['Blizzards', 'Whiteout conditions with severe wind chill.'],
  ['Rain Storms', 'Heavy rainfall reduces visibility.'],
  ['Volcanic Activity', 'Eruptions of molten rock without warning.'],
];

const PLANET_COUNT = 180;

/**
 * Sectors are regions of space, so assign them from position rather than from
 * planet index. Indexing by the spiral's ordinal smeared every sector along the
 * whole arm, which made the map's sector hulls overlap into mush and stacked
 * all their labels on the galactic centre.
 *
 * Eight wedges by five radial bands gives forty cells for forty names.
 */
const SECTOR_WEDGES = 8;
const SECTOR_BANDS = 5;

function sectorFor(x, y) {
  const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  const wedge = Math.min(SECTOR_WEDGES - 1, Math.floor((angle / (Math.PI * 2)) * SECTOR_WEDGES));
  const radius = Math.min(0.999, Math.hypot(x, y));
  const band = Math.min(SECTOR_BANDS - 1, Math.floor(radius * SECTOR_BANDS));
  return SECTORS[(band * SECTOR_WEDGES + wedge) % SECTORS.length];
}

/** Build the static skeleton once: names, positions, sectors, supply lines. */
function buildGalaxy() {
  const rng = seeded(19700823);
  const planets = [];
  const usedNames = new Set();

  for (let i = 0; i < PLANET_COUNT; i++) {
    // Two-armed spiral with jitter, normalised into the API's [-1, 1] space.
    const arm = i % 2;
    const t = i / PLANET_COUNT;
    const radius = 0.08 + Math.sqrt(t) * 0.92;
    const angle = t * Math.PI * 3.1 + arm * Math.PI + (rng() - 0.5) * 0.55;
    const x = Math.cos(angle) * radius + (rng() - 0.5) * 0.06;
    const y = Math.sin(angle) * radius + (rng() - 0.5) * 0.06;

    let name;
    do {
      name = NAME_ROOTS[Math.floor(rng() * NAME_ROOTS.length)]
        + NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
    } while (usedNames.has(name));
    usedNames.add(name);

    const [biomeName, biomeDesc] = BIOMES[Math.floor(rng() * BIOMES.length)];
    const hazards = [];
    const hazardCount = rng() < 0.45 ? 1 : rng() < 0.15 ? 2 : 0;
    for (let h = 0; h < hazardCount; h++) {
      const [hn, hd] = HAZARDS[Math.floor(rng() * HAZARDS.length)];
      if (!hazards.some((x) => x.name === hn)) hazards.push({ name: hn, description: hd });
    }

    planets.push({
      index: i,
      name,
      sector: sectorFor(x, y),
      biome: { name: biomeName, description: biomeDesc },
      hazards,
      hash: Math.floor(rng() * 4e9),
      position: { x: Number(x.toFixed(5)), y: Number(y.toFixed(5)) },
      waypoints: [],
      maxHealth: 1000000,
      health: 1000000,
      disabled: false,
      initialOwner: 'Humans',
      currentOwner: 'Humans',
      regenPerSecond: 1388.8889,
      event: null,
      statistics: {},
      attacking: [],
    });
  }

  // Supply lines: connect each planet to its two or three nearest neighbours so
  // the map has a coherent web rather than a starfield.
  for (const planet of planets) {
    const nearest = planets
      .filter((p) => p !== planet)
      .map((p) => ({ p, d: Math.hypot(p.position.x - planet.position.x, p.position.y - planet.position.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    for (const { p } of nearest) {
      if (!planet.waypoints.includes(p.index)) planet.waypoints.push(p.index);
      if (!p.waypoints.includes(planet.index)) p.waypoints.push(planet.index);
    }
  }

  // Faction territory: three wedges of the galaxy, thinning towards the core so
  // the space around Super Earth stays liberated.
  const factionForAngle = (x, y) => {
    const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
    if (angle < Math.PI * 0.66) return 'Terminids';
    if (angle < Math.PI * 1.33) return 'Automaton';
    return 'Illuminate';
  };

  const rng2 = seeded(88104213);
  for (const planet of planets) {
    const r = Math.hypot(planet.position.x, planet.position.y);
    const hostileChance = Math.min(0.92, Math.max(0, (r - 0.22) * 1.15));
    if (rng2() < hostileChance) {
      const owner = factionForAngle(planet.position.x, planet.position.y);
      planet.currentOwner = owner;
      planet.initialOwner = owner;
    }
  }

  return planets;
}

const GALAXY = buildGalaxy();

/* Campaign fronts are picked once: enemy planets that border friendly space. */
const CAMPAIGN_INDEXES = (() => {
  const byIndex = new Map(GALAXY.map((p) => [p.index, p]));
  const frontier = GALAXY.filter((p) =>
    p.currentOwner !== 'Humans'
    && p.waypoints.some((w) => byIndex.get(w)?.currentOwner === 'Humans'));
  const defences = GALAXY.filter((p) =>
    p.currentOwner === 'Humans'
    && p.waypoints.some((w) => byIndex.get(w) && byIndex.get(w).currentOwner !== 'Humans'));
  const rng = seeded(5150);
  const pickSome = (list, n) => list
    .map((v) => ({ v, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, n)
    .map((o) => o.v.index);
  return {
    liberation: pickSome(frontier, 9),
    defence: pickSome(defences, 3),
  };
})();

/** A slow 0..1 oscillation, so mock values move believably between polls. */
function drift(seed, periodMs) {
  return (Math.sin((Date.now() / periodMs) + seed) + 1) / 2;
}

const MOCK_WAR_START = Date.UTC(2024, 0, 23, 20, 5, 13);

function statsFor(seed, scale) {
  const wobble = drift(seed, 90_000);
  const bulletsFired = Math.floor((4.2e11 + wobble * 8e8) * scale);
  const bulletsHit = Math.floor(bulletsFired * (0.61 + wobble * 0.02));
  const missionsWon = Math.floor((3.1e8 + wobble * 4e5) * scale);
  const missionsLost = Math.floor((2.6e7 + wobble * 3e4) * scale);
  return {
    missionsWon,
    missionsLost,
    missionTime: Math.floor(2.9e11 * scale),
    terminidKills: Math.floor((7.4e10 + wobble * 9e7) * scale),
    automatonKills: Math.floor((4.1e10 + wobble * 6e7) * scale),
    illuminateKills: Math.floor((9.6e9 + wobble * 3e7) * scale),
    bulletsFired,
    bulletsHit,
    timePlayed: Math.floor(2.9e11 * scale),
    deaths: Math.floor((2.4e9 + wobble * 2e6) * scale),
    revives: Math.floor((1.7e9 + wobble * 2e6) * scale),
    friendlies: Math.floor((3.9e8 + wobble * 9e5) * scale),
    missionSuccessRate: Math.round(92 + wobble * 2),
    accuracy: Math.round(61 + wobble * 2),
  };
}

/** Snapshot the galaxy with time-varying health, owners and player counts. */
function currentPlanets() {
  const totalPlayers = 240000 + Math.floor(drift(1.2, 240_000) * 90000);
  const active = new Set([...CAMPAIGN_INDEXES.liberation, ...CAMPAIGN_INDEXES.defence]);

  // Most divers are on the active fronts; the rest are scattered.
  const weights = new Map();
  let weightTotal = 0;
  for (const planet of GALAXY) {
    const isActive = active.has(planet.index);
    const w = isActive ? 6 + drift(planet.index, 120_000) * 22 : drift(planet.index, 400_000) * 0.4;
    weights.set(planet.index, w);
    weightTotal += w;
  }

  return GALAXY.map((planet) => {
    const players = Math.floor((weights.get(planet.index) / weightTotal) * totalPlayers);
    const isLiberation = CAMPAIGN_INDEXES.liberation.includes(planet.index);
    const isDefence = CAMPAIGN_INDEXES.defence.includes(planet.index);

    let health = planet.maxHealth;
    let event = null;

    if (isLiberation) {
      // Liberation progress: health falls as divers push.
      const progress = 0.06 + drift(planet.index * 3.3, 150_000) * 0.86;
      health = Math.floor(planet.maxHealth * (1 - progress));
    }

    if (isDefence) {
      const eventMax = 750000;
      const progress = 0.1 + drift(planet.index * 7.7, 110_000) * 0.7;
      const endsIn = 2 * 3600_000 + drift(planet.index, 900_000) * 20 * 3600_000;
      event = {
        id: 34000 + planet.index,
        eventType: 1,
        faction: GALAXY.find((p) => p.waypoints.includes(planet.index)
          && p.currentOwner !== 'Humans')?.currentOwner || 'Terminids',
        health: Math.floor(eventMax * (1 - progress)),
        maxHealth: eventMax,
        startTime: new Date(Date.now() - 6 * 3600_000).toISOString(),
        endTime: new Date(Date.now() + endsIn).toISOString(),
        campaignId: 50000 + planet.index,
        jointOperationIds: [],
      };
    }

    return {
      ...planet,
      health,
      event,
      statistics: { ...statsFor(planet.index, 0.0009), playerCount: players },
      attacking: isDefence ? [] : planet.attacking,
    };
  });
}

function currentCampaigns(planets) {
  const byIndex = new Map(planets.map((p) => [p.index, p]));
  const all = [...CAMPAIGN_INDEXES.liberation, ...CAMPAIGN_INDEXES.defence];
  return all.map((index, i) => ({
    id: 50000 + index,
    planet: byIndex.get(index),
    type: CAMPAIGN_INDEXES.defence.includes(index) ? 1 : 0,
    count: 1 + (i % 3),
  }));
}

function currentPlanetEvents(planets) {
  const byIndex = new Map(planets.map((p) => [p.index, p]));
  return CAMPAIGN_INDEXES.defence.map((index) => {
    const planet = byIndex.get(index);
    const attacker = planet.waypoints
      .map((w) => byIndex.get(w))
      .find((p) => p && p.currentOwner !== 'Humans');
    return {
      ...planet.event,
      planet,
      // Attack endpoints, mirroring the shape the real feed uses when it
      // exposes them. deriveAttacks() prefers these over inference.
      source: attacker ? attacker.index : null,
      target: index,
    };
  });
}

function currentAssignment() {
  const goalPlanets = 8;
  const done = Math.min(goalPlanets, Math.floor(drift(4.4, 600_000) * (goalPlanets + 1)));
  const killGoal = 2_000_000_000;
  const kills = Math.floor(killGoal * (0.2 + drift(2.1, 500_000) * 0.75));

  return [{
    id: 4212371,
    progress: [done, kills],
    expiresIn: Math.floor(41 * 3600 + drift(0.7, 3_600_000) * 7200),
    setting: {
      type: 4,
      overrideTitle: 'MAJOR ORDER',
      overrideBrief:
        'The Automaton advance through the Xzar sector threatens Super Earth\'s '
        + 'forward munitions depots. High Command has authorised a full '
        + 'counter-offensive. Liberate the listed worlds and break the machine '
        + 'line before it reaches the inner colonies.',
      taskDescription:
        'Liberate 8 planets in the Xzar and Ymir sectors and eliminate 2 billion Automatons.',
      tasks: [
        { type: 11, values: [1, goalPlanets, 0], valueTypes: [1, 3, 12] },
        { type: 3, values: [1, killGoal, 0], valueTypes: [1, 3, 12] },
      ],
      reward: { type: 1, amount: 55, id32: 897894093 },
      rewards: [{ type: 1, amount: 55, id32: 897894093 }],
      flags: 0,
    },
  }];
}

const DISPATCH_TEXTS = [
  'Super Earth High Command confirms the successful liberation of a key '
  + 'munitions world. Managed Democracy advances. Citizens are reminded that '
  + 'celebration is mandatory but must not interfere with shift quotas.',
  'The Ministry of Truth has released updated casualty figures. The figures '
  + 'are excellent. Any figures you may have heard elsewhere are not figures.',
  'Automaton forces have been observed massing beyond the Xzar line. All '
  + 'Helldivers in the sector are directed to hold position and await '
  + 'stratagem authorisation.',
  'A Terminid outbreak on a civilian agri-world has been contained. The '
  + 'harvest was saved. The farmers were, regrettably, part of the harvest.',
  'Illuminate signal activity detected on the galactic rim. High Command '
  + 'reminds all personnel that the Illuminate were defeated a century ago '
  + 'and that reports to the contrary constitute treason.',
  'New stratagem loadouts are available at all destroyer armouries. Democracy '
  + 'Officers will be monitoring adoption rates with great interest.',
  'Evacuation of the outer colonies proceeds ahead of schedule. Colonists have '
  + 'expressed their gratitude in the strongest possible terms available to them.',
  'Super Earth reminds all citizens: liberty is not free, but it is heavily '
  + 'subsidised. Report any subsidy fraud to your local Democracy Officer.',
  'Fleet elements have redeployed to reinforce the Meridian corridor. Divers '
  + 'operating in the area should expect increased orbital support.',
];

function currentDispatches() {
  const now = Date.now();
  return DISPATCH_TEXTS.map((message, i) => ({
    id: 260000 - i,
    published: new Date(now - i * (3.4 * 3600_000) - (i % 3) * 900_000).toISOString(),
    type: 0,
    message,
  }));
}

/** Patch notes, in Steam's own markup so the normaliser is exercised. */
function currentBulletins() {
  const now = Date.now();
  const posts = [
    {
      title: 'PATCH 01.003.204',
      body: '[h1]Balance[/h1]\n[list]\n[*] Reduced recoil on the AR-23 Liberator.\n'
        + '[*] Bile Titans no longer ignore orbital strikes.\n[*] Fixed a crash on extraction.\n[/list]\n\n'
        + 'Democracy is [b]iterative[/b]. See the [url=https://example.invalid]full notes[/url].',
    },
    {
      title: 'MINOR UPDATE 01.003.199',
      body: 'Stability fixes for the Xzar sector deployment queue.\n'
        + 'Matchmaking should now find squads faster during peak hours.',
    },
    {
      title: 'PATCH 01.003.187',
      body: '[h1]New Stratagem[/h1]\nThe Orbital Napalm Barrage is now available at Level 20.\n\n'
        + '[h1]Fixes[/h1]\n[list]\n[*] Corrected friendly-fire attribution in the after-action report.\n[/list]',
    },
  ];
  return posts.map((post, i) => ({
    id: `steam-${i}`,
    title: post.title,
    url: 'https://store.steampowered.com/news/',
    author: 'Super Earth High Command',
    content: post.body,
    publishedAt: new Date(now - (i + 1) * 3.2 * 86400_000).toISOString(),
  }));
}

function currentWar() {
  return {
    started: new Date(MOCK_WAR_START).toISOString(),
    ended: new Date(Date.UTC(2028, 1, 8, 20, 4, 55)).toISOString(),
    now: new Date().toISOString(),
    clientVersion: '0.3.0',
    factions: ['Humans', 'Terminids', 'Automaton', 'Illuminate'],
    impactMultiplier: Number((0.02 + drift(3, 300_000) * 0.03).toFixed(5)),
    statistics: { ...statsFor(0, 1), playerCount: 240000 + Math.floor(drift(1.2, 240_000) * 90000) },
  };
}

/**
 * Return a mock payload in the same shape the live endpoint would.
 * `key` matches the keys of ENDPOINTS in config.js.
 */
export function mockPayload(key) {
  const planets = currentPlanets();
  switch (key) {
    case 'war': return currentWar();
    case 'planets': return planets;
    case 'campaigns': return currentCampaigns(planets);
    case 'planetEvents': return currentPlanetEvents(planets);
    case 'assignments': return currentAssignment();
    case 'dispatches': return currentDispatches();
    case 'steam': return currentBulletins();
    default: throw new Error(`No mock data for "${key}"`);
  }
}
