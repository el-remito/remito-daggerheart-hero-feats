/**
 * automation.mjs
 * Rule Automation — world-level rules that DERIVE requirements rather than storing
 * them. Pure: no Foundry APIs, no documents, no game.*, no localization. Every
 * function takes plain values, so node can exercise the whole rule directly.
 *
 * Only one rule exists so far, "Default Investment by Level": while it is on, a Feat
 * carrying a real Category inherits an Investment-in-Category requirement in its OWN
 * Category, sized by its Level. Nothing is written into any Feat — switching the rule
 * off restores the catalog exactly, which is why there is no migration here.
 */

import { GENERAL_CATEGORY_ID, DEFAULT_INVESTMENT_BY_LEVEL } from '../constants.mjs';

/* ── The stored rule ───────────────────────────────────────────────────────── */

/**
 * Fills in anything missing on the stored automation setting. This is the defensive
 * reader — the same job normalizeFeat does for a registry entry — so a partial or
 * hand-edited world setting can never throw on a read path.
 *
 * @param {object|null|undefined} stored
 * @returns {{investmentByLevel: {enabled: boolean, table: Object<string, number>}}}
 */
export function normalizeAutomation(stored) {
  const rule = stored?.investmentByLevel ?? {};
  const storedTable = rule.table ?? {};
  const table = {};
  // Rebuilt from the default keys rather than copied, so a stored table that lost a
  // level (or gained a junk one) still produces exactly the ten the editor renders.
  for (const level of Object.keys(DEFAULT_INVESTMENT_BY_LEVEL)) {
    const value = storedTable[level];
    table[level] = value === undefined ? DEFAULT_INVESTMENT_BY_LEVEL[level] : clampCount(value);
  }
  return { investmentByLevel: { enabled: rule.enabled === true, table } };
}

/** A Feat count is a non-negative integer; anything unreadable is 0. */
function clampCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * The investment a Feat of this Level demands.
 *
 * The registry's Level input is `type="number" min="1"` with no maximum, so a Feat can
 * legitimately sit above the table's ceiling. Such a Feat clamps to the top entry
 * rather than falling through to no requirement at all — the same widening spirit as
 * statistics.mjs's level columns.
 *
 * @param {number} level
 * @param {Object<string, number>} table
 * @returns {number}
 */
export function investmentForLevel(level, table) {
  const levels = Object.keys(table ?? {})
    .map(Number)
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!levels.length) return 0;

  const wanted = Math.floor(Number(level) || 1);
  const floor = levels[0];
  const ceiling = levels[levels.length - 1];
  const key = String(Math.min(Math.max(wanted, floor), ceiling));
  return clampCount(table[key]);
}

/* ── Deriving a Feat's investment row ──────────────────────────────────────── */

/**
 * The rows a GM actually authored, using the SAME filter checkRequirements applies
 * (requirements.mjs) — a row with no Category or a count of 0 produces no visible
 * requirement there, so it must not silently opt a Feat out of the rule here either.
 */
function authoredRows(feat) {
  const rows = feat?.requirements?.categoryInvestment;
  return Array.isArray(rows) ? rows.filter(r => r?.category && Number(r.count)) : [];
}

/**
 * True when a Feat's hand-authored investment is exactly what the rule would derive —
 * a GM who applied this curve by hand before switching the rule on.
 *
 * Read as a plain opt-out, such a Feat would be excluded from the very rule it was
 * already following, so it is adopted instead. Adoption is only durable if the now
 * redundant row is then removed (see stripRedundantInvestment): matched on value
 * alone, retuning the curve would break the match and the Feat would quietly desert
 * the rule, frozen at its old number.
 *
 * @param {object} feat  normalized feat record
 * @param {object} rule  { enabled, table }
 * @returns {boolean}
 */
export function isRedundantInvestment(feat, rule) {
  if (!rule?.enabled) return false;
  if (!eligibleForRule(feat)) return false;

  const count = investmentForLevel(feat.level, rule.table);
  if (!count) return false;

  const rows = authoredRows(feat);
  return rows.length === 1 && rows[0].category === feat.category && Number(rows[0].count) === count;
}

/**
 * A copy of the Feat with the redundant row removed, or the Feat untouched. Never
 * mutates: the caller's object is the GM app's working copy.
 *
 * @param {object} feat
 * @param {object} rule
 * @returns {object}
 */
export function stripRedundantInvestment(feat, rule) {
  if (!isRedundantInvestment(feat, rule)) return feat;
  const kept = (feat.requirements?.categoryInvestment ?? []).filter(
    r => !(r?.category === feat.category && Number(r.count) === investmentForLevel(feat.level, rule.table))
  );
  return { ...feat, requirements: { ...feat.requirements, categoryInvestment: kept } };
}

/** Category-level eligibility: curated, and not the fixed General Category. */
function eligibleForRule(feat) {
  if (!feat || feat.autoExempt === true) return false;
  return ruleAppliesToCategory(feat.category);
}

/**
 * Whether the rule derives anything for a Category at all, ignoring any one Feat.
 *
 * Exported because two callers need the carve-out and they hold different things:
 * eligibleForRule has a feat, while My Investments has only a Category id and asks
 * whether the curve governs it before offering a look ahead. Stating it once here
 * is what stops the two drifting the next time General is revisited.
 *
 * null === uncurated, and General is the GM's stated carve-out: it is the "no filing
 * system yet" Category, so demanding investment in it would gate the entry point.
 *
 * @param {string|null|undefined} category
 * @returns {boolean}
 */
export function ruleAppliesToCategory(category) {
  return Boolean(category) && category !== GENERAL_CATEGORY_ID;
}

/**
 * The row this rule derives for a Feat, or null when it does not apply.
 *
 * The count is computed FIRST because the authored-row test needs it to recognise a
 * redundant row.
 *
 * @param {object} feat  normalized feat record ({ level, category, autoExempt, requirements })
 * @param {object} rule  { enabled, table }
 * @returns {{category: string, count: number, join: null}|null}
 */
export function autoInvestmentRow(feat, rule) {
  if (!rule?.enabled) return null;
  if (!eligibleForRule(feat)) return null;

  const count = investmentForLevel(feat.level, rule.table);
  if (!count) return null;

  const rows = authoredRows(feat);
  if (rows.length) {
    // Anything the GM authored wins — unless it IS the rule, in which case the Feat
    // opted in by hand and the rule keeps ownership of the number.
    const adopted =
      rows.length === 1 && rows[0].category === feat.category && Number(rows[0].count) === count;
    if (!adopted) return null;
  }

  return { category: feat.category, count, join: null };
}

/**
 * A copy of the Feat with the derived row applied, or the Feat unchanged.
 *
 * The derived row REPLACES the investment chain rather than joining it, and that is
 * safe precisely because the rule and authored rows are mutually exclusive: the row is
 * always the only one. evaluateInvestment is left-to-right with AND binding tighter
 * than OR, so appending to an `A or B` chain would have silently changed its meaning.
 *
 * @param {object} feat
 * @param {object} rule
 * @returns {object}
 */
export function applyAutoInvestment(feat, rule) {
  const row = autoInvestmentRow(feat, rule);
  if (!row) return feat;
  return {
    ...feat,
    requirements: { ...(feat.requirements ?? {}), categoryInvestment: [row] }
  };
}
