/**
 * settings.mjs
 * World setting registration. Called once from the init hook.
 *
 * Setting keys are passed the raw i18n key and left for Foundry to localize — the
 * reputation-tracker convention, which survives a language change at runtime where
 * eager game.i18n.localize() at registration time does not.
 */

import {
  MODULE_ID,
  SETTINGS,
  DEFAULT_TYPES,
  DEFAULT_CATEGORIES,
  DEFAULT_POINT_FORMULA,
  DEFAULT_INVESTMENT_BY_LEVEL,
  GENERAL_CATEGORY_ID
} from './constants.mjs';
import { invalidatePackCache } from './data/registry.mjs';
import { normalizeAutomation } from './logic/automation.mjs';

/**
 * The source list as it stood at the last invalidation, so a registry write that did
 * not touch it costs nothing.
 *
 * Curation's File writes one feat's entry straight to the registry, and it does that
 * once per feat over a long session. Invalidating the pack index on every one of those
 * would force a full re-index of every source pack on the very next render — for a
 * change that cannot affect what a pack contains.
 */
let _sourceSignature = null;

/** The registry setting's shape on a fresh world. */
export function defaultRegistry() {
  return { sources: [], feats: {} };
}

export function registerSettings() {
  // The feat registry: sources + per-UUID metadata. Edited only through the GM app.
  game.settings.register(MODULE_ID, SETTINGS.REGISTRY, {
    scope: 'world',
    config: false,
    type: Object,
    default: defaultRegistry(),
    // Registering, removing or disabling a compendium invalidates the cached pack
    // indices. Nothing else in the registry can, so nothing else pays for it.
    onChange: registry => {
      const signature = JSON.stringify(
        (registry?.sources ?? []).map(s => [s.packId, s.enabled !== false])
      );
      if (signature === _sourceSignature) return;
      _sourceSignature = signature;
      invalidatePackCache();
    }
  });

  // Managed taxonomy lists.
  game.settings.register(MODULE_ID, SETTINGS.CATEGORIES, {
    scope: 'world',
    config: false,
    type: Array,
    default: foundry.utils.deepClone(DEFAULT_CATEGORIES)
  });

  game.settings.register(MODULE_ID, SETTINGS.TYPES, {
    scope: 'world',
    config: false,
    type: Array,
    default: foundry.utils.deepClone(DEFAULT_TYPES)
  });

  // Which data migrations have run in this world. See data/migrations.mjs.
  game.settings.register(MODULE_ID, SETTINGS.MIGRATION, {
    scope: 'world',
    config: false,
    type: Number,
    default: 0
  });

  // The point formula. config: false — the Points tab of the registry app owns this,
  // and it owns it ALONE. It was on the settings sheet as well, which gave the same
  // world value two editors with different rules: the sheet wrote on submit, the Points
  // tab is a working copy that needs Save, and a GM looking at both had no way to tell
  // which one was the source of truth. The registry is the surface that can also show
  // the live preview and explain the @-paths, so it is the one that stays.
  //
  // The two i18n keys are still named 'RDHF.settings.pointFormula.*' because that is
  // where the string lives and the Points tab localizes them; only the sheet is gone.
  game.settings.register(MODULE_ID, SETTINGS.POINT_FORMULA, {
    scope: 'world',
    config: false,
    type: String,
    default: DEFAULT_POINT_FORMULA
  });

  // The one setting a GM can still tweak without opening the registry app: whether the
  // registry shows its Statistics tab. World-scoped, so only a GM can
  // reach it in the first place. Nothing is computed while this is off — the tab is
  // what triggers the actor scan.
  game.settings.register(MODULE_ID, SETTINGS.SHOW_STATS, {
    name: 'RDHF.settings.showStatistics.name',
    hint: 'RDHF.settings.showStatistics.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  // Rule Automation. config: false — like the registry and the taxonomy, this is only
  // ever edited through the Automation tab, which can explain the curve and show what
  // it derives; Foundry's settings sheet cannot.
  game.settings.register(MODULE_ID, SETTINGS.AUTOMATION, {
    scope: 'world',
    config: false,
    type: Object,
    default: {
      investmentByLevel: {
        enabled: false,
        table: foundry.utils.deepClone(DEFAULT_INVESTMENT_BY_LEVEL)
      }
    }
  });
}

/**
 * Registered separately, after the app class is importable, so settings.mjs itself has
 * no dependency on the application layer.
 * @param {typeof foundry.applications.api.ApplicationV2} appClass
 */
export function registerRegistryMenu(appClass) {
  game.settings.registerMenu(MODULE_ID, SETTINGS.MENU, {
    name: 'RDHF.settings.menu.name',
    label: 'RDHF.settings.menu.label',
    hint: 'RDHF.settings.menu.hint',
    icon: 'fa-solid fa-award',
    type: appClass,
    restricted: true
  });
}

/* ── Accessors ─────────────────────────────────────────────────────────────── */

export function getRegistry() {
  return game.settings.get(MODULE_ID, SETTINGS.REGISTRY) ?? defaultRegistry();
}

export async function setRegistry(registry) {
  return game.settings.set(MODULE_ID, SETTINGS.REGISTRY, registry);
}

/**
 * The Rule Automation settings, normalized. Every read goes through
 * normalizeAutomation so a partial or hand-edited stored value can never reach the
 * rule itself — the same contract normalizeFeat gives a registry entry.
 */
export function getAutomation() {
  return normalizeAutomation(game.settings.get(MODULE_ID, SETTINGS.AUTOMATION));
}

export async function setAutomation(automation) {
  return game.settings.set(MODULE_ID, SETTINGS.AUTOMATION, normalizeAutomation(automation));
}

/**
 * Categories, General first and the rest alphabetical by displayed label.
 *
 * Sorting lives in the accessor rather than at each call site so the filter rails, the
 * curation dropdowns and the Taxonomy tab can never disagree about the order. General
 * is re-inserted here if a world is missing it, which keeps a pre-migration world (or
 * an imported registry) from losing the one Category that must always exist.
 */
export function getCategories() {
  const stored = game.settings.get(MODULE_ID, SETTINGS.CATEGORIES) ?? [];
  const list = stored.some(c => c?.id === GENERAL_CATEGORY_ID)
    ? [...stored]
    : [...foundry.utils.deepClone(DEFAULT_CATEGORIES), ...stored];
  return sortTaxonomy(list, GENERAL_CATEGORY_ID);
}

/** True for a Category the Taxonomy tab must not rename or delete. */
export function isFixedCategory(id) {
  return id === GENERAL_CATEGORY_ID;
}

/**
 * Alphabetical by displayed label, with one id optionally pinned to the front.
 * localeCompare so accented and non-English labels sort the way a reader expects.
 */
function sortTaxonomy(list, pinnedId = null) {
  return [...list].sort((a, b) => {
    if (pinnedId) {
      if (a?.id === pinnedId) return -1;
      if (b?.id === pinnedId) return 1;
    }
    return taxonomyLabel(a).localeCompare(taxonomyLabel(b));
  });
}

export async function setCategories(categories) {
  return game.settings.set(MODULE_ID, SETTINGS.CATEGORIES, categories);
}

/** Types, alphabetical. Nothing is pinned — General is a Category now. */
export function getTypes() {
  return sortTaxonomy(game.settings.get(MODULE_ID, SETTINGS.TYPES) ?? []);
}

export async function setTypes(types) {
  return game.settings.set(MODULE_ID, SETTINGS.TYPES, types);
}

export function getPointFormula() {
  return game.settings.get(MODULE_ID, SETTINGS.POINT_FORMULA) || DEFAULT_POINT_FORMULA;
}

/** Whether the registry offers its Statistics tab. */
export function getShowStatistics() {
  return game.settings.get(MODULE_ID, SETTINGS.SHOW_STATS) !== false;
}

/**
 * Localizes a taxonomy entry's label. Seeded entries carry an i18n key; GM-authored
 * ones carry literal text, and game.i18n.localize returns a missing key unchanged.
 * @param {{id: string, label: string}} entry
 * @returns {string}
 */
export function taxonomyLabel(entry) {
  if (!entry) return '';
  return entry.label?.startsWith('RDHF.') ? game.i18n.localize(entry.label) : entry.label || entry.id;
}
