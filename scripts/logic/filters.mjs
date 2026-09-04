/**
 * filters.mjs
 * Pure catalog filtering and sorting. Operates on "feat views" — the flattened records
 * the catalog builds in _prepareContext ({ uuid, name, level, category, types[],
 * description, eligible, owned, uncurated }).
 *
 * Filtering runs on every keystroke and never triggers a re-render (the catalog toggles
 * row visibility in place), so these must stay cheap and allocation-light.
 */

/**
 * How many Feats "Newly added" shows. A recency window, not a page: the point is
 * "what did I just file", so it stays small enough to read at a glance.
 */
export const NEW_FEATS_LIMIT = 10;

/** The filter state a fresh catalog opens with. */
export function blankFilterState() {
  return {
    search: '',
    levelMin: null,
    levelMax: null,
    categories: [], // empty = no category constraint
    types: [], // empty = no type constraint
    eligibleOnly: false,
    hideOwned: false,
    newOnly: false
  };
}

/**
 * The most recently curated Feats, newest first.
 *
 * Recency is a property of the SET, not of a row — the tenth-newest Feat stops being
 * new when an eleventh is filed, without anything about it changing. So membership is
 * decided once per render and stamped onto the views as `isNew`, which is what lets
 * matchesFilters stay a per-row predicate and lets both windows filter from data
 * attributes without a context object.
 *
 * A Feat that has never been curated carries 0 and is never new: "newly added" means
 * newly made available to players, which is the moment it gained a Category.
 *
 * @param {Array<object>} views  feat views carrying `uuid` and `curatedAt`
 * @param {number} [limit]
 * @returns {Set<string>} uuids
 */
export function newestCurated(views, limit = NEW_FEATS_LIMIT) {
  return newestBy(views, 'curatedAt', limit);
}

/**
 * The most recently CHANGED Feats, newest first — the same window as newestCurated,
 * over its own timestamp, so "recently added" and "recently changed" are read the same
 * way and neither can crowd the other out.
 *
 * A Feat only becomes eligible for an `updatedAt` stamp once its curation has been
 * committed; see _syncField in the registry app. Authoring a Feat necessarily edits the
 * same fields that later count as changes, so without that boundary every freshly
 * curated Feat would report itself as updated.
 *
 * @param {Array<object>} views  feat views carrying `uuid` and `updatedAt`
 * @param {number} [limit]
 * @returns {Set<string>} uuids
 */
export function newestUpdated(views, limit = NEW_FEATS_LIMIT) {
  return newestBy(views, 'updatedAt', limit);
}

/** The shared window. Both chips are a recency SET, and there is one implementation. */
function newestBy(views, field, limit) {
  return new Set(
    (views ?? [])
      .filter(v => Number(v?.[field]) > 0)
      .sort((a, b) => Number(b[field]) - Number(a[field]))
      .slice(0, Math.max(0, limit))
      .map(v => v.uuid)
  );
}

/**
 * @param {object} view      feat view
 * @param {object} state     filter state
 * @returns {boolean}        true when the row should stay visible
 */
export function matchesFilters(view, state) {
  if (!view) return false;
  const s = state ?? blankFilterState();

  if (s.hideOwned && view.owned) return false;
  if (s.eligibleOnly && !view.eligible && !view.owned) return false;
  if (s.newOnly && !view.isNew) return false;

  const min = s.levelMin;
  const max = s.levelMax;
  if (min !== null && min !== undefined && min !== '' && view.level < Number(min)) return false;
  if (max !== null && max !== undefined && max !== '' && view.level > Number(max)) return false;

  if (s.categories?.length && !s.categories.includes(view.category)) return false;

  // Types are OR-ed: a feat matches if it carries ANY of the ticked types. This is what
  // makes the rail useful for widening a search rather than narrowing it to nothing.
  if (s.types?.length && !view.types?.some(t => s.types.includes(t))) return false;

  const query = s.search?.trim().toLowerCase();
  if (query) {
    const haystack = view.searchText ?? buildSearchText(view);
    if (!haystack.includes(query)) return false;
  }

  return true;
}

/**
 * Precomputed lowercase blob a row is searched against. Built once per render and
 * cached on the view so keystroke filtering does no string work.
 * @param {object} view
 * @returns {string}
 */
export function buildSearchText(view) {
  return [view.name, view.categoryLabel, ...(view.typeLabels ?? []), view.summary]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Catalog order: Level ascending, then name. Mirrors how PF2e lists feats. */
export function byLevelThenName(a, b) {
  return (a.level ?? 0) - (b.level ?? 0) || String(a.name).localeCompare(String(b.name));
}

/** GM registry order: uncurated first (they need attention), then level, then name. */
export function byCurationThenLevel(a, b) {
  return Number(b.uncurated) - Number(a.uncurated) || byLevelThenName(a, b);
}
