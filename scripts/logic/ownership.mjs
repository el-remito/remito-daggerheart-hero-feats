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

import { CHANGE_NOTICE_EPOCH, DEFAULT_REFUNDS } from '../constants.mjs';
import { checkRequirements, sameName } from './requirements.mjs';

/**
 * Milliseconds in a day. The refund window is stated in whole days — a table meets once
 * a week, so a buyer's-remorse window has to outlast the session it was bought in.
 */
const DAY_MS = 86_400_000;

/** Milliseconds in an hour, for saying how long is left once less than a day is. */
export const HOUR_MS = 3_600_000;

/* ── Changes to owned Feats ──────────────────────────────────────────────────── */

/**
 * Whether an owned Feat has changed since its owner last answered for it.
 *
 * The baseline is the LATER of the acquisition and the last Keep: a change made before
 * the character bought the Feat never counts, because they bought the current version,
 * and a Keep answers for every change up to that moment. A Feat changed again after a
 * Keep is pending again, with no state of its own to reset.
 *
 * CHANGE_NOTICE_EPOCH is a floor under both: nothing changed before the feature shipped
 * is ever reported, even on a record the upgrade migration has not reached yet.
 *
 * @param {{at?: number, seenAt?: number}|null} entry  the acquisition record
 * @param {{updatedAt?: number}|null} feat             the normalized registry entry
 * @returns {boolean}
 */
export function isPendingChange(entry, feat) {
  if (!entry || !feat) return false;
  const changed = Number(feat.updatedAt) || 0;
  if (changed <= 0) return false;
  return changed > Math.max(Number(entry.at) || 0, Number(entry.seenAt) || 0, CHANGE_NOTICE_EPOCH);
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

/* ── The stored refund rule ──────────────────────────────────────────────────── */

/**
 * Fills in anything missing on the stored refunds setting — the same defensive-reader
 * contract normalizeRecency and normalizeAutomation keep, rebuilt from the defaults so a
 * partial or hand-edited value can never reach a refund decision.
 *
 * @param {object|null|undefined} stored
 * @returns {{recent: {enabled: boolean, days: number}, changed: {enabled: boolean}}}
 */
export function normalizeRefunds(stored) {
  const recent = stored?.recent ?? {};
  const changed = stored?.changed ?? {};
  const days = Math.floor(Number(recent.days));
  return {
    recent: {
      enabled: recent.enabled === true,
      days: Number.isFinite(days) && days >= 0 ? days : DEFAULT_REFUNDS.recent.days
    },
    changed: { enabled: changed.enabled === true }
  };
}

/* ── May this be handed back? ────────────────────────────────────────────────── */

/**
 * Milliseconds left in an acquisition's buyer's-remorse window; 0 when it is shut or the
 * route is switched off. A days value of 0 shuts it outright, like every other 0 in
 * the module's windows.
 *
 * @param {object} entry   acquisition record
 * @param {object} rules   normalized refunds rule
 * @param {number} now     epoch ms
 * @returns {number}
 */
export function recentWindowLeft(entry, rules, now) {
  if (!entry || !rules?.recent?.enabled || !(rules.recent.days > 0)) return 0;
  const closes = (Number(entry.at) || 0) + rules.recent.days * DAY_MS;
  return Math.max(0, closes - now);
}

/**
 * Which route, if any, lets the OWNER hand this Feat back right now.
 *
 * `updated` wins where both apply: the GM changing a Feat under its owner is the
 * stronger claim, and it is the reason the ledger records. A GM grant is never
 * refundable by a player, whatever either route says.
 *
 * @param {object} entry   acquisition record
 * @param {object} feat    normalized registry entry
 * @param {object} rules   normalized refunds rule
 * @param {number} now     epoch ms
 * @returns {'updated'|'recent'|null}
 */
export function refundRoute(entry, feat, rules, now) {
  if (!entry || entry.free === true) return null;
  if (rules?.changed?.enabled && isPendingChange(entry, feat)) return 'updated';
  if (recentWindowLeft(entry, rules, now) > 0) return 'recent';
  return null;
}

/* ── The cascade ─────────────────────────────────────────────────────────────── */

/**
 * The snapshot a character would have with `removed` handed back: their acquisitions,
 * the Feature items those created, and the Category counts all lose them.
 */
function withoutFeats(snapshot, removed, { nameOf, categoryOf }) {
  const names = [...(snapshot.featureNames ?? [])];
  for (const uuid of removed) {
    const at = names.indexOf(String(nameOf(uuid) ?? '').toLowerCase());
    if (at >= 0) names.splice(at, 1); // ONE copy: a same-named class Feature stays
  }
  const counts = { ...(snapshot.categoryCounts ?? {}) };
  for (const uuid of removed) {
    const category = categoryOf(uuid);
    if (category && counts[category]) counts[category] -= 1;
  }
  return {
    ...snapshot,
    featureNames: names,
    acquiredUuids: (snapshot.acquiredUuids ?? []).filter(u => !removed.has(u)),
    categoryCounts: counts
  };
}

/** The Feat/Feature prerequisite clause of a feat, evaluated against one snapshot. */
function featureClauseMet(feat, snapshot) {
  const clause = checkRequirements(feat, snapshot).find(c => c.kind === 'feature');
  return clause ? clause.met : true;
}

/** Whether every requirement a feat states is met — narrative clauses always are. */
function qualifies(feat, snapshot) {
  return checkRequirements(feat, snapshot).every(c => c.met);
}

/**
 * Everything a refund of `uuid` would do, decided before anything is written.
 *
 * DEPENDENTS — a Feat D is handed back with R only when BOTH hold:
 *   1. D's Feat/Feature prerequisite list names R, by uuid or by R's exact name, and
 *   2. that clause was met before the refund and is unmet after it.
 * Rule 2 is what keeps the cascade precise: an any-of list the character still meets
 * through another entry, or a name a same-named class Feature still answers, stays met
 * and so is never cascaded. The cascade is transitive along those links only. It never
 * follows an Investment chain or a `hasFeature:` expression atom — one refund must not
 * be able to unwind a whole Investment ladder — and those land in `warnings` instead.
 *
 * BLOCKING — if R or any dependent cannot itself be refunded by the owner (a GM grant,
 * or a Feat with no open route), the WHOLE refund is blocked and `blockedBy` names them.
 *
 * @param {object} args
 * @param {string} args.uuid                          the Feat being handed back
 * @param {Array<object>} args.acquired               the character's acquisition records
 * @param {(uuid: string) => object|null} args.featOf normalized registry entry by uuid
 * @param {(uuid: string) => string} args.nameOf      the embedded Feature's name
 * @param {object} args.snapshot                      the character's snapshot as it is now
 * @param {object} args.rules                         normalized refunds rule
 * @param {number} args.now                           epoch ms
 * @returns {{
 *   ok: boolean,
 *   refunds: Array<{uuid: string, reason: 'updated'|'recent', cascadeOf: string|null}>,
 *   blockedBy: string[],
 *   warnings: string[]
 * }}
 */
export function planRefund({ uuid, acquired, featOf, nameOf, snapshot, rules, now }) {
  const owned = new Map((acquired ?? []).map(e => [e.uuid, e]));
  if (!owned.has(uuid)) return { ok: false, refunds: [], blockedBy: [], warnings: [] };
  const helpers = { nameOf, categoryOf: u => featOf(u)?.category ?? null };

  const removed = new Set([uuid]);
  const cascadeOf = new Map([[uuid, null]]);

  // Grow to a fixpoint: handing back a dependent can break a Feat that named IT.
  for (let grew = true; grew; ) {
    grew = false;
    const after = withoutFeats(snapshot, removed, helpers);
    for (const other of owned.keys()) {
      if (removed.has(other)) continue;
      const feat = featOf(other);
      const refs = feat?.requirements?.features ?? [];
      const parent = [...removed].find(r => refs.some(ref => ref === r || sameName(ref, nameOf(r))));
      if (!parent) continue;
      if (!featureClauseMet(feat, snapshot) || featureClauseMet(feat, after)) continue;
      removed.add(other);
      cascadeOf.set(other, parent);
      grew = true;
    }
  }

  const refunds = [];
  const blockedBy = [];
  for (const u of removed) {
    const reason = refundRoute(owned.get(u), featOf(u), rules, now);
    if (reason) refunds.push({ uuid: u, reason, cascadeOf: cascadeOf.get(u) });
    else blockedBy.push(u);
  }

  // Feats that stay owned but stop qualifying: everything the cascade deliberately does
  // not follow. Measured as "qualified before, not after", so a Feat that was already
  // failing (the GM raised its Level, say) is not blamed on this refund.
  const after = withoutFeats(snapshot, removed, helpers);
  const warnings = [];
  for (const other of owned.keys()) {
    if (removed.has(other)) continue;
    const feat = featOf(other);
    if (feat && qualifies(feat, snapshot) && !qualifies(feat, after)) warnings.push(other);
  }

  return { ok: blockedBy.length === 0, refunds, blockedBy, warnings };
}
