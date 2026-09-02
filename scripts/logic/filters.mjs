/**
 * filters.mjs
 * Pure catalog filtering and sorting. Operates on "feat views" — the flattened records
 * the catalog builds in _prepareContext ({ uuid, name, level, category, types[],
 * description, eligible, owned, uncurated }).
 *
 * Filtering runs on every keystroke and never triggers a re-render (the catalog toggles
 * row visibility in place), so these must stay cheap and allocation-light.
 */

/** The filter state a fresh catalog opens with. */
export function blankFilterState() {
  return {
    search: '',
    levelMin: null,
    levelMax: null,
    categories: [], // empty = no category constraint
    types: [], // empty = no type constraint
    eligibleOnly: false,
    hideOwned: false
  };
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
