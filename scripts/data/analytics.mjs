/**
 * analytics.mjs
 * The actor-side gather step for the registry's Statistics tab.
 *
 * This is the only new place the module reads actors for statistics, and it reads
 * nothing it does not already read elsewhere: acquisition flags through getState, and
 * the point pool through getPointPool. It writes nothing at all.
 *
 * Scope is deliberate — **only characters that own at least one Feat**. That keeps the
 * ledger free of rows of zeros, at the cost that a character who has never opened the
 * catalog (and may be sitting on unspent Feat Points) does not appear.
 *
 * Data layer only: no imports from apps/, and the pure arithmetic lives in
 * logic/statistics.mjs.
 */

import { MODULE_ID } from '../constants.mjs';
import { characters, getPointPool, getState } from './actor-state.mjs';

/**
 * Every character with at least one acquisition, with their point pool resolved.
 *
 * getPointPool evaluates the world's Roll formula, so this is async and one Roll is
 * evaluated per character. It runs only when the Statistics tab is actually open — the
 * app gates the call — so the cost is paid on a GM's deliberate click, never on an
 * ordinary registry render.
 *
 * @returns {Promise<Array<{actorId: string, name: string, level: number, img: string|null,
 *                          acquired: Array<object>, pool: object}>>}
 */
export async function gatherLedger() {
  const rows = [];

  for (const actor of characters()) {
    const state = getState(actor);
    if (!state.acquired.length) continue;

    let pool;
    try {
      pool = await getPointPool(actor);
    } catch (err) {
      // A broken point formula must not take the whole panel down with it — the rest
      // of this character's figures are still worth showing.
      console.warn(`${MODULE_ID} | Could not resolve the point pool for ${actor.name}:`, err);
      pool = null;
    }

    rows.push({
      actorId: actor.id,
      name: actor.name,
      level: actor.system?.levelData?.level?.current ?? 0,
      img: actor.img ?? null,
      acquired: state.acquired,
      pool
    });
  }

  return rows;
}
