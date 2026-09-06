/**
 * recency.mjs
 * How long a Feat wears its NEW or UPDATED chip. PURE — plain records and a plain rule
 * in, a Set of uuids out, no `game.*` and no documents, so node can exercise it directly.
 *
 * A separate module rather than more functions on filters.mjs, for the same reason
 * logic/investment.mjs is one: it answers a different question over the same data, and
 * it owns a STORED rule plus the defensive reader for it — which is the shape
 * logic/automation.mjs already has.
 *
 * Recency is a property of the SET, not of a row. Under a fixed count the tenth-newest
 * Feat stops being new when an eleventh is published, with nothing about it changing;
 * under a percentage the whole window widens when the catalog grows. So membership is
 * decided once per render and stamped onto the views as `isNew` / `isUpdated`, which is
 * what lets matchesFilters stay a per-row predicate and lets both windows filter from
 * data attributes with no context object.
 */

import { DEFAULT_RECENCY, RECENCY_MODES, RECENCY_AMOUNT_MODES } from '../constants.mjs';

/** Milliseconds in a day. The window is stated in whole days because a GM thinks in them. */
const DAY_MS = 86_400_000;

/* ── The stored rule ───────────────────────────────────────────────────────── */

/**
 * Fills in anything missing on the stored recency setting. The defensive reader — the
 * same job normalizeAutomation does for the rule table and normalizeFeat does for a
 * registry entry — so a partial or hand-edited world setting can never throw on a read
 * path, and a junk mode can never reach the window.
 *
 * Rebuilt from the defaults rather than copied, so a stored object that lost a chip or
 * gained a stray key still produces exactly the two rules the editor renders.
 *
 * @param {object|null|undefined} stored
 * @returns {{new: object, updated: object}}
 */
export function normalizeRecency(stored) {
  const out = {};
  for (const chip of Object.keys(DEFAULT_RECENCY)) {
    out[chip] = normalizeRule(stored?.[chip], DEFAULT_RECENCY[chip]);
  }
  return out;
}

/** One chip's rule. Every field is kept even when the mode ignores it — see below. */
function normalizeRule(stored, fallback) {
  const rule = stored ?? {};
  return {
    mode: RECENCY_MODES.includes(rule.mode) ? rule.mode : fallback.mode,
    amountMode: RECENCY_AMOUNT_MODES.includes(rule.amountMode)
      ? rule.amountMode
      : fallback.amountMode,
    // The fields a mode does not read are still normalized and still carried. A GM who
    // switches to `time` to look at it and switches back must find their count where
    // they left it, not reset to the default.
    count: whole(rule.count, fallback.count),
    percent: Math.min(100, whole(rule.percent, fallback.percent)),
    days: whole(rule.days, fallback.days)
  };
}

/** A non-negative whole number; anything unreadable falls back rather than becoming 0. */
function whole(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

/* ── Resolving a rule against the catalog ──────────────────────────────────── */

/**
 * The rule with its percentage already applied — the mode plus the numbers that actually
 * govern. THE single place a percentage becomes a count, because two readers need the
 * answer: the window below, and the tooltip that tells a player what the window is. A
 * chip saying "one of the 20 most recent" while 19 are drawn would be worse than saying
 * nothing.
 *
 * `Math.ceil`, so any non-zero percentage yields at least one slot in a non-empty
 * catalog: `floor` would mean a world of eight Feats at 10% never shows the chip at all,
 * which reads as the feature being broken rather than as arithmetic.
 *
 * @param {object} rule   one normalized chip rule
 * @param {number} total  the published Feat count — the percentage's denominator
 * @returns {{mode: string, limit: number, days: number, percent: number}}
 */
export function resolveRecency(rule, total = 0) {
  const safe = normalizeRule(rule, DEFAULT_RECENCY.new);
  const size = Math.max(0, Math.floor(Number(total) || 0));
  const limit =
    safe.amountMode === 'percent' ? Math.ceil((size * safe.percent) / 100) : safe.count;
  return { mode: safe.mode, limit, days: safe.days, percent: safe.percent };
}

/* ── The window ────────────────────────────────────────────────────────────── */

/**
 * Which Feats wear the chip.
 *
 * A Feat with no stamp is never a member, in any mode — that test comes first and is why
 * an unpublished Feat (`curatedAt === 0`) cannot occupy a slot.
 *
 * `combined` applies BOTH narrowings, which is exactly "whichever expires first wins":
 * falling out of either window takes the chip.
 *
 * Zero turns the chip off in every field. For an amount that falls out of the arithmetic
 * as an empty slice; for `days` it is stated outright, because a cutoff of `now` would
 * still admit a Feat published in this very millisecond and the editor promises 0 hides
 * the chip entirely. A promise to the GM beats one less branch.
 *
 * @param {Array<object>} views   records carrying `uuid` and the timestamp field
 * @param {string} field          'curatedAt' or 'updatedAt'
 * @param {object} rule           one normalized chip rule
 * @param {object} [options]
 * @param {number} [options.total]  the percentage's denominator; defaults to the list size
 * @param {number} [options.now]    injected so a test can pin the clock
 * @returns {Set<string>} uuids
 */
export function recencyWindow(views, field, rule, { total, now = Date.now() } = {}) {
  const list = views ?? [];
  const { mode, limit, days } = resolveRecency(rule, total ?? list.length);

  let kept = list
    .filter(v => Number(v?.[field]) > 0)
    .sort((a, b) => Number(b[field]) - Number(a[field]));

  if (mode !== 'time') kept = kept.slice(0, Math.max(0, limit));
  if (mode !== 'amount') {
    if (days <= 0) return new Set();
    // Inclusive: a Feat stamped exactly `days` ago is still inside the window, which is
    // the reading a GM setting "14 days" expects on the fourteenth day.
    const cutoff = now - days * DAY_MS;
    kept = kept.filter(v => Number(v[field]) >= cutoff);
  }

  return new Set(kept.map(v => v.uuid));
}

/**
 * The most recently published Feats. `curatedAt` is written by Curation's File, so
 * "newly made available to players" is literally what this measures.
 *
 * @param {Array<object>} views  records carrying `uuid` and `curatedAt`
 * @param {object} rule
 * @param {object} [options]  see recencyWindow
 * @returns {Set<string>} uuids
 */
export function newestCurated(views, rule, options) {
  return recencyWindow(views, 'curatedAt', rule, options);
}

/**
 * The most recently CHANGED Feats — its own window over its own timestamp and its own
 * rule, so a busy week of publishing cannot crowd out the changed Feats, and a GM can
 * give the two chips different lifetimes.
 *
 * A Feat only becomes eligible for an `updatedAt` stamp once its curation has been
 * committed; see _syncField in the registry app. Authoring a Feat necessarily edits the
 * same fields that later count as changes, so without that boundary every freshly
 * curated Feat would report itself as updated.
 *
 * @param {Array<object>} views  records carrying `uuid` and `updatedAt`
 * @param {object} rule
 * @param {object} [options]  see recencyWindow
 * @returns {Set<string>} uuids
 */
export function newestUpdated(views, rule, options) {
  return recencyWindow(views, 'updatedAt', rule, options);
}
