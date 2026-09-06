/**
 * Data layer: a cached, rate-limited, retrying fetch wrapper around the
 * Helldivers 2 community API — with an offline mode that serves the generated
 * dataset in mock.js instead.
 *
 * Design notes:
 *  - Every endpoint is cached with its own TTL. `get()` is therefore cheap to
 *    call as often as you like; it only reaches the network when data is stale.
 *  - Requests are serialised through a queue with a minimum gap, so a full
 *    six-endpoint refresh never bursts past the API's published rate limit.
 *  - A failed refresh does not discard good data. The cache keeps the last
 *    successful payload and marks it stale, so the UI can keep showing the war
 *    with a "last contact" warning rather than blanking out.
 */

import {
  API_BASE, ENDPOINTS, MOCK_SPACING, REFRESH_ORDER, REQUEST_HEADERS,
  REQUEST_SPACING, REQUEST_TIMEOUT, RETRY, STORAGE_KEY,
} from './config.js';
import { mockPayload } from './mock.js';

/* ------------------------------------------------------------ source mode */

function initialSource() {
  const params = new URLSearchParams(location.search);
  if (params.get('mock') === '1') return 'mock';
  if (params.get('live') === '1') return 'live';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'mock' || stored === 'live') return stored;
  } catch { /* private browsing; fall through to the default */ }
  return 'live';
}

let source = initialSource();

export const getSource = () => source;

export function setSource(next) {
  if (next !== 'live' && next !== 'mock') return;
  if (next === source) return;
  source = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* not fatal */ }
  cache.clear();
  unreachableUntil = 0;
  consecutiveNetworkFailures = 0;
}

/* ----------------------------------------------------------------- cache */

/**
 * key -> { data, fetchedAt, stale, error }
 * `data` survives a failed refresh on purpose (see module note).
 */
const cache = new Map();
const inFlight = new Map();

export function peek(key) {
  return cache.get(key) || null;
}

/* ------------------------------------------------------- request queueing */

let queueTail = Promise.resolve();
let lastRequestAt = 0;

/**
 * Run `task` serialised behind every other queued request, spaced out in time.
 *
 * Spacing exists to protect the API from us, so it is only charged for requests
 * the server actually received. A request that failed at the network layer
 * never reached anyone — making the next one wait 2s for it would turn an
 * offline client into a 30-second wait for the outage notice.
 */
function enqueue(task) {
  const run = queueTail.then(async () => {
    const spacing = source === 'mock' ? MOCK_SPACING : REQUEST_SPACING;
    const wait = Math.max(0, spacing - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      return await task();
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) lastRequestAt = 0;
      throw error;
    }
  });
  // Keep the chain alive even when a task rejects, or the queue deadlocks.
  queueTail = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------- transport */

export class ApiError extends Error {
  constructor(message, { status = 0, retryable = true, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * One HTTP attempt.
 *
 * `withHeaders: false` retries without the custom X-Super-* headers. Those
 * headers make the request non-simple, so the browser sends a CORS preflight
 * first; if a proxy or corporate middlebox eats the OPTIONS, dropping them lets
 * the request through as a simple GET. Identification is preferable, so we only
 * fall back after a header-carrying attempt has actually failed.
 */
async function httpGet(path, { withHeaders = true, signal } = {}) {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: withHeaders ? REQUEST_HEADERS : { 'Accept': 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
      mode: 'cors',
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      const error = new ApiError('Rate limited by the API', { status: 429 });
      error.retryAfter = Number.isFinite(retryAfter) ? retryAfter * 1000 : null;
      throw error;
    }

    if (!response.ok) {
      throw new ApiError(`HTTP ${response.status} ${response.statusText}`.trim(), {
        status: response.status,
        // 4xx other than 429 will not fix themselves; do not burn retries.
        retryable: response.status >= 500,
      });
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError('Request timed out', { status: 0, cause: error });
    }
    // fetch() rejects with an opaque TypeError for DNS failures, offline
    // clients and blocked CORS preflights alike — they are indistinguishable
    // from script, so report the honest superset.
    throw new ApiError('Network unreachable or blocked by CORS', { status: 0, cause: error });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Circuit breaker.
 *
 * When the host itself is unreachable — offline, DNS failure, blocked by a
 * network policy — every endpoint will fail identically. Grinding through six
 * endpoints x three retries at the rate-limit spacing takes the better part of
 * a minute, during which the user stares at an empty page instead of the
 * outage notice. So the first network-level failure trips the breaker and the
 * rest of the cycle fails immediately.
 *
 * The window is deliberately shorter than POLL_INTERVAL, so the next scheduled
 * poll always gets a real attempt and recovery is automatic.
 */
let unreachableUntil = 0;
let consecutiveNetworkFailures = 0;
const BREAKER_WINDOW = 5_000;
/** Two failures in a row rules out a single transient blip. */
const BREAKER_THRESHOLD = 2;

/** Record the outcome of one attempt and trip the breaker when warranted. */
function noteAttempt(error) {
  if (!error) {
    consecutiveNetworkFailures = 0;
    unreachableUntil = 0;
    return;
  }
  if (error.status !== 0) return;
  consecutiveNetworkFailures += 1;
  if (consecutiveNetworkFailures >= BREAKER_THRESHOLD) {
    unreachableUntil = Date.now() + BREAKER_WINDOW;
  }
}

/** HTTP with retry/backoff, plus the one-shot no-headers fallback. */
async function fetchWithRetry(path, signal) {
  if (Date.now() < unreachableUntil) {
    throw new ApiError('API unreachable', { status: 0, retryable: false });
  }

  let lastError;
  let allowHeaders = true;

  for (let attempt = 0; attempt < RETRY.attempts; attempt++) {
    try {
      const result = await enqueue(() => {
        // Re-check inside the queued task, not just on entry: all six endpoints
        // are queued up front, so by the time this one's turn comes round an
        // earlier endpoint may already have proved the host unreachable.
        if (Date.now() < unreachableUntil) {
          throw new ApiError('API unreachable', { status: 0, retryable: false });
        }
        return httpGet(path, { withHeaders: allowHeaders, signal });
      });
      noteAttempt(null);
      return result;
    } catch (error) {
      lastError = error;
      noteAttempt(error);
      if (!error.retryable) throw error;
      // The host is unreachable; stop spending retries on this endpoint.
      if (Date.now() < unreachableUntil) break;
      if (attempt === RETRY.attempts - 1) break;

      // A network-level failure on the first attempt is the CORS-preflight
      // signature; drop the custom headers for the remaining attempts.
      if (error.status === 0 && allowHeaders) allowHeaders = false;

      const backoff = Math.min(RETRY.maxDelay, RETRY.baseDelay * 2 ** attempt);
      await sleep(error.retryAfter ?? backoff);
    }
  }

  throw lastError;
}

/* --------------------------------------------------------------- public API */

/**
 * Fetch one endpoint, honouring its cache TTL.
 *
 * Resolves to `{ data, stale, fetchedAt, error }`. `data` is null only when we
 * have never successfully loaded this endpoint.
 */
export async function get(key, { force = false, signal } = {}) {
  const endpoint = ENDPOINTS[key];
  if (!endpoint) throw new Error(`Unknown endpoint "${key}"`);

  const entry = cache.get(key);
  if (!force && entry && !entry.stale && Date.now() - entry.fetchedAt < endpoint.ttl) {
    return entry;
  }

  // Coalesce concurrent callers onto one request.
  if (inFlight.has(key)) return inFlight.get(key);

  const request = (async () => {
    try {
      const data = source === 'mock'
        ? await mockRequest(key)
        : await fetchWithRetry(endpoint.path, signal);
      const fresh = { data, fetchedAt: Date.now(), stale: false, error: null };
      cache.set(key, fresh);
      return fresh;
    } catch (error) {
      // Preserve the last good payload; mark it stale so the UI can say so.
      const previous = cache.get(key);
      const failed = {
        data: previous ? previous.data : null,
        fetchedAt: previous ? previous.fetchedAt : 0,
        stale: true,
        error,
      };
      cache.set(key, failed);
      return failed;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/** Mock requests still go through the queue so timing behaviour matches live. */
function mockRequest(key) {
  return enqueue(async () => {
    await sleep(30 + Math.random() * 90);
    return mockPayload(key);
  });
}

/**
 * Start a fetch for every endpoint and hand back the pending promises, keyed by
 * endpoint, in REFRESH_ORDER.
 *
 * The caller gets to await them individually: because the queue is serialised
 * in call order, the first endpoint resolves immediately while the last is
 * still waiting its turn, which lets the UI paint progressively instead of
 * sitting blank until the whole set lands.
 */
export function startAll(options = {}) {
  const keys = REFRESH_ORDER.filter((key) => ENDPOINTS[key]);
  // Anything added to ENDPOINTS but missing from REFRESH_ORDER still gets run.
  for (const key of Object.keys(ENDPOINTS)) if (!keys.includes(key)) keys.push(key);
  return keys.map((key) => ({ key, promise: get(key, options) }));
}

