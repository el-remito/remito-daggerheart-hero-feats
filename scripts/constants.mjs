/**
 * constants.mjs
 * Shared identifiers. Zero imports — safe to pull into pure-logic modules.
 */

export const MODULE_ID = 'remito-daggerheart-hero-feats';

/** Short prefix used for CSS classes and DOM ids. */
export const PREFIX = 'rdhf';

export const FLAGS = {
  STATE: 'state' // actor.flags["remito-daggerheart-hero-feats"].state
};

export const SETTINGS = {
  REGISTRY: 'registry',
  CATEGORIES: 'categories',
  TYPES: 'types',
  POINT_FORMULA: 'pointFormula',
  MENU: 'registryMenu',
  MIGRATION: 'migration',
  SHOW_STATS: 'showStatistics',
  AUTOMATION: 'automation',
  INVEST_LAYOUT: 'investmentsLayout',
  EXCLUDED_ACTORS: 'excludedActors'
};

/** How the My Investments tab lays its Categories out. Per user, never shared. */
export const INVEST_LAYOUTS = ['wide', 'grid'];

/** Bump when a migration is added; see scripts/data/migrations.mjs. */
export const MIGRATION_VERSION = 2;

export const ACTOR_TYPES = { PC: 'character' };

export const ITEM_TYPES = { FEATURE: 'feature' };

/** Daggerheart trait keys, in sheet order. */
export const TRAITS = ['agility', 'strength', 'finesse', 'instinct', 'presence', 'knowledge'];

/**
 * Requirement-capable resources. `path` is read off actor.system; every one of these
 * compares the character's *capacity*, never the live value — Daggerheart marks Hit
 * Points and Stress upward, so `.value` is damage taken, not health remaining.
 */
export const RESOURCE_REQS = {
  hitPoints: 'resources.hitPoints.max',
  stress: 'resources.stress.max',
  hope: 'resources.hope.max',
  evasion: 'evasion'
};

/**
 * The one Category every world has. It exists so a Feat can be curated — and therefore
 * visible to players — without the GM having to invent a filing system first; that is
 * the job the "General" *type* used to do, badly, because a type could not lift a feat
 * out of uncurated. It is fixed: the Taxonomy tab may not rename or delete it, and
 * getCategories() re-inserts it if it ever goes missing.
 */
export const GENERAL_CATEGORY_ID = 'general';

export const DEFAULT_CATEGORIES = [
  {
    id: GENERAL_CATEGORY_ID,
    label: 'RDHF.category.general',
    icon: 'fa-solid fa-star',
    description: '',
    fixed: true
  }
];

/**
 * Types seeded on first run. The whitepaper's Category / Class / Domain types are not
 * listed here — they are resolved dynamically at read time from the feat's own Category,
 * the daggerheart.classes pack, and CONFIG.DH.DOMAIN.allDomains().
 *
 * "General" is deliberately absent: it is a Category now (see GENERAL_CATEGORY_ID), and
 * migration 1 strips the old type from every feat.
 */
export const DEFAULT_TYPES = [
  { id: 'combat', label: 'RDHF.type.combat', icon: 'fa-solid fa-swords' },
  { id: 'spellcasting', label: 'RDHF.type.spellcasting', icon: 'fa-solid fa-wand-sparkles' },
  { id: 'utility', label: 'RDHF.type.utility', icon: 'fa-solid fa-toolbox' },
  { id: 'social', label: 'RDHF.type.social', icon: 'fa-solid fa-comments' },
  { id: 'crafting', label: 'RDHF.type.crafting', icon: 'fa-solid fa-hammer' },
  { id: 'downtime', label: 'RDHF.type.downtime', icon: 'fa-solid fa-fire-burner' }
];

export const DEFAULT_POINT_FORMULA = '@level * 2';

/**
 * The seeded curve for the "Default Investment by Level" automation rule: how many
 * Feats a character must already hold in a Category before a Feat of that Level in
 * that same Category becomes available.
 *
 * Keys are strings because this object is stored in a world setting and round-trips
 * through JSON, which has no numeric keys — reading it back with a number would miss.
 * Level 1 is 0, i.e. the entry point of every Category is always unguarded.
 */
export const DEFAULT_INVESTMENT_BY_LEVEL = {
  '1': 0,
  '2': 1,
  '3': 2,
  '4': 4,
  '5': 7,
  '6': 8,
  '7': 9,
  '8': 12,
  '9': 13,
  '10': 14
};

/**
 * Every entry here is passed to loadTemplates() at init, so each path MUST exist —
 * a missing one rejects the batch and the partials never register. FEAT_ROW is used
 * as a Handlebars partial by both catalog sections, so its registration is load-bearing.
 */
export const TEMPLATES = {
  CATALOG: `modules/${MODULE_ID}/templates/feat-catalog.hbs`,
  REGISTRY_CONFIG: `modules/${MODULE_ID}/templates/feat-registry-config.hbs`,
  FEAT_ROW: `modules/${MODULE_ID}/templates/partials/feat-row.hbs`
};

/** The character sheet anchor the Feat Point badge is appended to. */
export const LEVEL_ANCHOR = '.character-header-sheet .name-row .level-div h3.label';
