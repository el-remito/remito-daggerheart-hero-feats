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
  DEFAULT_POINT_FORMULA
} from './constants.mjs';
import { invalidatePackCache } from './data/registry.mjs';

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
    // Registering or removing a compendium invalidates the cached pack indices.
    onChange: () => invalidatePackCache()
  });

  // Managed taxonomy lists.
  game.settings.register(MODULE_ID, SETTINGS.CATEGORIES, {
    scope: 'world',
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, SETTINGS.TYPES, {
    scope: 'world',
    config: false,
    type: Array,
    default: foundry.utils.deepClone(DEFAULT_TYPES)
  });

  // The one setting a GM may want to tweak without opening the registry app.
  game.settings.register(MODULE_ID, SETTINGS.POINT_FORMULA, {
    name: 'RDHF.settings.pointFormula.name',
    hint: 'RDHF.settings.pointFormula.hint',
    scope: 'world',
    config: true,
    type: String,
    default: DEFAULT_POINT_FORMULA
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

export function getCategories() {
  return game.settings.get(MODULE_ID, SETTINGS.CATEGORIES) ?? [];
}

export async function setCategories(categories) {
  return game.settings.set(MODULE_ID, SETTINGS.CATEGORIES, categories);
}

export function getTypes() {
  return game.settings.get(MODULE_ID, SETTINGS.TYPES) ?? [];
}

export async function setTypes(types) {
  return game.settings.set(MODULE_ID, SETTINGS.TYPES, types);
}

export function getPointFormula() {
  return game.settings.get(MODULE_ID, SETTINGS.POINT_FORMULA) || DEFAULT_POINT_FORMULA;
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
