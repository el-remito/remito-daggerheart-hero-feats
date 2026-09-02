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

/** True when a feat actually states a requirement of this kind. */
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
      return (reqs.categoryInvestment ?? []).length > 0;
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
export function buildAdoptionStats({ feats = [], ledger = [], recentLimit = 12 } = {}) {
  const byUuid = new Map(feats.map(f => [f.uuid, f]));
  const label = uuid => byUuid.get(uuid)?.label ?? uuid;

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
      // Only feats still in the registry: a character can be carrying an acquisition
      // for a feat the GM has since unregistered.
      categoryCounts: countCategories(entry.acquired ?? [], byUuid)
    };
  });

  const takes = new Map();
  const recent = [];
  for (const entry of ledger) {
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
    charactersWithFeats: characters.length
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
