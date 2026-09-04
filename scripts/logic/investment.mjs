/**
 * investment.mjs
 * The player's side of Investment in Category, turned around.
 *
 * Every other reader of the investment chain asks "does this character meet this Feat's
 * requirement". This one asks the question a player actually has: "I have five Alchemy
 * Feats — what does the sixth get me, and what am I working toward". Same data, read
 * from the other end.
 *
 * Pure: plain records in, plain numbers out. No game.*, no documents, no localization —
 * labels arrive already localized from the app layer, exactly as the requirement
 * descriptors do.
 */

import { evaluateInvestment } from './requirements.mjs';
// Sibling imports inside logic/, both pure. investmentForLevel is read for ONE thing
// only — the trailing forward tier below — and ruleAppliesToCategory is taken rather
// than restated so the General carve-out has a single statement.
import { investmentForLevel, ruleAppliesToCategory } from './automation.mjs';

/**
 * How many tiers ahead a Category shows. Two — the next one and the one after — is
 * enough to answer "what am I working toward" without turning a summary into a ladder.
 */
export const TIERS_SHOWN = 2;

/**
 * Per-Category investment standing, for the Categories the character has invested in.
 *
 * Thresholds are read from the Feats themselves rather than from the Automation curve.
 * With the rule on the two are the same list — the curve is what put those numbers on
 * the Feats, and `listFeats` has already applied it — but reading the Feats also works
 * with the rule off, and can never promise a tier no Feat actually gates.
 *
 * @param {object} args
 * @param {Array<object>} args.feats   the player's feat views: { uuid, category, owned, requirements }
 * @param {Object<string, number>} args.counts        acquired Feats per Category (snapshot.categoryCounts)
 * @param {Object<string, string>} args.categoryLabels
 * @param {object|null} [args.rule]  the investmentByLevel rule, for the forward tier only
 * @param {number} [args.tiers]
 * @returns {Array<object>}
 */
export function buildInvestmentSummary({
  feats = [],
  counts = {},
  categoryLabels = {},
  rule = null,
  tiers = TIERS_SHOWN
} = {}) {
  const list = Array.isArray(feats) ? feats.filter(Boolean) : [];

  // Only Categories the character has actually put Feats into. A Category at zero is
  // the catalog's job to advertise, not this tab's — this one is about standing.
  const invested = Object.entries(counts ?? {})
    .filter(([, n]) => Number(n) > 0)
    .map(([category, n]) => ({ category, invested: Number(n) }));

  return invested
    .map(({ category, invested }) => ({
      category,
      label: categoryLabels[category] ?? category,
      invested,
      owned: list.filter(f => f.owned && f.category === category).length,
      tiers: tiersFor(list, category, counts, tiers, rule)
    }))
    .sort((a, b) => b.invested - a.invested || String(a.label).localeCompare(String(b.label)));
}

/**
 * The next unmet thresholds in one Category, and what each of them unblocks.
 *
 * A threshold earns a row only if reaching it actually changes something. Chains are
 * evaluated through `evaluateInvestment` with the Category's count raised to the
 * candidate and every other Category held where it is, so an AND chain that also wants
 * a second Category does not appear as a promise this Category alone can keep, and an
 * OR chain already satisfied by its other branch does not appear at all.
 */
function tiersFor(feats, category, counts, limit, rule) {
  const have = Number(counts?.[category]) || 0;

  // Candidates: every count this Category is asked for, above where the player stands.
  const candidates = [
    ...new Set(
      feats
        .flatMap(f => chainOf(f))
        .filter(r => r.category === category)
        .map(r => Number(r.count))
        .filter(n => n > have)
    )
  ].sort((a, b) => a - b);

  // Feats still blocked BY INVESTMENT. A Feat already owned, or whose chain is met
  // today, can never be what a further tier buys.
  const blocked = feats.filter(f => {
    if (f.owned) return false;
    const chain = chainOf(f);
    return chain.length && !evaluateInvestment(chain, { categoryCounts: counts });
  });

  const rows = [];
  for (const required of candidates) {
    const raised = { ...counts, [category]: required };
    const unlocks = blocked.filter(f =>
      evaluateInvestment(chainOf(f), { categoryCounts: raised })
    ).length;
    if (!unlocks) continue; // a threshold that buys nothing is noise, not a tier
    rows.push({
      ...tier(required, have),
      unlocks,
      // Which Levels this mark opens, read off the Feats it unblocks rather than off
      // the curve — so the label is right with the rule off, and can never name a
      // Level no Feat actually occupies.
      levels: levelsOf(blocked.filter(f =>
        evaluateInvestment(chainOf(f), { categoryCounts: raised })
      )),
      forward: false
    });
    if (rows.length >= limit) break;
  }

  return rows.concat(forwardTiers(category, counts, limit - rows.length, rule, rows));
}

/**
 * The look ahead past everything any Feat currently asks for.
 *
 * This is the ONE place the tab reads the Automation curve, and it is a deliberate,
 * marked exception to "tiers come from the Feats". Without it a Category whose Feats
 * stop below the next band shows no THEN at all, which reads as "you have unlocked
 * everything" when it means "nothing is filed up there yet" — the two are indis-
 * tinguishable, and the second is far more common.
 *
 * It exists only while the rule is on, because with the rule off the curve governs
 * nothing and the number would be a threshold the catalog itself contradicts. It
 * carries `unlocks: 0` by construction, and `forward: true` so the row can say so.
 */
function forwardTiers(category, counts, room, rule, real) {
  if (room <= 0 || !rule?.enabled || !ruleAppliesToCategory(category)) return [];

  const have = Number(counts?.[category]) || 0;
  // Past the deepest mark already shown, so a forward tier can never sit below a real
  // one or repeat it.
  const floor = Math.max(have, ...real.map(r => r.required));

  return curveTiers(rule.table)
    .filter(({ required }) => required > floor)
    .slice(0, room)
    .map(({ required, levels }) => ({ ...tier(required, have), unlocks: 0, levels, forward: true }));
}

/**
 * The curve as marks rather than Levels: each distinct requirement, ascending, with the
 * Levels that ask for it. Built by walking the table's own keys through
 * investmentForLevel, which clamps — so nothing beyond the curve's top Level is invented.
 */
function curveTiers(table) {
  const levels = Object.keys(table ?? {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const byCount = new Map();
  for (const level of levels) {
    const required = investmentForLevel(level, table);
    if (!required) continue; // Level 1 asks for nothing; it is not a mark
    if (!byCount.has(required)) byCount.set(required, []);
    byCount.get(required).push(level);
  }

  return [...byCount.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([required, levels]) => ({ required, levels }));
}

/** The arithmetic every tier shares, finished here because templates do no maths. */
function tier(required, have) {
  return {
    required,
    have,
    more: required - have,
    share: required ? Math.round((have / required) * 100) : 100
  };
}

/** The distinct Levels of a set of feats, ascending. */
function levelsOf(feats) {
  return [...new Set(feats.map(f => Number(f?.level) || 0).filter(n => n > 0))]
    .sort((a, b) => a - b);
}

/**
 * A Feat's investment chain, filtered by the SAME test checkRequirements applies —
 * a row with no Category or a count of 0 produces no requirement anywhere else, so it
 * must not produce a tier here.
 */
function chainOf(feat) {
  const rows = feat?.requirements?.categoryInvestment;
  return (Array.isArray(rows) ? rows : []).filter(r => r?.category && Number(r.count));
}
