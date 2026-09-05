/**
 * visibility.mjs
 * Whether a Feat is withheld from a player, and if not, why it is visible.
 *
 * Pure: plain records and plain maps in, one of three strings out. It lives here rather
 * than inside data/registry.mjs — its only caller — because it is the whole of the
 * withholding contract, and that contract is worth being able to exercise directly
 * rather than only through a listing that needs Foundry to run.
 *
 * Reading the taxonomy is the CALLER's job: this is given the hidden entries already
 * reduced to id → reveal-mode, exactly as logic/statistics.mjs is given a collapsed
 * `withheld` rather than the entries themselves.
 */

import { prerequisiteState } from './requirements.mjs';

/**
 * Whether a Feat has been published — filed by the GM on the Curation tab, and therefore
 * available to players at all. 0 = never filed.
 *
 * It lives here rather than beside isUncurated in data/registry.mjs because three layers
 * need it and the import direction is one-way (apps/ -> data/ -> logic/): logic/statistics.mjs
 * cannot reach data/. This file already owns the withholding contract, and statistics.mjs
 * already imports two logic/ siblings rather than restating a rule they share.
 *
 * It deliberately does NOT re-test `category`. `published => curated` is an invariant kept
 * by the two writers — File requires a Category, and clearing a Category clears this stamp —
 * not enforced structurally. The one way to break it is a hand-edited import, the same
 * exposure that already lets an import name a Category no taxonomy entry has.
 *
 * @param {object} feat
 * @returns {boolean}
 */
export function isPublished(feat) {
  return Number(feat?.filedAt) > 0;
}

/**
 * STRICTEST WINS, and the order is the contract:
 *
 *   1. NOT published, or the per-feat `hidden` flag → hidden, unconditionally. Publication
 *      is not a *reason* a visible Feat is withheld; it is the precondition for being
 *      visible at all, which is why it belongs in step 1 rather than as a fifth clause.
 *      It also SUBSUMES the old uncurated withhold: File requires a Category, so nothing
 *      published can lack one. The `hidden` flag beside it is the GM's pacing tool: a Feat
 *      held back because the story has not reached it must not be revealable by anything a
 *      character does, only by the GM unticking it.
 *   2. any hidden taxonomy entry on the Feat that is NOT in reveal mode → hidden. "Hide
 *      this Category" therefore stays an absolute promise, and cannot be undone by an
 *      unrelated tag that happens to be revealable.
 *   3. every hidden entry on it is in reveal mode → the prerequisite decides.
 *   4. otherwise visible.
 *
 * The Type test is ANY, not ALL, at both steps 2 and 3 — unchanged from v1.4.2, and the
 * reason a Type can withdraw a cross-cutting slice of the catalog outright.
 *
 * A Feat with no prerequisite at all can never satisfy step 3 and stays hidden. That is
 * the honest reading of "reveal when the prerequisite is met"; the registry warns about
 * it on the row rather than letting it be discovered by its silence.
 *
 * Step 1 returns BEFORE the taxonomy is read, which is what stops a reveal-mode Category
 * resurrecting an unfiled Feat: publication is strictly stronger than any reveal.
 *
 * @param {object} feat  normalized feat record
 * @param {object} args
 * @param {boolean} args.published  see isPublished. The default is FALSE, and the polarity
 *   matters: `uncurated = false` used to default a forgetful caller to permissive, showing
 *   everything. This defaults to withholding, matching `snapshot = null` below — a caller
 *   that omits the flag now fails loudly with an empty catalog rather than leaking quietly.
 * @param {Map<string, boolean>} args.hiddenCategories  id → whether it is reveal-mode
 * @param {Map<string, boolean>} args.hiddenTypes       id → whether it is reveal-mode
 * @param {object|null} args.snapshot   the actor to measure a reveal against
 * @returns {'visible'|'hidden'|'revealed'}
 */
export function resolveVisibility(
  feat,
  { published = false, hiddenCategories = new Map(), hiddenTypes = new Map(), snapshot = null } = {}
) {
  if (!feat || !published || feat.hidden === true) return 'hidden';

  const modes = [];
  if (hiddenCategories.has(feat.category)) modes.push(hiddenCategories.get(feat.category) === true);
  for (const type of feat.types ?? []) {
    if (hiddenTypes.has(type)) modes.push(hiddenTypes.get(type) === true);
  }

  if (!modes.length) return 'visible';
  if (modes.some(reveal => !reveal)) return 'hidden';
  // No snapshot means nobody to measure against — a GM listing, an export, a caller that
  // has not been given one. Withhold rather than leak.
  if (!snapshot) return 'hidden';
  return prerequisiteState(feat, snapshot).met ? 'revealed' : 'hidden';
}
