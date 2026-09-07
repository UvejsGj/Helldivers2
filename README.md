# Super Earth Watch

A live Helldivers 2 Galactic War dashboard: Major Orders, a pan-and-zoom galactic
map, war statistics and the dispatch feed, styled as a Super Earth propaganda
broadcast.

Single-page app, vanilla HTML/CSS/JS with ES modules. No build step, no
dependencies, no bundler.

## Running it

ES modules need to be served over HTTP — opening `index.html` from the filesystem
will not work, and the live API rejects requests from a `file://` origin anyway.

```sh
python3 -m http.server 8000     # or: npm start
# then open http://localhost:8000
```

Any static server does; there is nothing to compile.

### Tests

```sh
npm test
```

Node's built-in test runner, no dependencies. Covers the parsing layer
(`js/normalize.js`), the formatters and escaping (`js/format.js`) and the trend
maths (`js/trend.js`) — the parts with real logic and no DOM.

### Data source

| URL | Behaviour |
| --- | --- |
| `/` | Live API, remembering whatever you last selected |
| `/?live=1` | Force the live API for this visit |
| `/?mock=1` | Force the offline dataset for this visit |
| `/?planet=Meridia` | Open straight onto a planet (name, or index) |

The **LIVE / ARCHIVE** toggle in the masthead switches at runtime and persists the
choice in `localStorage`. Archive mode serves a generated galaxy from
`js/mock.js` — useful for working on the UI without hitting the API, and offered
as a fallback on the outage screen.

## Data source and API etiquette

Data comes from the [Helldivers 2 community API](https://helldivers-2.github.io/api/)
at `https://api.helldivers2.dev`. No authentication is required, but the
maintainers ask that clients identify themselves and stay within the rate limit.

**Before deploying this anywhere public, set your own contact details** in
`js/config.js`:

```js
export const CLIENT_NAME = 'super-earth-watch';
export const CLIENT_CONTACT = 'you@example.com';
```

These are sent as `X-Super-Client` and `X-Super-Contact`. Browsers do not allow
`fetch()` to override `User-Agent`, so those two headers are how this app
identifies itself.

Rate limiting is handled in `js/api.js`:

- requests are serialised through a queue with a ~2.1s minimum gap, keeping a
  full six-endpoint refresh inside the documented allowance;
- each endpoint has its own cache TTL (45–120s) and is only refetched when stale,
  so the 20s poll usually issues one or two requests, not six;
- `429` responses honour `Retry-After`;
- spacing is not charged for requests that failed at the network layer, since
  those never reached the server.

### Endpoints used

| Endpoint | Feeds |
| --- | --- |
| `/api/v1/war` | Global statistics, impact multiplier, war window |
| `/api/v1/planets` | Every planet: position, health, owner, players, biome |
| `/api/v1/campaigns` | Active battles |
| `/api/v1/planet-events` | Defence events, used for front-line arrows |
| `/api/v1/assignments` | Major Order: tasks, progress, reward, expiry |
| `/api/v1/dispatches` | News feed |

There is no separate `/war/summary` endpoint in v1 — the global totals the War
Stats panel needs are on `/api/v1/war` under `statistics`, which is what the app
reads.

## Architecture

```
index.html
css/styles.css
js/
  config.js       endpoints, TTLs, faction palette, rate-limit policy
  api.js          fetch wrapper: cache, queue, retries, breaker, snapshots
  mock.js         generated offline galaxy, in the API's own shapes
  normalize.js    defensive parsing + derived attacks and supply lines
  trend.js        liberation rate over time, and what it projects
  state.js        one snapshot of the war + subscribe/notify bus
  format.js       number, countdown and dispatch formatting
  app.js          bootstrap, auto-refresh loop, deep links
  ui/
    majorOrder.js  status.js  map.js  planetPanel.js  stats.js  dispatches.js
test/
  normalize.test.mjs  format.test.mjs  trend.test.mjs
```

The data flows one way: `api` → `normalize` → `state` → views. Views subscribe to
the store and re-render; nothing outside `state.js` mutates state.

### Notes on a few decisions

**Progressive rendering.** Because the request queue is serialised to respect the
rate limit, waiting for all six endpoints would leave the page blank for ~10
seconds on a cold load. `state.refresh()` applies and paints each feed as it
lands, and endpoints are requested in `REFRESH_ORDER` — Major Order first, then
the map, then the secondary panels.

**Defensive normalisation.** The community API's shapes have shifted between
versions, so every accessor in `normalize.js` tries several field names and falls
back to something renderable. A dashboard that shows `—` for one number is better
than one that throws on an unexpected null.

**Front-line arrows.** Attack directions are taken from explicit source/target
pairs on planet-events when the API supplies them, then from each planet's
`attacking` list. Anything still missing is inferred from supply-line adjacency —
a defended planet must be under attack from an adjacent hostile world, and an
active liberation is a push from an adjacent friendly one. Inferred links are
drawn dashed and semi-transparent so reported fact is distinguishable from the
app's arithmetic.

**Outage handling.** A failed poll never blanks the dashboard: the cache keeps
the last good payload and the status bar reports how stale it is. Each completed
refresh also mirrors itself to `localStorage`, so even a cold start with the API
down opens on the war as it last stood, labelled *LAST KNOWN POSITIONS* with its
true age. Only a first-ever visit with no snapshot shows the full "war data
unavailable" screen, and it gets there in well under a second: a circuit breaker
trips after two consecutive network-level failures so the remaining endpoints
fail immediately rather than grinding through their retries.

**Identification vs. the breaker.** The `X-Super-*` headers make every request
preflighted. If the API ever declines that `OPTIONS`, all six endpoints fail at
the network layer — indistinguishable from being offline. So the headers are
dropped *globally* on the first such failure and the breaker only concludes
"host unreachable" after a headerless attempt has also failed; otherwise a
rejected preflight would present as a total outage and the fallback would never
run. When the client ends up unidentified the status bar says so.

**Rate of advance.** The API reports a position, never a velocity, but the
question players actually have is whether a planet will fall in time. `trend.js`
keeps a short per-planet history of liberation percentages in `localStorage` and
takes a least-squares slope over it — regression rather than first-versus-last,
because campaigns genuinely stall and restart. Below three samples or twelve
minutes of span it reports nothing at all rather than a confident-looking number
drawn from noise.

## Map controls

| Action | Control |
| --- | --- |
| Pan | Drag, or arrow keys (Shift for larger steps) |
| Zoom | Scroll, pinch, `+` / `-`, or double-click |
| Reset / refit | `RESET` button, or `0` |
| Inspect a planet | Click it, or pick one from Active Fronts |
| Close the detail panel | `Esc` |
| Force a refresh | `R` |

The map frames itself to the planets on first load and refits on resize, but
stops doing so once you have panned or zoomed — your framing is yours to keep.

Planets are colour-coded by controlling faction, sized halos show diver presence,
active campaigns pulse with a liberation arc, and supply lines are drawn from
each planet's `waypoints`.

## Accessibility and responsiveness

- Full layout down to 320px; the planet detail becomes a bottom sheet on mobile.
- `prefers-reduced-motion` stops the ambient map animation and the CRT overlay.
- Progress bars expose `role="progressbar"` with live values; the status bar is a
  live region.
- The canvas is keyboard-navigable, and the Active Fronts list is a keyboard- and
  screen-reader-accessible route to every planet with a live campaign.

## Licence and attribution

Unofficial fan project. Not affiliated with Arrowhead Game Studios or Sony.
Game data belongs to its respective owners; thanks to the maintainers of the
community API.
