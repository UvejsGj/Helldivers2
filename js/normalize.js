/**
 * Defensive normalisation of the community API's payloads.
 *
 * The API is community-run and its shapes have shifted between versions (fields
 * get renamed, `statistics` sometimes arrives flattened, `planet-events` has
 * carried attack endpoints under three different names). Every accessor here
 * tolerates a missing or renamed field and falls back to something renderable,
 * because a dashboard that throws on one unexpected null is worse than a
 * dashboard that shows "—" for one number.
 */

/* ------------------------------------------------------------------ helpers */

/** First defined, non-null value among `keys` on `obj`. */
export function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
}

/** Coerce to a finite number, or `fallback`. Handles numeric strings. */
export function num(value, fallback = 0) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Always hand back an array, whatever we were given. */
export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  // Some endpoints wrap their payload, e.g. { data: [...] } or { items: [...] }.
  if (typeof value === 'object') {
    for (const key of ['data', 'items', 'results', 'value']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [value];
}

/** Parse an ISO timestamp to epoch ms; `null` when unparseable. */
export function toEpoch(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    // Heuristic: values below ~1e12 are seconds, above are milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  // The API emits UTC timestamps that sometimes omit the trailing Z; without it
  // browsers parse the string as local time and the countdown drifts by hours.
  let text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const FACTION_ALIASES = new Map(Object.entries({
  humans: 'humans',
  human: 'humans',
  'super earth': 'humans',
  superearth: 'humans',
  se: 'humans',
  terminids: 'terminids',
  terminid: 'terminids',
  bugs: 'terminids',
  automaton: 'automatons',
  automatons: 'automatons',
  bots: 'automatons',
  cyborg: 'automatons',
  cyborgs: 'automatons',
  illuminate: 'illuminate',
  illuminates: 'illuminate',
  squids: 'illuminate',
}));

/** Map any spelling the API uses onto one of our canonical faction keys. */
export function normalizeFaction(value) {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number') {
    // Raw war-status payloads use numeric faction ids.
    return ['unknown', 'humans', 'terminids', 'illuminate', 'automatons'][value] || 'unknown';
  }
  const key = String(value).trim().toLowerCase();
  return FACTION_ALIASES.get(key) || 'unknown';
}

/* ------------------------------------------------------------- statistics */

/**
 * War statistics, as attached to both `/war` and each planet. Field names have
 * been stable but the container has moved, so accept it flattened too.
 */
export function normalizeStatistics(raw) {
  const s = (raw && typeof raw === 'object' && (raw.statistics || raw)) || {};
  const bulletsFired = num(pick(s, ['bulletsFired', 'bullets_fired']));
  const bulletsHit = num(pick(s, ['bulletsHit', 'bullets_hit']));
  const missionsWon = num(pick(s, ['missionsWon', 'missions_won']));
  const missionsLost = num(pick(s, ['missionsLost', 'missions_lost']));

  // `accuracy` and `missionSuccessRate` arrive as whole percentages when
  // present; when they are absent we can derive both from the raw counters.
  const reportedAccuracy = pick(s, ['accuracy']);
  const accuracy = reportedAccuracy !== undefined
    ? num(reportedAccuracy)
    : (bulletsFired > 0 ? (bulletsHit / bulletsFired) * 100 : 0);

  const reportedSuccess = pick(s, ['missionSuccessRate', 'mission_success_rate']);
  const totalMissions = missionsWon + missionsLost;
  const missionSuccessRate = reportedSuccess !== undefined
    ? num(reportedSuccess)
    : (totalMissions > 0 ? (missionsWon / totalMissions) * 100 : 0);

  return {
    missionsWon,
    missionsLost,
    missionTime: num(pick(s, ['missionTime', 'mission_time'])),
    terminidKills: num(pick(s, ['terminidKills', 'terminid_kills'])),
    automatonKills: num(pick(s, ['automatonKills', 'automaton_kills'])),
    illuminateKills: num(pick(s, ['illuminateKills', 'illuminate_kills'])),
    bulletsFired,
    bulletsHit,
    timePlayed: num(pick(s, ['timePlayed', 'time_played'])),
    deaths: num(pick(s, ['deaths'])),
    revives: num(pick(s, ['revives'])),
    friendlies: num(pick(s, ['friendlies', 'friendlyKills', 'friendly_kills'])),
    playerCount: num(pick(s, ['playerCount', 'player_count', 'players'])),
    accuracy,
    missionSuccessRate,
  };
}

/* ------------------------------------------------------------------ events */

/**
 * A planet event is a defence: an enemy faction is trying to take a planet we
 * hold, and `health` counts *down* as divers push them off.
 */
export function normalizeEvent(raw, planetIndex = null) {
  if (!raw || typeof raw !== 'object') return null;

  const maxHealth = num(pick(raw, ['maxHealth', 'max_health']), 0);
  const health = num(pick(raw, ['health']), maxHealth);

  return {
    id: num(pick(raw, ['id', 'eventId', 'campaignId']), 0),
    eventType: num(pick(raw, ['eventType', 'event_type', 'type']), 0),
    faction: normalizeFaction(pick(raw, ['faction', 'race', 'attacker'])),
    health,
    maxHealth,
    // Defence progress: 0% when the event opens, 100% when the attackers break.
    progress: maxHealth > 0 ? clamp01(1 - health / maxHealth) * 100 : 0,
    startTime: toEpoch(pick(raw, ['startTime', 'start_time', 'start'])),
    endTime: toEpoch(pick(raw, ['endTime', 'end_time', 'expireTime', 'end'])),
    campaignId: num(pick(raw, ['campaignId', 'campaign_id']), 0),
    jointOperationIds: asArray(pick(raw, ['jointOperationIds', 'joint_operation_ids'], [])),
    planetIndex: planetIndex ?? planetIndexOf(pick(raw, ['planet', 'planetIndex'])),
    // Kept so deriveAttacks() can look for source/target endpoints that this
    // normaliser has no canonical home for.
    raw,
  };
}

/** Pull a planet index out of either a bare number or a nested planet object. */
export function planetIndexOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (typeof value === 'object') {
    const idx = pick(value, ['index', 'planetIndex', 'planet_index', 'id']);
    return idx === undefined ? null : num(idx, null);
  }
  return null;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/* ----------------------------------------------------------------- planets */

export function normalizePlanet(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const index = num(pick(raw, ['index', 'planetIndex', 'id']), -1);
  if (index < 0) return null;

  const maxHealth = num(pick(raw, ['maxHealth', 'max_health']), 0);
  const health = num(pick(raw, ['health']), maxHealth);
  const position = pick(raw, ['position', 'coords'], {}) || {};
  const currentOwner = normalizeFaction(pick(raw, ['currentOwner', 'current_owner', 'owner']));
  const statistics = normalizeStatistics(raw.statistics ?? raw);
  const event = normalizeEvent(pick(raw, ['event', 'planetEvent']), index);

  // Liberation is measured against whoever *isn't* holding it: on an enemy
  // planet, health falling means we are liberating. A planet under attack is
  // the exception — its own health sits at full while the fight plays out on
  // the event's separate health pool, so the defence progress is the real
  // reading and the planet ratio would show a flat 0%.
  const damageRatio = maxHealth > 0 ? clamp01(1 - health / maxHealth) : 0;
  const progress = event ? event.progress : damageRatio * 100;

  return {
    index,
    name: String(pick(raw, ['name'], `Planet ${index}`)),
    sector: String(pick(raw, ['sector'], 'Unknown Sector')),
    biome: normalizeNamed(pick(raw, ['biome'])),
    hazards: asArray(pick(raw, ['hazards'], [])).map(normalizeNamed).filter(Boolean),
    position: { x: num(position.x), y: num(position.y) },
    waypoints: asArray(pick(raw, ['waypoints'], []))
      .map(planetIndexOf)
      .filter((n) => n !== null),
    health,
    maxHealth,
    disabled: Boolean(pick(raw, ['disabled'], false)),
    initialOwner: normalizeFaction(pick(raw, ['initialOwner', 'initial_owner'])),
    currentOwner,
    regenPerSecond: num(pick(raw, ['regenPerSecond', 'regen_per_second'])),
    event,
    statistics,
    players: statistics.playerCount,
    attacking: asArray(pick(raw, ['attacking'], []))
      .map(planetIndexOf)
      .filter((n) => n !== null),
    liberation: progress,
    // Filled in by linkCampaigns() once the campaign list is known.
    campaign: null,
  };
}

function normalizeNamed(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { name: raw, description: '' };
  const name = pick(raw, ['name'], null);
  if (!name) return null;
  return { name: String(name), description: String(pick(raw, ['description'], '')) };
}

/* --------------------------------------------------------------- campaigns */

export function normalizeCampaign(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const planetIndex = planetIndexOf(pick(raw, ['planet', 'planetIndex', 'planet_index']));
  if (planetIndex === null) return null;
  return {
    id: num(pick(raw, ['id', 'campaignId']), 0),
    planetIndex,
    type: num(pick(raw, ['type']), 0),
    count: num(pick(raw, ['count']), 1),
    // The embedded planet is a convenience copy; the canonical one comes from
    // /planets, so we only keep the fields campaigns adds.
    faction: normalizeFaction(pick(raw, ['faction', 'race'])),
  };
}

/* ------------------------------------------------------------- assignments */

/**
 * A Major Order. `setting` holds the briefing and tasks; `progress` is a
 * positional array matching `setting.tasks`.
 */
export function normalizeAssignment(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const setting = pick(raw, ['setting', 'settings'], raw) || {};
  const progress = asArray(pick(raw, ['progress'], [])).map((v) => num(v));
  const tasks = asArray(pick(setting, ['tasks'], [])).map((task, i) =>
    normalizeTask(task, progress[i]),
  );

  const expiresIn = pick(raw, ['expiresIn', 'expires_in']);
  const expiration = toEpoch(pick(raw, ['expiration', 'expiresAt', 'endTime']));

  return {
    id: num(pick(raw, ['id', 'id32']), 0),
    title: String(pick(setting, ['overrideTitle', 'title'], 'MAJOR ORDER')).trim(),
    briefing: String(pick(setting, ['overrideBrief', 'briefing', 'brief'], '')).trim(),
    description: String(pick(setting, ['taskDescription', 'description'], '')).trim(),
    tasks,
    progress,
    reward: normalizeReward(pick(setting, ['reward'])),
    rewards: asArray(pick(setting, ['rewards'], [])).map(normalizeReward).filter(Boolean),
    // Prefer an absolute timestamp; fall back to "seconds from now", resolved
    // once at parse time so the countdown does not reset on every re-render.
    expiresAt: expiration ?? (expiresIn !== undefined ? Date.now() + num(expiresIn) * 1000 : null),
    flags: num(pick(setting, ['flags']), 0),
  };
}

/**
 * Task `values`/`valueTypes` are parallel arrays: valueTypes describe what each
 * slot means. Type 3 is the goal amount and type 12 is the planet count for the
 * common "liberate N planets" / "kill N enemies" orders.
 */
function normalizeTask(raw, progressValue) {
  const values = asArray(pick(raw, ['values'], [])).map((v) => num(v));
  const valueTypes = asArray(pick(raw, ['valueTypes', 'value_types'], [])).map((v) => num(v));

  const valueOfType = (type) => {
    const i = valueTypes.indexOf(type);
    return i >= 0 ? values[i] : undefined;
  };

  // Goal: the explicit amount (type 3) when present, else the planet-count slot
  // (type 12), else the largest value in the array, else a simple 0/1 flag.
  const goal = valueOfType(3) ?? valueOfType(12) ?? (values.length ? Math.max(...values) : 1);
  const current = num(progressValue, 0);

  return {
    type: num(pick(raw, ['type']), 0),
    values,
    valueTypes,
    goal: goal > 0 ? goal : 1,
    current,
    percent: goal > 0 ? Math.min(100, (current / goal) * 100) : (current > 0 ? 100 : 0),
  };
}

const REWARD_TYPES = { 1: 'Medals', 2: 'Requisition', 3: 'Super Credits' };

function normalizeReward(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = num(pick(raw, ['type']), 1);
  return {
    type,
    label: REWARD_TYPES[type] || 'Reward',
    amount: num(pick(raw, ['amount'])),
  };
}

/* -------------------------------------------------------------- dispatches */

export function normalizeDispatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const message = pick(raw, ['message', 'body', 'text'], '');
  return {
    id: num(pick(raw, ['id']), 0),
    published: toEpoch(pick(raw, ['published', 'publishedAt', 'timestamp'])),
    type: num(pick(raw, ['type']), 0),
    message: String(message ?? ''),
  };
}

/* --------------------------------------------------------------------- war */

export function normalizeWar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    started: toEpoch(pick(raw, ['started', 'startDate'])),
    ended: toEpoch(pick(raw, ['ended', 'endDate'])),
    now: toEpoch(pick(raw, ['now'])) ?? Date.now(),
    clientVersion: String(pick(raw, ['clientVersion', 'client_version'], '')),
    factions: asArray(pick(raw, ['factions'], [])).map(normalizeFaction),
    impactMultiplier: num(pick(raw, ['impactMultiplier', 'impact_multiplier']), 0),
    statistics: normalizeStatistics(raw),
  };
}

/* ------------------------------------------------------- derived structures */

/** Attach campaign records to their planets, in place. */
export function linkCampaigns(planetsByIndex, campaigns) {
  for (const campaign of campaigns) {
    const planet = planetsByIndex.get(campaign.planetIndex);
    if (planet) planet.campaign = campaign;
  }
}

/** Attach standalone planet-events to their planets when /planets omitted them. */
export function linkEvents(planetsByIndex, events) {
  for (const event of events) {
    if (event.planetIndex === null) continue;
    const planet = planetsByIndex.get(event.planetIndex);
    if (planet && !planet.event) {
      planet.event = event;
      // A defence overrides the liberation reading with the defence progress.
      planet.liberation = event.progress;
    }
  }
}

/**
 * Work out which planet is attacking which, for the front-line arrows.
 *
 * Three sources, in descending order of trust:
 *   1. explicit source/target pairs on planet-events (when the API supplies them),
 *   2. each planet's own `attacking` list,
 *   3. inference — for a planet under defence with neither of the above, the
 *      attack must be coming from an adjacent planet the attacking faction
 *      holds.
 *
 * A fourth pass adds our own offensives: an active liberation campaign on an
 * enemy world is a front line too, pushed from whichever of our planets borders
 * it. Everything derived rather than reported is flagged `inferred`, and the map
 * draws those dashed so a reader can tell reported fact from our arithmetic.
 */
export function deriveAttacks(planetsByIndex, events) {
  const attacks = new Map(); // "source>target" -> attack
  const add = (source, target, factionKey, inferred) => {
    if (source === null || target === null || source === target) return;
    if (!planetsByIndex.has(source) || !planetsByIndex.has(target)) return;
    const key = `${source}>${target}`;
    const existing = attacks.get(key);
    // A real link always wins over an inferred one.
    if (existing && !(existing.inferred && !inferred)) return;
    attacks.set(key, { source, target, faction: factionKey, inferred });
  };

  // 1. Explicit endpoints on the event payload.
  for (const event of events) {
    const raw = event.raw || {};
    const source = planetIndexOf(pick(raw, ['source', 'sourcePlanet', 'sourcePlanetIndex', 'from']));
    const target = planetIndexOf(pick(raw, ['target', 'targetPlanet', 'targetPlanetIndex', 'to']))
      ?? event.planetIndex;
    if (source !== null && target !== null) add(source, target, event.faction, false);
  }

  // 2. Per-planet attack lists.
  for (const planet of planetsByIndex.values()) {
    for (const target of planet.attacking) {
      add(planet.index, target, planet.currentOwner, false);
    }
  }

  // 3. Inference for defences we have no explicit link for.
  for (const planet of planetsByIndex.values()) {
    if (!planet.event) continue;
    if (hasTarget(attacks, planet.index)) continue;

    // Closest neighbour the attacking faction holds is the likely staging ground.
    const source = nearestNeighbourOwnedBy(planetsByIndex, planet, planet.event.faction);
    if (source) add(source.index, planet.index, planet.event.faction, true);
  }

  // 4. Our own offensives: a live liberation campaign on an enemy world is a
  //    front line, pushed from whichever planet of ours borders it.
  for (const planet of planetsByIndex.values()) {
    if (!planet.campaign || planet.event) continue;
    if (planet.currentOwner === 'humans') continue;
    if (hasTarget(attacks, planet.index)) continue;

    const source = nearestNeighbourOwnedBy(planetsByIndex, planet, 'humans');
    if (source) add(source.index, planet.index, 'humans', true);
  }

  return [...attacks.values()];
}

function hasTarget(attacks, target) {
  for (const attack of attacks.values()) if (attack.target === target) return true;
  return false;
}

function nearestNeighbourOwnedBy(planetsByIndex, planet, factionKey) {
  const neighbours = planet.waypoints
    .map((i) => planetsByIndex.get(i))
    .filter((p) => p && p.currentOwner === factionKey);
  if (!neighbours.length) return null;
  return neighbours.reduce((best, p) =>
    distance(p, planet) < distance(best, planet) ? p : best);
}

function distance(a, b) {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.hypot(dx, dy);
}

/** Unique undirected supply lines between planets, from their waypoints. */
export function deriveSupplyLines(planetsByIndex) {
  const seen = new Set();
  const lines = [];
  for (const planet of planetsByIndex.values()) {
    for (const otherIndex of planet.waypoints) {
      if (!planetsByIndex.has(otherIndex)) continue;
      const key = planet.index < otherIndex
        ? `${planet.index}-${otherIndex}`
        : `${otherIndex}-${planet.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ a: planet.index, b: otherIndex });
    }
  }
  return lines;
}
