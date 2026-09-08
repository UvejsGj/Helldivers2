/**
 * War events: what changed between two polls.
 *
 * The dashboard re-polls every twenty seconds and swaps its state wholesale, so
 * a planet changing hands passes unnoticed unless you happen to be looking at
 * it. Comparing consecutive snapshots turns those silent swaps into the thing
 * that actually makes the war feel live — and every event here is a difference
 * between two real payloads, never an invention.
 *
 * Pure functions over plain snapshots, so the detection logic is testable
 * without a DOM or a network.
 */

/** Ranked most to least worth interrupting someone for. */
const SEVERITY_ORDER = { critical: 0, bad: 1, good: 2, info: 3 };

/** One diff should never bury the reader; the rest are dropped. */
const MAX_EVENTS_PER_DIFF = 6;

/**
 * Reduce the store to just the fields an event can turn on.
 *
 * Deliberately not a reference to live state: the snapshot has to survive the
 * next refresh replacing every planet object.
 */
export function snapshotOf(state) {
  const planets = new Map();
  for (const planet of state.planets) {
    planets.set(planet.index, {
      name: planet.name,
      owner: planet.currentOwner,
      liberation: planet.liberation,
      players: planet.players,
      campaign: Boolean(planet.campaign),
      defence: Boolean(planet.event),
      defenceFaction: planet.event ? planet.event.faction : null,
    });
  }

  const order = state.assignments[0] || null;
  return {
    planets,
    orderId: order ? order.id : null,
    orderComplete: Boolean(order && order.tasks.length
      && order.tasks.every((task) => task.percent >= 100)),
    dispatchIds: state.dispatches.map((d) => d.id),
  };
}

/**
 * Events that fired between `before` and `after`.
 *
 * `before` being null means this is the first observation, which is a priming
 * call and never emits: on a cold start every planet and dispatch would
 * otherwise look brand new.
 */
export function diffSnapshots(before, after, now = Date.now()) {
  if (!before || !after) return [];
  const events = [];
  let sequence = 0;

  const push = (event) => {
    events.push({ ...event, at: now, id: `${event.kind}:${event.planetIndex ?? 'x'}:${now}:${sequence++}` });
  };

  for (const [index, next] of after.planets) {
    const prev = before.planets.get(index);
    if (!prev) continue; // a planet we had not seen is not a change

    if (prev.owner !== next.owner) {
      if (next.owner === 'humans') {
        push({
          kind: 'liberated',
          severity: 'good',
          planetIndex: index,
          title: `LIBERATED — ${next.name.toUpperCase()}`,
          detail: 'Managed Democracy restored.',
        });
      } else if (prev.owner === 'humans') {
        push({
          kind: 'captured',
          severity: 'critical',
          planetIndex: index,
          faction: next.owner,
          title: `PLANET LOST — ${next.name.toUpperCase()}`,
          detail: 'The garrison has been overrun.',
        });
      } else {
        push({
          kind: 'seized',
          severity: 'info',
          planetIndex: index,
          faction: next.owner,
          title: `${next.name.toUpperCase()} CHANGED HANDS`,
          detail: 'Hostile forces have displaced one another.',
        });
      }
      continue; // the flip is the story; skip the campaign churn around it
    }

    if (!prev.defence && next.defence) {
      push({
        kind: 'defence',
        severity: 'bad',
        planetIndex: index,
        faction: next.defenceFaction,
        title: `UNDER ATTACK — ${next.name.toUpperCase()}`,
        detail: 'Defence operations authorised.',
      });
      continue;
    }

    // A defence that ended on a planet we still hold was a defence we won.
    if (prev.defence && !next.defence && next.owner === 'humans') {
      push({
        kind: 'defence-held',
        severity: 'good',
        planetIndex: index,
        title: `HELD — ${next.name.toUpperCase()}`,
        detail: 'The assault has been repelled.',
      });
      continue;
    }

    if (!prev.campaign && next.campaign && !next.defence) {
      push({
        kind: 'campaign',
        severity: 'info',
        planetIndex: index,
        faction: next.owner,
        title: `OFFENSIVE OPENED — ${next.name.toUpperCase()}`,
        detail: 'Liberation campaign under way.',
      });
    }
  }

  if (after.orderId !== before.orderId && after.orderId !== null) {
    push({
      kind: 'order',
      severity: 'critical',
      title: 'NEW MAJOR ORDER',
      detail: 'High Command has issued a directive.',
    });
  } else if (after.orderComplete && !before.orderComplete) {
    push({
      kind: 'order-complete',
      severity: 'good',
      title: 'MAJOR ORDER COMPLETE',
      detail: 'All objectives met. Await further orders.',
    });
  }

  const known = new Set(before.dispatchIds);
  const fresh = after.dispatchIds.filter((id) => !known.has(id));
  if (fresh.length) {
    push({
      kind: 'dispatch',
      severity: 'info',
      title: fresh.length === 1 ? 'NEW DISPATCH' : `${fresh.length} NEW DISPATCHES`,
      detail: 'Ministry of Truth broadcast received.',
    });
  }

  // Most urgent first, and capped: a poll that lands during a galaxy-wide push
  // could otherwise produce dozens at once.
  events.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return events.slice(0, MAX_EVENTS_PER_DIFF);
}
