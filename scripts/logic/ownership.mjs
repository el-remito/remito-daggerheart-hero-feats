/**
 * ownership.mjs
 * A Feat read from the OWNER's end: has it changed since they took it, and (v1.9.0) may
 * they hand it back. PURE — acquisition records and normalized registry entries in,
 * plain values out, no `game.*` and no documents, so node can exercise it directly.
 *
 * A separate module rather than more functions on recency.mjs, because the question is
 * different even though it reads the same `updatedAt`: recency asks which Feats are
 * among the most recently changed for EVERYONE, a property of the set that expires
 * whatever anybody does. This asks whether THIS character has answered for a change,
 * which is a property of one acquisition and never expires on its own — a player away
 * longer than the UPDATED window must still be told.
 */

/**
 * Whether an owned Feat has changed since its owner last answered for it.
 *
 * The baseline is the LATER of the acquisition and the last Keep: a change made before
 * the character bought the Feat never counts, because they bought the current version,
 * and a Keep answers for every change up to that moment. A Feat changed again after a
 * Keep is pending again, with no state of its own to reset.
 *
 * @param {{at?: number, seenAt?: number}|null} entry  the acquisition record
 * @param {{updatedAt?: number}|null} feat             the normalized registry entry
 * @returns {boolean}
 */
export function isPendingChange(entry, feat) {
  if (!entry || !feat) return false;
  const changed = Number(feat.updatedAt) || 0;
  if (changed <= 0) return false;
  return changed > Math.max(Number(entry.at) || 0, Number(entry.seenAt) || 0);
}

/**
 * Every acquisition on a character that is waiting on a Keep or Refund.
 *
 * @param {Array<object>} acquired           the actor's acquisition records
 * @param {(uuid: string) => object|null} featOf  normalized registry entry by uuid
 * @returns {string[]}  uuids, in acquisition order
 */
export function pendingChanges(acquired, featOf) {
  return (acquired ?? []).filter(entry => isPendingChange(entry, featOf(entry.uuid))).map(e => e.uuid);
}
