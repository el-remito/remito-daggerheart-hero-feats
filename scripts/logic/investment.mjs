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
 * @param {number} [args.tiers]
 * @returns {Array<object>}
 */
export function buildInvestmentSummary({
  feats = [],
  counts = {},
  categoryLabels = {},
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
      tiers: tiersFor(list, category, counts, tiers)
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
function tiersFor(feats, category, counts, limit) {
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
      required,
      have,
      more: required - have,
      unlocks,
      // Finished, because the module does no maths in templates.
      share: required ? Math.round((have / required) * 100) : 100
    });
    if (rows.length >= limit) break;
  }
  return rows;
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
