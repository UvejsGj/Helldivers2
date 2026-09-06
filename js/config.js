/**
 * Super Earth Watch — configuration.
 *
 * Everything environment-specific lives here so the rest of the app stays
 * declarative. Nothing in this file has side effects.
 */

/** Base URL of the Helldivers 2 community API. */
export const API_BASE = 'https://api.helldivers2.dev';

/**
 * The community API asks every consumer to identify itself so the maintainers
 * can reach you if your client misbehaves. See the usage guidelines at
 * https://helldivers-2.github.io/api/.
 *
 * Note: browsers refuse to let fetch() override `User-Agent`, so identification
 * happens through the two `X-Super-*` headers instead. Edit CONTACT before you
 * deploy this anywhere public — a real address is the whole point of the header.
 */
export const CLIENT_NAME = 'super-earth-watch';
export const CLIENT_CONTACT = 'uvejsgjelaj03@gmail.com';

export const REQUEST_HEADERS = {
  'Accept': 'application/json',
  'X-Super-Client': CLIENT_NAME,
  'X-Super-Contact': CLIENT_CONTACT,
};

/**
 * Per-endpoint cache lifetimes, in milliseconds.
 *
 * The war only moves so fast: planet health ticks continuously but assignments
 * and dispatches change a few times a day. A short TTL on the volatile feeds and
 * a long one on the slow feeds keeps us far inside the API's rate limit while
 * still feeling live.
 */
export const ENDPOINTS = {
  war:          { path: '/api/v1/war',           ttl: 60_000  },
  planets:      { path: '/api/v1/planets',       ttl: 45_000  },
  campaigns:    { path: '/api/v1/campaigns',     ttl: 45_000  },
  planetEvents: { path: '/api/v1/planet-events', ttl: 45_000  },
  assignments:  { path: '/api/v1/assignments',   ttl: 120_000 },
  dispatches:   { path: '/api/v1/dispatches',    ttl: 120_000 },
};

/**
 * How often the scheduler wakes up. On each tick it only refetches the
 * endpoints whose TTL has actually expired, so this is a polling *floor*,
 * not a request rate.
 */
export const POLL_INTERVAL = 20_000;

/**
 * Minimum gap between two outbound live requests. The API's published guidance
 * is roughly five requests per ten seconds, so a request every ~2.1s keeps even
 * a full six-endpoint refresh under the limit with room to spare.
 *
 * The cost is that a cold load takes ~12s to fill every panel, which is why
 * REFRESH_ORDER exists and why state.refresh() paints each feed as it lands
 * rather than waiting for the set.
 */
export const REQUEST_SPACING = 2_100;

/** Mock mode talks to nobody, so it has no rate limit to respect. */
export const MOCK_SPACING = 40;

/**
 * The order endpoints are requested in, most valuable first: the Major Order
 * banner is the top of the page, the map is the main feature, and the stats and
 * dispatch panels can afford to arrive a few seconds later.
 */
export const REFRESH_ORDER = [
  'assignments', 'planets', 'war', 'campaigns', 'planetEvents', 'dispatches',
];

/** Network retry policy for transient failures (never applied to 4xx). */
export const RETRY = { attempts: 3, baseDelay: 800, maxDelay: 6_000 };

/** Give up on a single request after this long. */
export const REQUEST_TIMEOUT = 15_000;

/**
 * Faction identity. `key` values are what the rest of the app passes around;
 * `normalizeFaction()` in normalize.js maps every spelling the API has ever
 * used onto one of them.
 */
export const FACTIONS = {
  humans: {
    key: 'humans',
    label: 'Super Earth',
    short: 'SE',
    color: '#3d8bff',
    dim: '#12325f',
    glow: 'rgba(61, 139, 255, 0.55)',
  },
  terminids: {
    key: 'terminids',
    label: 'Terminids',
    short: 'TRM',
    color: '#ffa41f',
    dim: '#5c3a05',
    glow: 'rgba(255, 164, 31, 0.55)',
  },
  automatons: {
    key: 'automatons',
    label: 'Automatons',
    short: 'AUT',
    color: '#ff4444',
    dim: '#5c1414',
    glow: 'rgba(255, 68, 68, 0.55)',
  },
  illuminate: {
    key: 'illuminate',
    label: 'Illuminate',
    short: 'ILL',
    color: '#a271ff',
    dim: '#361b63',
    glow: 'rgba(162, 113, 255, 0.55)',
  },
  unknown: {
    key: 'unknown',
    label: 'Unknown',
    short: '???',
    color: '#7d8896',
    dim: '#2a3038',
    glow: 'rgba(125, 136, 150, 0.4)',
  },
};

export const faction = (key) => FACTIONS[key] || FACTIONS.unknown;

/**
 * Data source. 'live' hits the API; 'mock' runs entirely offline against the
 * generated dataset in mock.js. The choice persists in localStorage, and
 * `?mock=1` in the URL forces mock mode for a single visit.
 */
export const STORAGE_KEY = 'sew:source';
