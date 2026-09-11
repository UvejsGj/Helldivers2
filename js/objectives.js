/**
 * Turning a Major Order task into something a person can read.
 *
 * The API describes an objective as a type plus two parallel arrays, `values`
 * and `valueTypes`. The type says what kind of objective it is; the slots carry
 * the faction, the goal, and sometimes a planet. Rendering that as
 * "OBJECTIVE 01" throws away everything the payload actually said.
 *
 * The slot meanings are community knowledge rather than a published contract,
 * so every reading here is guarded: anything that cannot be established falls
 * back to the numbered label rather than asserting something invented.
 */

import { FACTIONS } from './config.js';
import { compact, full } from './format.js';

/** Objective types, as far as they are known. */
export const TASK_TYPES = {
  EXTRACT: 2,
  ELIMINATE: 3,
  LIBERATE: 11,
  DEFEND: 12,
  HOLD: 13,
};

/**
 * Describe one task.
 *
 * `planetsByIndex` lets a planet-scoped objective name its world; without it
 * (or when the reference does not resolve) the description falls back to the
 * count form, which is still true.
 */
export function describeTask(task, planetsByIndex, index = 0) {
  const planet = resolvePlanet(task, planetsByIndex);
  const factionName = task.faction && task.faction !== 'unknown'
    ? FACTIONS[task.faction].label.toUpperCase()
    : null;
  const goal = task.goal;
  const plural = goal === 1 ? '' : 'S';

  const base = {
    planetIndex: planet ? planet.index : null,
    faction: task.faction !== 'unknown' ? task.faction : null,
    // Whether a running total means anything, or the objective is just done or not.
    binary: goal <= 1,
  };

  switch (task.type) {
    case TASK_TYPES.LIBERATE:
      return planet
        ? { ...base, label: `LIBERATE ${planet.name.toUpperCase()}`, unit: 'planet' }
        : { ...base, label: `LIBERATE ${full(goal)} PLANET${plural}`, unit: 'planet' };

    case TASK_TYPES.HOLD:
      return planet
        ? { ...base, label: `HOLD ${planet.name.toUpperCase()}`, unit: 'planet' }
        : { ...base, label: `HOLD ${full(goal)} PLANET${plural}`, unit: 'planet' };

    case TASK_TYPES.DEFEND:
      return planet
        ? { ...base, label: `DEFEND ${planet.name.toUpperCase()}`, unit: 'planet' }
        : { ...base, label: `DEFEND ${full(goal)} PLANET${plural}`, unit: 'planet' };

    case TASK_TYPES.ELIMINATE:
      return {
        ...base,
        label: factionName
          ? `ELIMINATE ${compact(goal)} ${factionName}`
          : `ELIMINATE ${compact(goal)} HOSTILES`,
        unit: 'kill',
      };

    case TASK_TYPES.EXTRACT:
      return { ...base, label: `EXTRACT WITH ${full(goal)} SAMPLE${plural}`, unit: 'sample' };

    default:
      // An objective type nobody has mapped yet. The numbered label says
      // nothing untrue, which beats inventing a verb for it.
      return { ...base, label: `OBJECTIVE ${String(index + 1).padStart(2, '0')}`, unit: null };
  }
}

/**
 * Decide whether a task's slot-12 value is a planet index.
 *
 * It is a planet on planet-scoped objectives and a count elsewhere, and the
 * payload does not say which. Two things have to hold before a world is named:
 * the objective has to be the kind that targets one, and its goal has to be a
 * single unit — "liberate 8 planets" carries a goal of 8 and a zero in slot 12,
 * and naming planet zero from that would be a confident lie.
 */
function resolvePlanet(task, planetsByIndex) {
  if (!planetsByIndex || task.planetRef === undefined || task.planetRef === null) return null;
  const planetScoped = [TASK_TYPES.LIBERATE, TASK_TYPES.HOLD, TASK_TYPES.DEFEND].includes(task.type);
  if (!planetScoped || task.goal > 1) return null;
  return planetsByIndex.get(task.planetRef) || null;
}

/**
 * What the objective still needs per hour to land before the order expires.
 * Null when there is no deadline, nothing left to do, or no meaningful total.
 */
export function requiredRate(task, expiresAt, now = Date.now()) {
  if (!expiresAt || task.goal <= 1) return null;
  const remaining = task.goal - task.current;
  if (remaining <= 0) return null;
  const hoursLeft = (expiresAt - now) / 3600_000;
  if (hoursLeft <= 0) return null;
  return { perHour: remaining / hoursLeft, remaining, hoursLeft };
}

/** Mean completion across every objective in the order. */
export function orderProgress(tasks) {
  if (!tasks.length) return 0;
  const total = tasks.reduce((sum, task) => sum + Math.min(100, Math.max(0, task.percent)), 0);
  return total / tasks.length;
}
