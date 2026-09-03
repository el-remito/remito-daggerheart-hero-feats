/**
 * requirements.mjs
 * Pure requirement evaluation. No Foundry APIs, no documents, no game.* — every
 * function takes an "actor snapshot" (see data/snapshot.mjs) of plain values.
 *
 * Checks return DESCRIPTORS ({ kind, key, data, met }) rather than localized strings,
 * so this file stays localization-free and the app layer decides how to render them.
 *
 * The free-text `expression` escape hatch is ported from the sibling
 * remito-heroic-skill-tree/scripts/utils/formula.mjs, with two additions
 * (categoryAtLeast:, resourceAtLeast:) and made synchronous — the snapshot already
 * holds everything an atom needs, so nothing has to be awaited.
 */

import { TRAITS, RESOURCE_REQS } from '../constants.mjs';

/* ── Structured requirements ───────────────────────────────────────────────── */

/**
 * An empty requirement block. Every stored feat is normalized to this shape, so
 * downstream code never has to null-check a branch.
 * @returns {object}
 */
export function blankRequirements() {
  return {
    resources: { hitPoints: null, stress: null, hope: null, evasion: null },
    traits: Object.fromEntries(TRAITS.map(t => [t, null])),
    features: [],
    classes: [],
    subclasses: [],
    categoryInvestment: [],
    expression: ''
  };
}

/**
 * Fills in anything missing on a stored requirement object without dropping extras.
 * @param {object|null|undefined} reqs
 * @returns {object}
 */
export function normalizeRequirements(reqs) {
  const blank = blankRequirements();
  if (!reqs || typeof reqs !== 'object') return blank;
  return {
    resources: { ...blank.resources, ...(reqs.resources ?? {}) },
    traits: { ...blank.traits, ...(reqs.traits ?? {}) },
    features: Array.isArray(reqs.features) ? [...reqs.features] : [],
    classes: Array.isArray(reqs.classes) ? [...reqs.classes] : [],
    subclasses: Array.isArray(reqs.subclasses) ? [...reqs.subclasses] : [],
    // `join` is the connector to the PREVIOUS row, so the first row never carries one.
    // Rows are evaluated left to right with AND binding tighter than OR, exactly like
    // the expression grammar below — one precedence rule for the whole module.
    categoryInvestment: Array.isArray(reqs.categoryInvestment)
      ? reqs.categoryInvestment.map((r, i) => ({
          category: r.category,
          count: Number(r.count) || 0,
          join: i === 0 ? null : r.join === 'or' ? 'or' : 'and'
        }))
      : [],
    expression: typeof reqs.expression === 'string' ? reqs.expression : ''
  };
}

/** Case- and whitespace-insensitive comparison, used for every name match. */
function sameName(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** True when a requirement field was left blank by the GM. */
function unset(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Evaluates every stated requirement on a feat and returns one descriptor per clause,
 * in display order. Clauses the GM left blank produce no descriptor.
 *
 * All clauses are AND-ed. Within `classes` / `subclasses` / `features` the listed
 * values are OR-ed (any-of) — which is what "requiring a given Class or Subclass"
 * means once a GM has listed more than one.
 *
 * @param {object} feat      normalized feat record ({ uuid, level, requirements })
 * @param {object} snapshot  actor snapshot
 * @returns {Array<{kind: string, key: string, data: object, met: boolean}>}
 */
export function checkRequirements(feat, snapshot) {
  const out = [];
  const reqs = normalizeRequirements(feat?.requirements);

  // Level: the feat's own Level is itself a hard requirement (whitepaper, Feats §2).
  const level = Number(feat?.level) || 1;
  out.push({
    kind: 'level',
    key: 'RDHF.requirement.level',
    data: { value: level },
    met: (snapshot.level ?? 0) >= level
  });

  // Resources — capacity, never the live value. See RESOURCE_REQS for why.
  for (const key of Object.keys(RESOURCE_REQS)) {
    const need = reqs.resources[key];
    if (unset(need)) continue;
    out.push({
      kind: 'resource',
      key: 'RDHF.requirement.resource.' + key,
      data: { value: Number(need) },
      met: (snapshot.resources?.[key] ?? 0) >= Number(need)
    });
  }

  // Traits
  for (const trait of TRAITS) {
    const need = reqs.traits[trait];
    if (unset(need)) continue;
    out.push({
      kind: 'trait',
      key: 'RDHF.requirement.trait',
      data: { traitKey: 'RDHF.trait.' + trait, value: Number(need) },
      met: (snapshot.traits?.[trait] ?? 0) >= Number(need)
    });
  }

  // Other Feats or Features (any-of). An entry may be a feat UUID or a plain Feature
  // name, so both are tried.
  if (reqs.features.length) {
    const met = reqs.features.some(
      ref =>
        snapshot.acquiredUuids?.includes(ref) ||
        snapshot.featureNames?.some(n => sameName(n, ref))
    );
    out.push({
      kind: 'feature',
      key: 'RDHF.requirement.feature',
      // Items, not a sentence: these are OR-ed, and the connector word is a language
      // the app layer owns. A comma-joined string read as "all of these" and was wrong.
      data: { items: reqs.features.map(r => snapshot.featLabels?.[r] ?? r) },
      met
    });
  }

  // Class / Subclass (any-of, multiclass counts)
  if (reqs.classes.length) {
    out.push({
      kind: 'class',
      key: 'RDHF.requirement.class',
      data: { items: [...reqs.classes] },
      met: reqs.classes.some(
        c => sameName(c, snapshot.className) || sameName(c, snapshot.multiclassName)
      )
    });
  }
  if (reqs.subclasses.length) {
    out.push({
      kind: 'subclass',
      key: 'RDHF.requirement.subclass',
      data: { items: [...reqs.subclasses] },
      met: reqs.subclasses.some(
        s =>
          sameName(s, snapshot.subclassName) || sameName(s, snapshot.multiclassSubclassName)
      )
    });
  }

  // Investment in Category — ONE descriptor for the whole chain, not one per row.
  // With OR in play a single unmet row no longer means the requirement failed, so a
  // per-row chip would report a failure the evaluation does not agree with.
  const investment = reqs.categoryInvestment.filter(r => r.category && r.count);
  if (investment.length) {
    out.push({
      kind: 'categoryInvestment',
      key: 'RDHF.requirement.categoryInvestment',
      // Parts, not a sentence: the connector words are localized by the app layer.
      data: {
        parts: investment.map((r, i) => ({
          category: snapshot.categoryLabels?.[r.category] ?? r.category,
          count: r.count,
          join: i === 0 ? null : r.join ?? 'and'
        }))
      },
      met: evaluateInvestment(investment, snapshot)
    });
  }

  // Free-text expression escape hatch. `branches` is the parse; `value` is the GM's
  // raw text, kept as the fallback for a caller that has nothing better to show.
  if (reqs.expression?.trim()) {
    out.push({
      kind: 'expression',
      key: 'RDHF.requirement.expression',
      data: {
        value: reqs.expression.trim(),
        branches: parseExpression(reqs.expression, snapshot)
      },
      met: evaluateExpression(reqs.expression, snapshot)
    });
  }

  return out;
}

/**
 * Evaluates the Investment in Category chain: OR of AND groups, left to right, with
 * AND binding tighter. `andResult` accumulates the current group; every `or` closes
 * that group into `orResult` and starts a new one.
 *
 * @param {Array<{category: string, count: number, join: string|null}>} rules
 * @param {object} snapshot
 * @returns {boolean}
 */
export function evaluateInvestment(rules, snapshot) {
  if (!rules?.length) return true;
  let orResult = false;
  let andResult = true;

  rules.forEach((rule, index) => {
    const met = (snapshot.categoryCounts?.[rule.category] ?? 0) >= Number(rule.count);
    if (index === 0) andResult = met;
    else if (rule.join === 'or') {
      orResult = orResult || andResult;
      andResult = met;
    } else andResult = andResult && met;
  });

  return orResult || andResult;
}

/**
 * Whole-feat eligibility, including the point cost. Cost is a flat 1 Feat Point.
 *
 * @param {object} feat
 * @param {object} snapshot
 * @param {number} remainingPoints
 * @returns {{ok: boolean, checks: Array, failures: Array, hasPoints: boolean, owned: boolean}}
 */
export function isEligible(feat, snapshot, remainingPoints) {
  const checks = checkRequirements(feat, snapshot);
  const failures = checks.filter(c => !c.met);
  const owned = Boolean(snapshot.acquiredUuids?.includes(feat.uuid));
  const hasPoints = Number(remainingPoints) >= 1;
  return { ok: !owned && hasPoints && failures.length === 0, checks, failures, hasPoints, owned };
}

/* ── Expression grammar (escape hatch) ─────────────────────────────────────── */

/**
 * Splits one atom into its parts, or null when it carries no `prefix:` at all.
 *
 * Shared by evaluation and description on purpose: the two must never disagree about
 * where an atom's value starts, or a player would be shown a clause that is not the
 * one being tested.
 *
 * @param {string} atom
 * @returns {{raw: string, prefix: string, value: string, first: string, second: string}|null}
 */
function splitAtom(atom) {
  const raw = String(atom ?? '').trim();
  const colon = raw.indexOf(':');
  if (!raw || colon < 0) return null;
  const value = raw.slice(colon + 1).trim();
  const [first, second] = value.split(':').map(s => s?.trim());
  return { raw, prefix: raw.slice(0, colon), value, first, second };
}

/**
 * Evaluates one atom against the snapshot.
 *
 * Unrecognized atoms fail PERMISSIVELY (return true) — a typo in a GM's expression
 * must not silently lock a feat away with no visible cause. This mirrors the sibling
 * modules' documented philosophy.
 */
function evaluateAtom(atom, snapshot) {
  const req = String(atom ?? '').trim();
  if (!req) return true;
  if (req === 'hasSpellcasting') return Boolean(snapshot.hasSpellcasting);

  const parts = splitAtom(req);
  if (!parts) return true;
  const { prefix, value, first, second } = parts;

  switch (prefix) {
    case 'hasFeature':
      return snapshot.featureNames?.some(n => n.includes(value.toLowerCase())) ?? false;
    case 'hasDomain':
      return snapshot.domains?.some(d => sameName(d, value)) ?? false;
    case 'traitAtLeast':
      return (snapshot.traits?.[first?.toLowerCase()] ?? 0) >= Number(second);
    case 'resourceAtLeast':
      return (snapshot.resources?.[first] ?? 0) >= Number(second);
    case 'categoryAtLeast':
      return (snapshot.categoryCounts?.[first] ?? 0) >= Number(second);
    case 'tierAtLeast':
      return (snapshot.tier ?? 0) >= Number(value);
    case 'levelAtLeast':
      return (snapshot.level ?? 0) >= Number(value);
    case 'classIs':
      return sameName(value, snapshot.className) || sameName(value, snapshot.multiclassName);
    case 'subclassIs':
      return (
        sameName(value, snapshot.subclassName) ||
        sameName(value, snapshot.multiclassSubclassName)
      );
    case 'communityIs':
      return sameName(value, snapshot.communityName);
    case 'ancestryIs':
      return sameName(value, snapshot.ancestryName);
    default:
      return true; // permissive
  }
}

/**
 * OR-of-AND evaluation, case-insensitive, space-delimited. AND binds tighter than OR.
 * @param {string} expression
 * @param {object} snapshot
 * @returns {boolean}
 */
export function evaluateExpression(expression, snapshot) {
  if (!expression || !String(expression).trim()) return true;
  return String(expression)
    .split(/ OR /i)
    .some(branch => branch.split(/ AND /i).every(atom => evaluateAtom(atom, snapshot)));
}

/**
 * Describes an expression as nested DESCRIPTORS, so it can be shown to a player in
 * words instead of in the grammar.
 *
 * `hasSpellcasting AND traitAtLeast:agility:2` was printed verbatim on the requirement
 * chip — machine syntax, in the one place a player is meant to read what a Feat costs
 * them. This returns the same OR-of-AND shape `evaluateExpression` walks, with each
 * atom carried as `{ key, data }`: the very shape every other clause in this file
 * emits, so the app layer localizes it with the code it already has and `logic/` stays
 * free of `game.i18n`.
 *
 * Most atoms reuse an existing key rather than inventing a synonym — `levelAtLeast:5`
 * is the same sentence as the Level clause, and `categoryAtLeast:alchemy:3` the same as
 * one investment row — so a GM cannot make the same requirement read two ways
 * depending on which control they typed it into.
 *
 * An atom this grammar does not recognize is returned as `{ key: null, raw }` and
 * printed as typed. That matches how `evaluateAtom` treats it: permissively, visible,
 * never silently dropped.
 *
 * @param {string} expression
 * @param {object} snapshot   consulted only for label maps
 * @returns {Array<Array<{key: string|null, data: object, raw: string}>>}
 */
export function parseExpression(expression, snapshot = {}) {
  if (!expression || !String(expression).trim()) return [];
  return String(expression)
    .split(/ OR /i)
    .map(branch =>
      branch
        .split(/ AND /i)
        .map(atom => describeAtom(atom, snapshot))
        .filter(Boolean)
    )
    .filter(branch => branch.length);
}

/** One atom as a descriptor. @see parseExpression */
function describeAtom(atom, snapshot) {
  const raw = String(atom ?? '').trim();
  if (!raw) return null;

  const say = (key, data) => ({ key, data, raw });
  if (raw === 'hasSpellcasting') return say('RDHF.requirement.atom.spellcasting', {});

  const parts = splitAtom(raw);
  if (!parts) return say(null, {});
  const { prefix, value, first, second } = parts;

  switch (prefix) {
    // `items` rather than `value`: these read as any-of everywhere else, and the app
    // layer's list join is what puts the word "or" in.
    case 'hasFeature':
      return say('RDHF.requirement.feature', { items: [value] });
    case 'classIs':
      return say('RDHF.requirement.class', { items: [value] });
    case 'subclassIs':
      return say('RDHF.requirement.subclass', { items: [value] });
    case 'hasDomain':
      return say('RDHF.requirement.atom.domain', { value });
    case 'communityIs':
      return say('RDHF.requirement.atom.community', { value });
    case 'ancestryIs':
      return say('RDHF.requirement.atom.ancestry', { value });
    case 'tierAtLeast':
      return say('RDHF.requirement.atom.tier', { value: Number(value) || 0 });
    case 'levelAtLeast':
      return say('RDHF.requirement.level', { value: Number(value) || 0 });
    case 'traitAtLeast': {
      // A trait this system does not have would localize to the literal key, so an
      // unknown one falls back to the raw atom rather than printing "RDHF.trait.foo".
      const trait = String(first ?? '').toLowerCase();
      if (!TRAITS.includes(trait)) return say(null, {});
      return say('RDHF.requirement.trait', {
        traitKey: 'RDHF.trait.' + trait,
        value: Number(second) || 0
      });
    }
    case 'resourceAtLeast':
      if (!(first in RESOURCE_REQS)) return say(null, {});
      return say('RDHF.requirement.resource.' + first, { value: Number(second) || 0 });
    case 'categoryAtLeast':
      return say('RDHF.requirement.categoryInvestment', {
        parts: [
          {
            category: snapshot.categoryLabels?.[first] ?? first,
            count: Number(second) || 0,
            join: null
          }
        ]
      });
    default:
      return say(null, {});
  }
}

/** Atom vocabulary, for the GM editor's requirement picker. */
export const ATOMS = [
  'hasFeature:',
  'hasDomain:',
  'hasSpellcasting',
  'traitAtLeast:',
  'resourceAtLeast:',
  'categoryAtLeast:',
  'tierAtLeast:',
  'levelAtLeast:',
  'classIs:',
  'subclassIs:',
  'communityIs:',
  'ancestryIs:'
];
