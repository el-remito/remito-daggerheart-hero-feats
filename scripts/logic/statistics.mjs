/**
 * statistics.mjs
 * Pure derivation for the registry's Statistics tab. Plain records in, plain numbers
 * out — no game.*, no documents, no i18n. Labels arrive already localized from the app
 * layer, exactly as the requirement descriptors do.
 *
 * Nothing here is persisted. Every figure is recomputed from the registry and the
 * actor flags each time the tab renders, which is why adding a statistic never needs a
 * migration and never has to be kept in sync with anything.
 *
 * Every builder is total over empty input: a GM who opens the tab before authoring a
 * single feat must get zeroed structures and an empty state, never undefined and never
 * a stack trace.
 */

import { TRAITS, RESOURCE_REQS } from '../constants.mjs';
// Sibling imports inside logic/ — every one is pure, and the alternative is restating
// those rules here, where they would drift from the ones the catalog actually
// evaluates. evaluateInvestment above all: the reach audit has to read an AND/OR chain
// exactly as checkRequirements does, and that precedence gets stated once.
import { applyAutoInvestment } from './automation.mjs';
import { evaluateInvestment } from './requirements.mjs';

/** Levels the grid always shows, so its columns never move as a catalog grows. */
export const LEVEL_COLUMNS = 10;

/** The bucket uncurated feats fall into. Not a real Category id — nothing may collide. */
export const UNCURATED_ROW = '__uncurated__';

/** Requirement kinds counted by the usage panel, in the order they are displayed. */
export const REQUIREMENT_KINDS = [
  'traits',
  'resources',
  'features',
  'classes',
  'subclasses',
  'categoryInvestment',
  'expression'
];

/* ── Catalog shape ─────────────────────────────────────────────────────────── */

/**
 * Everything the Catalog shape and Coverage gaps panels display.
 *
 * @param {object} args
 * @param {Array<object>} args.feats        normalized feats, each with a `label` and `resolves`
 * @param {Array<{id: string, label: string}>} args.categories
 * @param {Array<{id: string, label: string}>} args.types
 * @param {string} [args.uncuratedLabel]    localized label for the uncurated grid row
 * @param {number} [args.maxLevel]
 * @returns {object}
 */
export function buildCatalogStats({
  feats = [],
  categories = [],
  types = [],
  uncuratedLabel = 'Uncurated',
  maxLevel = LEVEL_COLUMNS
} = {}) {
  const list = Array.isArray(feats) ? feats.filter(Boolean) : [];
  const columns = levelColumns(list, maxLevel);

  const counters = {
    total: list.length,
    curated: 0,
    uncurated: 0,
    hidden: 0,
    standalone: 0,
    missing: 0
  };
  for (const feat of list) {
    if (feat.category) counters.curated++;
    else counters.uncurated++;
    if (feat.hidden) counters.hidden++;
    if (feat.standalone) counters.standalone++;
    if (feat.resolves === false) counters.missing++;
  }

  // The uncurated row is pinned last: it is a holding pen, not a Category, and mixing
  // it into the alphabetical run would imply otherwise.
  const categoryRows = [
    ...categories.map(c => ({ id: c.id, label: c.label ?? c.id })),
    ...(counters.uncurated ? [{ id: UNCURATED_ROW, label: uncuratedLabel, isUncurated: true }] : [])
  ];

  const categoryGrid = buildGrid(categoryRows, columns, list, (feat, rowId) =>
    rowId === UNCURATED_ROW ? !feat.category : feat.category === rowId
  );

  // A feat with two Types is counted in both rows, so these totals legitimately exceed
  // the feat count. `typed` is reported alongside so the arithmetic is never a mystery.
  const typeRows = types.map(t => ({ id: t.id, label: t.label ?? t.id }));
  const typeGrid = buildGrid(typeRows, columns, list, (feat, rowId) =>
    (feat.types ?? []).includes(rowId)
  );

  const typed = list.filter(f => (f.types ?? []).length > 0).length;

  return {
    ...counters,
    typed,
    untyped: list.length - typed,
    columns,
    grids: { category: categoryGrid, type: typeGrid },
    typeSpread: buildSpread(typeRows, list, (feat, rowId) => (feat.types ?? []).includes(rowId)),
    requirementUsage: buildRequirementUsage(list),
    traitDemand: buildTraitDemand(list),
    resourceDemand: buildResourceDemand(list),
    gaps: buildGaps(categoryGrid, columns),
    brokenReferences: buildBrokenReferences(list)
  };
}

/** Columns 1..maxLevel, widened if a feat somehow sits above the expected ceiling. */
function levelColumns(feats, maxLevel) {
  const ceiling = feats.reduce((top, f) => Math.max(top, Number(f.level) || 0), 0);
  const span = Math.max(Number(maxLevel) || LEVEL_COLUMNS, ceiling, 1);
  return Array.from({ length: span }, (_, i) => i + 1);
}

/**
 * One heat grid.
 *
 * `max` is the busiest single cell in THIS grid, and it is what the shading scales
 * against. Scaling against a figure shared between grids — or against the row totals —
 * would flatten a catalog with one crowded Category into a sheet of near-identical
 * squares, which is the one thing the panel exists to avoid.
 *
 * A feat outside the column span is dropped rather than clamped into the last column:
 * `levelColumns` already widens to fit the highest feat, so reaching this means the
 * feat has no usable level at all (0, missing, or unparseable).
 *
 * @param {Array<object>} rowDefs
 * @param {number[]} columns
 * @param {Array<object>} feats
 * @param {(feat: object, rowId: string) => boolean} belongs
 */
function buildGrid(rowDefs, columns, feats, belongs) {
  const rows = rowDefs.map(def => ({
    ...def,
    total: 0,
    cells: columns.map(level => ({ level, count: 0 }))
  }));

  let max = 0;
  for (const feat of feats) {
    const level = Number(feat.level) || 0;
    const index = columns.indexOf(level);
    if (index === -1) continue;
    for (const row of rows) {
      if (!belongs(feat, row.id)) continue;
      const cell = row.cells[index];
      cell.count++;
      row.total++;
      if (cell.count > max) max = cell.count;
    }
  }

  return {
    rows,
    columns,
    max,
    // Column totals sit under the grid; a Level nobody wrote for is as interesting as
    // a Category nobody wrote for.
    columnTotals: columns.map((level, i) => ({
      level,
      count: rows.reduce((sum, row) => sum + row.cells[i].count, 0)
    }))
  };
}

/* ── Investment reach ──────────────────────────────────────────────────── */

/**
 * Which Feats can never be acquired by anyone, because their Investment in Category
 * requirement can never be satisfied.
 *
 * Every investment requirement is audited, whether the GM typed it or the Automation
 * curve derived it: `applyAutoInvestment` already answers "authored or derived" — it
 * returns the derived row when the rule reaches the Feat, the Feat's own rows when it
 * does not, and the Feat untouched when the rule is off. An earlier version audited
 * only the Feats the rule reached, which meant a hand-authored row — the more likely
 * place for the mistake, since the curve is applied uniformly by machine while
 * authored numbers are typed one at a time — was never checked at all.
 *
 * **Reachability is a least fixpoint, and that is the whole point.** Measuring supply
 * as "Feats in the Category at or below this Level, minus one" counts Feats that are
 * themselves unreachable, so two Level 5 Feats each demanding six from a Category
 * holding five each counted the OTHER as available and the pair passed — although
 * neither can ever be acquired first. Any Category more than one Feat wide at its top
 * Level hid its own shortfall that way, and the wider it was the more it hid. So
 * nothing is supply until it is known reachable, starting from the Feats that require
 * nothing and growing until no more can be added. A Feat is never its own prerequisite
 * for free: it is only ever tested while outside the reachable set.
 *
 * What is still NOT modelled is the supplying Feats' OTHER requirements — Trait
 * minimums, prerequisites, class. So a reachable verdict means "not provably
 * impossible", never "comfortable", and the panel says so.
 *
 * @param {object} args
 * @param {Array<object>} args.feats  normalized feats ({ uuid, level, category, withheld, autoExempt, requirements })
 * @param {Array<{id: string, label: string}>} args.categories
 * @param {{enabled: boolean, table: Object<string, number>}} args.rule
 * @returns {{checked: number, blocked: Array<object>, worst: number}}
 */
export function buildInvestmentReach({ feats = [], categories = [], rule = null } = {}) {
  const list = Array.isArray(feats) ? feats.filter(Boolean) : [];
  const labels = new Map(categories.map(c => [c.id, c.label]));

  // Supply is what a player could actually acquire, so every withhold drops out: the
  // per-Feat Hidden flag, a hidden Category, a hidden Type and uncurated alike. The app
  // collapses all four into `withheld`, because it is the layer that can see the
  // taxonomy; `hidden` is still honoured for a caller that has not.
  const candidates = list.filter(f => f.withheld !== true && f.hidden !== true);

  const chains = new Map();
  for (const feat of candidates) chains.set(feat, effectiveInvestment(feat, rule));

  const reachable = reachableSet(candidates, chains);

  // The supply that actually exists, measured once the set has settled. This is what
  // the findings report, and what their shortfalls are computed against.
  const supply = cumulativeCounts(candidates.filter(f => reachable.has(f)));

  const groups = new Map();
  let checked = 0;

  for (const feat of candidates) {
    const chain = chains.get(feat);
    if (!chain.length) continue; // requires nothing: never a finding, never interesting
    checked++;
    if (reachable.has(feat)) continue;

    const level = featLevel(feat);
    const counts = countsAt(supply, level);
    const parts = chain.map(r => ({
      category: r.category,
      count: Number(r.count),
      join: r.join ?? null
    }));
    const key = `${feat.category ?? ''}|${level}|${JSON.stringify(parts)}`;

    const existing = groups.get(key);
    if (existing) {
      existing.feats++;
      continue;
    }

    groups.set(key, {
      category: feat.category ?? null,
      label: labels.get(feat.category) ?? feat.category ?? '',
      level,
      feats: 1,
      derived: chain.derived === true,
      parts,
      // One entry per distinct Category the chain names, so a cross-Category row is
      // reported against the Category it actually asks for.
      supplyParts: [...new Set(parts.map(p => p.category))].map(id => ({
        category: id,
        label: labels.get(id) ?? id,
        supply: counts[id] ?? 0
      })),
      shortfall: chainShortfall(parts, counts)
    });
  }

  const blocked = [...groups.values()];

  // Lowest Level first inside a Category, Categories worst-shortfall first. A blockage
  // CASCADES under a fixpoint — unreachable Level 5 Feats make the Level 6 ones
  // unreachable too, with a bigger shortfall — so sorting by shortfall alone would put
  // the symptom above the cause. The earliest blocked Level is where to author.
  const worstIn = new Map();
  for (const b of blocked) {
    worstIn.set(b.category, Math.max(worstIn.get(b.category) ?? 0, b.shortfall));
  }
  blocked.sort(
    (a, b) =>
      (worstIn.get(b.category) ?? 0) - (worstIn.get(a.category) ?? 0) ||
      String(a.label).localeCompare(String(b.label)) ||
      a.level - b.level ||
      b.shortfall - a.shortfall
  );

  return {
    checked,
    blocked,
    worst: blocked.reduce((top, b) => Math.max(top, b.shortfall), 0)
  };
}

/** A Feat's Level as a number, defaulted the way every other reader here defaults it. */
function featLevel(feat) {
  return Number(feat?.level) || 1;
}

/**
 * The investment chain a Feat actually carries, derived or authored, filtered by the
 * SAME test checkRequirements applies — `r.category && Number(r.count)`. A row with no
 * Category or a count of 0 produces no visible requirement there, so it must not
 * produce a finding here. Four readers now share that filter, and usage-smoke asserts
 * they agree.
 *
 * The array carries a `derived` marker so a finding can say where its number came from
 * without the caller having to ask the rule a second time.
 */
function effectiveInvestment(feat, rule) {
  const applied = applyAutoInvestment(feat, rule);
  const rows = applied.requirements?.categoryInvestment;
  const chain = (Array.isArray(rows) ? rows : []).filter(r => r?.category && Number(r.count));
  chain.derived = applied !== feat;
  return chain;
}

/**
 * The least fixpoint: start with nothing reachable and keep adding any Feat whose chain
 * is satisfied by what is reachable already, until a whole pass adds none.
 *
 * The cumulative table is rebuilt once per PASS rather than once per Feat — that is
 * the difference between linear-ish and cubic on a catalog of a few hundred.
 */
function reachableSet(candidates, chains) {
  const reachable = new Set();
  let changed = true;

  while (changed) {
    changed = false;
    const counts = cumulativeCounts(candidates.filter(f => reachable.has(f)));
    for (const feat of candidates) {
      if (reachable.has(feat)) continue;
      // evaluateInvestment returns true for an empty chain, so a Feat that requires
      // nothing joins on the first pass and seeds everything else.
      const met = evaluateInvestment(chains.get(feat), {
        categoryCounts: countsAt(counts, featLevel(feat))
      });
      if (!met) continue;
      reachable.add(feat);
      changed = true;
    }
  }

  return reachable;
}

/**
 * `level -> category -> count` for the given Feats, cumulative up each Level, so
 * countsAt() is a lookup rather than a rescan.
 */
function cumulativeCounts(feats) {
  const byLevel = new Map();
  let top = 0;
  for (const feat of feats) {
    const level = featLevel(feat);
    top = Math.max(top, level);
    const row = byLevel.get(level) ?? {};
    row[feat.category] = (row[feat.category] ?? 0) + 1;
    byLevel.set(level, row);
  }

  const cumulative = [];
  let running = {};
  for (let level = 1; level <= top; level++) {
    running = { ...running };
    for (const [id, n] of Object.entries(byLevel.get(level) ?? {})) {
      running[id] = (running[id] ?? 0) + n;
    }
    cumulative[level] = running;
  }
  return cumulative;
}

/** Everything acquirable at or below a Level. Above the highest present, that one. */
function countsAt(cumulative, level) {
  if (cumulative.length < 2) return {};
  const top = cumulative.length - 1;
  return cumulative[Math.min(Math.max(level, 1), top)] ?? {};
}

/**
 * The smallest number of extra Feats that would satisfy the chain: the minimum, over
 * the chain's AND-groups, of the summed deficits inside that group.
 *
 * The grouping is evaluateInvestment's own — left to right, AND binding tighter than
 * OR — so this reads the chain the way the catalog reads it. A single-row chain
 * reduces to `required - supply`, which is the number this panel has always printed.
 */
function chainShortfall(parts, counts) {
  const groups = [[]];
  parts.forEach((part, index) => {
    if (index && part.join === 'or') groups.push([]);
    groups[groups.length - 1].push(part);
  });

  return groups.reduce((best, group) => {
    const deficit = group.reduce(
      (sum, part) => sum + Math.max(0, Number(part.count) - (counts[part.category] ?? 0)),
      0
    );
    return Math.min(best, deficit);
  }, Infinity);
}

/* ── Spread and demand ─────────────────────────────────────────────────────── */

/** A simple count-per-row bar list, sorted by count then label. */
function buildSpread(rowDefs, feats, belongs) {
  const rows = rowDefs.map(def => ({
    ...def,
    count: feats.filter(f => belongs(f, def.id)).length
  }));
  const max = rows.reduce((top, r) => Math.max(top, r.count), 0);
  return {
    max,
    rows: rows
      .map(r => ({ ...r, share: max ? Math.round((r.count / max) * 100) : 0 }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)))
  };
}

/** How many feats lean on each kind of requirement. */
function buildRequirementUsage(feats) {
  const rows = REQUIREMENT_KINDS.map(kind => ({
    kind,
    count: feats.filter(f => usesRequirement(f.requirements, kind)).length
  }));
  const max = rows.reduce((top, r) => Math.max(top, r.count), 0);
  return {
    max,
    total: feats.length,
    rows: rows.map(r => ({
      ...r,
      share: feats.length ? Math.round((r.count / feats.length) * 100) : 0
    }))
  };
}

/**
 * True when a feat actually states a requirement of this kind.
 *
 * AUTHORED requirements only. A Rule Automation row is derived at read time and is
 * never seen here, because the rule reaches nearly every feat and folding it in would
 * peg the investment bar at ~100% and destroy the signal this panel exists to give.
 * What the rule does to reachability is the separate audit above.
 */
export function usesRequirement(reqs, kind) {
  if (!reqs) return false;
  switch (kind) {
    case 'traits':
      return TRAITS.some(t => isSet(reqs.traits?.[t]));
    case 'resources':
      return Object.keys(RESOURCE_REQS).some(k => isSet(reqs.resources?.[k]));
    case 'expression':
      return Boolean(String(reqs.expression ?? '').trim());
    case 'categoryInvestment':
      // The same filter checkRequirements and authoredRows() apply. Without it a row
      // holding no Category or a count of 0 was reported here as a requirement in use
      // while producing no clause anywhere else — and the same feat was still being
      // derived into by Rule Automation, which filters such a row out. It was counted
      // as authored and treated as automatic at the same time.
      return (reqs.categoryInvestment ?? []).some(r => r?.category && r?.count);
    default:
      return (reqs[kind] ?? []).length > 0;
  }
}

/** A requirement slot counts only when it holds a real, positive number. */
function isSet(value) {
  return value !== null && value !== undefined && value !== '' && Number(value) > 0;
}

/**
 * Which Traits the catalog actually demands.
 *
 * The point is skew, not volume: if nearly every feat asks for Agility then characters
 * built any other way have little to buy, and that is invisible when reading feats one
 * at a time.
 */
function buildTraitDemand(feats) {
  const rows = TRAITS.map(trait => {
    const demanding = feats.filter(f => isSet(f.requirements?.traits?.[trait]));
    return {
      key: trait,
      count: demanding.length,
      peak: demanding.reduce((top, f) => Math.max(top, Number(f.requirements.traits[trait])), 0)
    };
  });
  const max = rows.reduce((top, r) => Math.max(top, r.count), 0);
  return {
    max,
    rows: rows.map(r => ({ ...r, share: max ? Math.round((r.count / max) * 100) : 0 }))
  };
}

/** The same, for the four resource minimums. */
function buildResourceDemand(feats) {
  const rows = Object.keys(RESOURCE_REQS).map(key => {
    const demanding = feats.filter(f => isSet(f.requirements?.resources?.[key]));
    return {
      key,
      count: demanding.length,
      peak: demanding.reduce((top, f) => Math.max(top, Number(f.requirements.resources[key])), 0)
    };
  });
  const max = rows.reduce((top, r) => Math.max(top, r.count), 0);
  return {
    max,
    rows: rows.map(r => ({ ...r, share: max ? Math.round((r.count / max) * 100) : 0 }))
  };
}

/* ── Gaps ──────────────────────────────────────────────────────────────────── */

/**
 * Where the Category × Level grid has nothing in it.
 *
 * The uncurated row is skipped throughout: an empty uncurated cell is the *goal*, not
 * a gap, and listing it as one would invert the meaning of the whole panel.
 */
function buildGaps(grid, columns) {
  const real = grid.rows.filter(r => !r.isUncurated);
  const emptyCells = [];
  const emptyCategories = [];

  for (const row of real) {
    if (!row.total) {
      emptyCategories.push({ id: row.id, label: row.label });
      continue; // a Category with nothing at all is one finding, not ten
    }
    for (const cell of row.cells) {
      if (!cell.count) emptyCells.push({ id: row.id, label: row.label, level: cell.level });
    }
  }

  const emptyLevels = columns.filter(level =>
    real.every(row => row.cells.find(c => c.level === level)?.count === 0)
  );

  return { emptyCells, emptyCategories, emptyLevels };
}

/**
 * Prerequisite references pointing at something the registry does not know about.
 *
 * Only UUID-shaped entries are checked. A bare Feature *name* is a legitimate,
 * deliberately loose requirement form (the checker matches it against the character's
 * own feature names), so it can never be "broken" here.
 */
function buildBrokenReferences(feats) {
  const known = new Set(feats.map(f => f.uuid));
  const broken = [];
  for (const feat of feats) {
    for (const ref of feat.requirements?.features ?? []) {
      if (!isUuidLike(ref)) continue;
      if (known.has(ref)) continue;
      broken.push({ uuid: feat.uuid, label: feat.label ?? feat.uuid, ref });
    }
  }
  return broken;
}

/** The same shape test the reference chips use: dotted, and with no spaces in it. */
export function isUuidLike(ref) {
  const value = String(ref ?? '');
  return value.includes('.') && !value.includes(' ');
}

/* ── Table adoption ────────────────────────────────────────────────────────── */

/**
 * Everything the Table adoption panel displays.
 *
 * `ledger` holds only characters that own at least one Feat — a deliberate scope
 * decision, so the table never shows rows of zeros. The consequence is that a
 * character who has never opened the catalog does not appear at all.
 *
 * @param {object} args
 * @param {Array<object>} args.feats   normalized feats, for resolving names
 * @param {Array<object>} args.ledger  [{ actorId, name, level, acquired[], pool }]
 * @param {number} [args.recentLimit]
 * @returns {object}
 */
export function buildAdoptionStats({
  feats = [],
  ledger = [],
  recentLimit = 12,
  excluded = null
} = {}) {
  const byUuid = new Map(feats.map(f => [f.uuid, f]));
  const label = uuid => byUuid.get(uuid)?.label ?? uuid;
  // A character the GM has set aside — a retired PC, an NPC sheet, a test dummy —
  // still appears in the ledger, greyed, because the row IS the control that puts
  // them back. Only the DERIVED figures below drop them. `characters` therefore
  // stays the full list and `charactersWithFeats` counts the included ones, which is
  // the pair the caller needs to render a table nobody can get stranded in.
  const skip = excluded instanceof Set ? excluded : new Set(excluded ?? []);
  const counted = ledger.filter(entry => !skip.has(entry.actorId));

  const characters = ledger.map(entry => {
    const pool = entry.pool ?? {};
    return {
      actorId: entry.actorId,
      name: entry.name,
      level: entry.level ?? 0,
      img: entry.img ?? null,
      count: (entry.acquired ?? []).length,
      total: pool.total ?? 0,
      spent: pool.spent ?? 0,
      free: pool.free ?? 0,
      remaining: pool.remaining ?? 0,
      overspent: pool.overspent === true,
      excluded: skip.has(entry.actorId),
      // Only feats still in the registry: a character can be carrying an acquisition
      // for a feat the GM has since unregistered.
      categoryCounts: countCategories(entry.acquired ?? [], byUuid)
    };
  });

  const takes = new Map();
  const recent = [];
  for (const entry of counted) {
    for (const acquisition of entry.acquired ?? []) {
      takes.set(acquisition.uuid, (takes.get(acquisition.uuid) ?? 0) + 1);
      recent.push({
        uuid: acquisition.uuid,
        label: label(acquisition.uuid),
        actorId: entry.actorId,
        actorName: entry.name,
        at: Number(acquisition.at) || 0,
        free: acquisition.free === true,
        known: byUuid.has(acquisition.uuid)
      });
    }
  }

  const popularMax = takes.size ? Math.max(...takes.values()) : 0;
  const popular = [...takes.entries()]
    .map(([uuid, count]) => ({
      uuid,
      label: label(uuid),
      count,
      known: byUuid.has(uuid),
      share: popularMax ? Math.round((count / popularMax) * 100) : 0
    }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));

  return {
    characters: characters.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    popular,
    popularMax,
    // Newest first. An acquisition recorded before the timestamp existed sorts last,
    // which is where a 0 belongs.
    recent: recent.sort((a, b) => b.at - a.at).slice(0, recentLimit),
    acquisitions: recent.length,
    charactersWithFeats: counted.length,
    excludedCount: characters.length - counted.length
  };
}

function countCategories(acquired, byUuid) {
  const counts = {};
  for (const entry of acquired) {
    const category = byUuid.get(entry.uuid)?.category;
    if (category) counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}
