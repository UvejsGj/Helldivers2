/**
 * Application state: one immutable-ish snapshot of the war, plus a tiny
 * subscribe/notify bus. Views read `state` and re-render on notification;
 * nothing outside this module writes to it.
 */

import * as api from './api.js';
import { ENDPOINTS } from './config.js';
import { recordSamples, setScope } from './trend.js';
import {
  normalizeWar, normalizePlanet, normalizeCampaign, normalizeEvent,
  normalizeAssignment, normalizeDispatch, asArray,
  linkCampaigns, linkEvents, deriveAttacks, deriveSupplyLines,
} from './normalize.js';

export const state = {
  /** 'boot' | 'ready' | 'degraded' | 'down' */
  status: 'boot',
  war: null,
  planets: [],
  planetsByIndex: new Map(),
  campaignPlanets: [],
  attacks: [],
  supplyLines: [],
  assignments: [],
  dispatches: [],
  /** Per-endpoint health, for the diagnostics readout. */
  sources: {},
  lastUpdated: null,
  lastSuccessfulUpdate: null,
  /** Epoch of the stored snapshot currently on screen, or null when live. */
  restoredFrom: null,
  errors: [],
  /** Index of the planet shown in the detail panel, or null. */
  selectedPlanet: null,
  refreshing: false,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason = 'update') {
  for (const listener of listeners) {
    try {
      listener(state, reason);
    } catch (error) {
      // One broken view must not stop the others from updating.
      console.error('[super-earth-watch] listener failed', error);
    }
  }
}

export function selectPlanet(index) {
  state.selectedPlanet = index;
  notify('selection');
}

/**
 * Pull every endpoint and rebuild the snapshot.
 *
 * Each feed is applied and painted the moment it lands rather than after the
 * whole set: the request queue is serialised to respect the API's rate limit,
 * so waiting for all six would leave the page blank for the better part of a
 * minute on a cold load. Partial success is also the normal case during an
 * outage — a failed /dispatches must not cost us the map.
 */
export async function refresh({ force = false } = {}) {
  state.refreshing = true;
  notify('refresh-start');

  const started = api.startAll({ force });

  const settled = started.map(({ key, promise }) => promise.then((entry) => {
    recordSource(key, entry);
    applySlice(key);
    if (!entry.error) state.restoredFrom = api.restoredFrom();
    updateInterimStatus();
    // Paint what just arrived. Views diff their own content, so an update that
    // changes nothing is cheap.
    notify(`feed:${key}`);
    return { key, entry };
  }, (error) => {
    // api.get() resolves rather than rejects on request failure, so reaching
    // here means the data layer itself broke.
    console.error(`[super-earth-watch] feed "${key}" threw`, error);
    recordSource(key, { error, stale: true, fetchedAt: 0 });
    updateInterimStatus();
    notify(`feed:${key}`);
    return { key, entry: { error } };
  }));

  try {
    const results = await Promise.all(settled);

    state.errors = results
      .filter(({ entry }) => entry.error)
      .map(({ key, entry }) => ({
        key,
        message: entry.error.message,
        status: entry.error.status ?? 0,
      }));

    state.lastUpdated = Date.now();

    // One write per cycle, once every feed has had its turn, so the stored
    // snapshot is a coherent picture rather than whichever feed landed first.
    if (results.some(({ entry }) => !entry.error)) api.persistSnapshot();

    const haveCore = Boolean(state.war || state.planets.length);
    if (!haveCore) {
      state.status = 'down';
    } else if (state.errors.length) {
      state.status = 'degraded';
      // The map and the war summary are the dashboard; losing a secondary feed
      // is a degraded uplink, not a failed update.
      if (!state.errors.some((e) => e.key === 'war' || e.key === 'planets')) {
        state.lastSuccessfulUpdate = Date.now();
      }
    } else {
      state.status = 'ready';
      state.lastSuccessfulUpdate = Date.now();
    }
  } finally {
    state.refreshing = false;
    notify('refresh-end');
  }
}

/**
 * Move the status on as soon as a feed lands, rather than after the whole set.
 *
 * On a cold start with the API unreachable this is what puts the outage notice
 * on screen in seconds instead of after every endpoint has exhausted its
 * retries. Only ever downgrades to 'down' or upgrades off 'boot'; the
 * authoritative status is settled at the end of refresh().
 */
function updateInterimStatus() {
  const haveCore = Boolean(state.war || state.planets.length);
  const anyFailure = Object.values(state.sources).some((s) => s && !s.ok);

  if (!haveCore) {
    if (anyFailure) state.status = 'down';
    return;
  }

  if (state.status !== 'boot' && state.status !== 'down') return;

  // A feed that has failed is already news; say so as soon as we know. But do
  // not claim "all feeds reporting" until they all have — mid-cycle, several
  // are still queued behind the rate limiter.
  if (anyFailure) {
    state.status = 'degraded';
  } else if (Object.keys(ENDPOINTS).every((key) => state.sources[key])) {
    state.status = 'ready';
  }
}

function recordSource(key, entry) {
  state.sources[key] = {
    ok: !entry.error,
    stale: Boolean(entry.stale),
    fetchedAt: entry.fetchedAt || null,
    error: entry.error ? entry.error.message : null,
  };
}

/**
 * Rebuild the part of the snapshot that `key` feeds.
 *
 * Reads from the API cache rather than the just-resolved payload, so the planet
 * graph can be rebuilt from whichever of planets/campaigns/planet-events have
 * arrived so far and refined as the rest catch up.
 */
function applySlice(key) {
  switch (key) {
    case 'war': {
      const raw = api.peek('war')?.data;
      if (raw) state.war = normalizeWar(raw);
      break;
    }

    case 'planets':
    case 'campaigns':
    case 'planetEvents':
      rebuildPlanets();
      break;

    case 'assignments': {
      const raw = api.peek('assignments')?.data;
      if (raw) {
        state.assignments = asArray(raw).map(normalizeAssignment).filter(Boolean);
      }
      break;
    }

    case 'dispatches': {
      const raw = api.peek('dispatches')?.data;
      if (raw) {
        state.dispatches = asArray(raw)
          .map(normalizeDispatch)
          .filter((d) => d && d.message)
          .sort((a, b) => (b.published || 0) - (a.published || 0));
      }
      break;
    }

    default:
      break;
  }
}

/** Rebuild the planet graph, attack arrows and supply lines from the cache. */
function rebuildPlanets() {
  const rawPlanets = api.peek('planets')?.data;
  if (!rawPlanets) return;

  const planets = asArray(rawPlanets).map(normalizePlanet).filter(Boolean);
  const byIndex = new Map(planets.map((p) => [p.index, p]));

  const campaigns = asArray(api.peek('campaigns')?.data || [])
    .map(normalizeCampaign)
    .filter(Boolean);
  const events = asArray(api.peek('planetEvents')?.data || [])
    .map((e) => normalizeEvent(e))
    .filter(Boolean);

  linkCampaigns(byIndex, campaigns);
  linkEvents(byIndex, events);

  state.planets = planets;
  state.planetsByIndex = byIndex;
  state.attacks = deriveAttacks(byIndex, events);
  state.supplyLines = deriveSupplyLines(byIndex);
  state.campaignPlanets = planets
    .filter((p) => p.campaign || p.event)
    .sort((a, b) => b.players - a.players);

  setScope(api.getSource());
  recordSamples(state.campaignPlanets);
}

/**
 * Seed the store from the last snapshot written to localStorage.
 *
 * Called once before the first refresh so an offline or cold start shows the
 * war as it last stood rather than an empty outage screen.
 */
export function hydrate() {
  const savedAt = api.hydrateFromStorage();
  if (!savedAt) return false;

  for (const key of Object.keys(ENDPOINTS)) applySlice(key);

  state.restoredFrom = savedAt;
  // Honest reporting: this data is as old as the snapshot, not as old as now.
  state.lastSuccessfulUpdate = savedAt;
  state.status = state.planets.length || state.war ? 'degraded' : 'boot';
  notify('hydrate');
  return true;
}

/* ------------------------------------------------------- derived selectors */

/** The Major Order — the first assignment, which is how the API orders them. */
export const majorOrder = () => state.assignments[0] || null;

/** Planet-count split by controlling faction. */
export function factionControl() {
  const counts = { humans: 0, terminids: 0, automatons: 0, illuminate: 0, unknown: 0 };
  for (const planet of state.planets) {
    counts[planet.currentOwner] = (counts[planet.currentOwner] || 0) + 1;
  }
  return counts;
}

/** Total divers deployed, preferring the war-level figure when it is present. */
export function totalPlayers() {
  const warCount = state.war?.statistics?.playerCount || 0;
  if (warCount > 0) return warCount;
  return state.planets.reduce((sum, p) => sum + p.players, 0);
}
