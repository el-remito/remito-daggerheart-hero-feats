/**
 * points.mjs
 * Pure Feat Point arithmetic. Takes plain numbers — the caller evaluates the Roll
 * formula and reads the actor flag, this file only does the maths.
 *
 * Cost is a flat 1 Feat Point per Feat (locked design decision), so `spent` is simply
 * a count. Entries marked `free` are GM grants that deliberately did not charge.
 */

/**
 * @param {object} args
 * @param {number} args.formulaTotal  result of the world point formula for this actor
 * @param {number} [args.adjustment]  per-actor GM bonus/penalty
 * @param {Array<{uuid: string, free: boolean}>} [args.acquired]  acquisition entries
 * @returns {{total: number, base: number, adjustment: number, spent: number,
 *            free: number, remaining: number, overspent: boolean}}
 */
export function computePool({ formulaTotal, adjustment = 0, acquired = [] } = {}) {
  const base = Number.isFinite(formulaTotal) ? formulaTotal : 0;
  const adj = Number(adjustment) || 0;
  const total = base + adj;

  // Tolerates the legacy object shape so a stale caller cannot throw; getState is
  // what actually normalizes it. Duplicate uuids are counted once.
  const list = Array.isArray(acquired) ? acquired : Object.values(acquired ?? {});
  const seen = new Set();
  const entries = list.filter(e => {
    const key = e?.uuid ?? e;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const free = entries.filter(e => e?.free === true).length;
  const spent = entries.length - free;

  return {
    total,
    base,
    adjustment: adj,
    spent,
    free,
    remaining: total - spent,
    overspent: total - spent < 0
  };
}

/** Convenience predicate — the badge glows only when there is something to spend. */
export function hasUnspent(pool) {
  return (pool?.remaining ?? 0) > 0;
}
