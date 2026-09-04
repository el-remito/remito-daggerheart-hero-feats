/**
 * registry.mjs
 * The Feat registry: which Features are Feats, and the metadata each one carries.
 *
 * Metadata lives in a world setting keyed by item UUID — the Feature items themselves
 * are never mutated, so LOCKED compendia (including the SRD packs) work untouched.
 *
 * This is also the only place that reads compendium packs. No sibling module in this
 * workspace does, so the caching and laziness rules are documented here:
 *   • pack.getIndex() is cheap and cached per pack for the session;
 *   • compendium UUIDs CANNOT resolve synchronously (fromUuidSync is world-only), so
 *     full documents are fetched lazily, only when a catalog row is expanded.
 */

import { MODULE_ID, ITEM_TYPES } from '../constants.mjs';
import {
  getRegistry,
  setRegistry,
  getCategories,
  getTypes,
  getAutomation,
  taxonomyLabel
} from '../settings.mjs';
import { blankRequirements, normalizeRequirements } from '../logic/requirements.mjs';
import { applyAutoInvestment } from '../logic/automation.mjs';

/** packId -> Promise<Map<uuid, indexEntry>>. Cleared when the registry setting changes. */
const _packCache = new Map();

/** uuid -> enriched description HTML, filled in on first row expand. */
const _descriptionCache = new Map();

export function invalidatePackCache() {
  _packCache.clear();
}

export function invalidateDescriptionCache() {
  _descriptionCache.clear();
}

/**
 * Drops one cached description. Called when its Feature is edited — without this the
 * enriched text an expanded row shows is whatever it was the first time anyone opened
 * it, for the rest of the session.
 * @param {string} uuid
 */
export function invalidateDescription(uuid) {
  _descriptionCache.delete(uuid);
}

/* ── Pack reading ──────────────────────────────────────────────────────────── */

/**
 * Reads every `feature` Item out of one compendium pack.
 * Returns an empty map for a pack that no longer exists rather than throwing — a GM
 * may have disabled the module that provided it.
 *
 * @param {string} packId  e.g. "daggerheart.classes" or "world.my-feats"
 * @returns {Promise<Map<string, object>>}  uuid -> index entry
 */
export async function loadPackFeatures(packId) {
  if (_packCache.has(packId)) return _packCache.get(packId);

  const promise = (async () => {
    const pack = game.packs.get(packId);
    if (!pack) {
      console.warn(`${MODULE_ID} | Registered pack "${packId}" is not available.`);
      return new Map();
    }
    try {
      // `type` and `img` are in the default index; description must be asked for.
      const index = await pack.getIndex({ fields: ['img', 'type', 'system.description'] });
      const entries = index
        .filter(e => e.type === ITEM_TYPES.FEATURE)
        .map(e => [e.uuid, e]);
      return new Map(entries);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to index pack "${packId}":`, err);
      return new Map();
    }
  })();

  _packCache.set(packId, promise);
  return promise;
}

/**
 * Every Feature reachable from a registry: all enabled sources, plus any individually
 * registered item whose UUID does not belong to a registered pack.
 *
 * The registry is a PARAMETER, not read from settings, because the GM app edits a
 * working copy — reading the saved setting here made a just-added source or a
 * just-dropped Feature invisible until Save-and-reopen.
 *
 * @param {object} [registry]  defaults to the saved world setting
 * @returns {Promise<Map<string, object>>}  uuid -> { uuid, name, img, summary }
 */
export async function loadAllSourceFeatures(registry = getRegistry()) {
  const found = new Map();

  for (const source of registry.sources ?? []) {
    if (source.enabled === false) continue;
    for (const [uuid, entry] of await loadPackFeatures(source.packId)) {
      found.set(uuid, toSourceRecord(uuid, entry));
    }
  }

  // Individually dropped Features (world items, or items from an unregistered pack).
  for (const uuid of Object.keys(registry.feats ?? {})) {
    if (found.has(uuid)) continue;
    const doc = await resolveQuietly(uuid);
    if (doc?.type === ITEM_TYPES.FEATURE) found.set(uuid, toSourceRecord(uuid, doc));
  }

  return found;
}

function toSourceRecord(uuid, entry) {
  return {
    uuid,
    name: entry.name ?? uuid,
    img: entry.img ?? 'icons/svg/item-bag.svg',
    summary: stripHtml(entry.system?.description ?? '')
  };
}

/** fromUuid that resolves to null instead of throwing on a dead reference. */
export async function resolveQuietly(uuid) {
  try {
    return await fromUuid(uuid);
  } catch (_) {
    return null;
  }
}

/** Plain-text preview built from a description's HTML, for the collapsed row. */
export function stripHtml(html, max = 220) {
  if (!html) return '';
  const text = String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The enriched full description for one feat, fetched and cached on first expand.
 * @param {string} uuid
 * @param {Actor|null} actor  relativeTo target for @UUID links and inline rolls
 * @returns {Promise<string>}
 */
export async function getEnrichedDescription(uuid, actor = null) {
  if (_descriptionCache.has(uuid)) return _descriptionCache.get(uuid);
  const doc = await resolveQuietly(uuid);
  const raw = doc?.system?.description ?? '';
  let html = '';
  try {
    html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(raw, {
      secrets: game.user.isGM,
      relativeTo: actor ?? undefined
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to enrich description for ${uuid}:`, err);
    html = raw;
  }
  _descriptionCache.set(uuid, html);
  return html;
}

/* ── Feat records ──────────────────────────────────────────────────────────── */

/** A registry entry as it exists before a GM has curated it. */
export function blankFeat(uuid) {
  return {
    uuid,
    level: 1,
    category: null, // null === uncurated
    types: [],
    summary: '',
    hidden: false, // GM-only: never listed for a player who has not acquired it
    autoExempt: false,
    // When this feat was last given a Category. 0 = never curated. Drives the
    // "Newly added" filter, and nothing else reads it.
    curatedAt: 0, // opts this feat out of every Rule Automation rule
    requirements: blankRequirements()
  };
}

/** Fills in anything a stored entry is missing. */
export function normalizeFeat(uuid, stored) {
  const blank = blankFeat(uuid);
  if (!stored) return blank;
  return {
    uuid,
    level: Number(stored.level) || 1,
    category: stored.category ?? null,
    types: Array.isArray(stored.types) ? [...stored.types] : [],
    // Set when a GM dropped this Feature in individually rather than registering a
    // whole pack — the Sources tab lists these separately so they can be removed.
    standalone: stored.standalone === true,
    // GM-authored teaser; blank falls back to text derived from the description.
    summary: typeof stored.summary === 'string' ? stored.summary : '',
    // A deliberate GM secret. Unlike uncurated, this survives curation: the feat is
    // fully configured and simply must not be browsable yet.
    hidden: stored.hidden === true,
    // Rule Automation derives requirements for every feat that has not opted out; this
    // is the opt-out. See scripts/logic/automation.mjs.
    autoExempt: stored.autoExempt === true,
    curatedAt: Number(stored.curatedAt) || 0,
    requirements: normalizeRequirements(stored.requirements)
  };
}

/** A feat is uncurated until it has been given a Category. */
export function isUncurated(feat) {
  return !feat?.category;
}

/**
 * The full feat list, joined against its source Features.
 *
 * Two things are withheld from players: uncurated feats (no Category yet) and feats
 * the GM flagged hidden. Both are still returned when their uuid is in `keepUuids` —
 * an already-acquired feat must not vanish from the character's own list because the
 * GM later hid it or cleared its Category.
 *
 * @param {object} [options]
 * @param {boolean} [options.forGM]      include uncurated and hidden feats
 * @param {Set<string>|string[]} [options.keepUuids]  never withhold these
 * @returns {Promise<Array<object>>}  feat records merged with { name, img, summary, uncurated }
 */
export async function listFeats({ forGM = false, keepUuids = null, registry = getRegistry() } = {}) {
  const keep = keepUuids instanceof Set ? keepUuids : new Set(keepUuids ?? []);
  const sources = await loadAllSourceFeatures(registry);
  const categories = getCategories();
  // Taxonomy entries a GM has flagged hidden. Read once for the whole list, like the
  // rule below: both are world-level and cannot change mid-loop. The ACCESSORS still
  // return hidden entries — the GM has to be able to file into one — so the withholding
  // lives here, on the one seam every player-facing record passes through.
  const hiddenCategories = new Set(categories.filter(c => c?.hidden).map(c => c.id));
  const hiddenTypes = new Set(getTypes().filter(t => t?.hidden).map(t => t.id));
  // Read once for the whole list, not per feat: the rule is world-level and cannot
  // change mid-loop.
  const rule = getAutomation().investmentByLevel;
  const out = [];

  for (const [uuid, source] of sources) {
    // This is the ONE seam where Rule Automation enters the player-facing world. The
    // derived row is an ordinary categoryInvestment row, so checkRequirements emits
    // the existing descriptor and the catalog renders it with the existing strings —
    // a player cannot tell a derived requirement from an authored one, which is the
    // point. Nothing here is persisted; the registry app builds its own list from
    // normalizeFeat so the GM's editable rows stay authored-only.
    const feat = applyAutoInvestment(normalizeFeat(uuid, registry.feats?.[uuid]), rule);
    const uncurated = isUncurated(feat);
    // Four withholds now, all overridden by keepUuids so a feat a character already
    // owns never vanishes from My Feats: uncurated, the per-feat flag, and either half
    // of the taxonomy being hidden. The Type test is deliberately ANY, not ALL — a
    // hidden Type withholds a feat that also carries a visible one, which is the
    // symmetric reading and means a Type can be used to withdraw a slice of the
    // catalog outright.
    const hiddenByTaxonomy =
      hiddenCategories.has(feat.category) || (feat.types ?? []).some(t => hiddenTypes.has(t));
    if (!forGM && !keep.has(uuid) && (uncurated || feat.hidden || hiddenByTaxonomy)) continue;
    out.push({
      ...feat,
      ...source,
      // The GM's override wins over the auto-derived teaser. Spread order matters:
      // ...source would otherwise clobber it with the description-derived text.
      summary: feat.summary?.trim() || source.summary,
      uncurated,
      categoryLabel: uncurated
        ? null
        : taxonomyLabel(categories.find(c => c.id === feat.category)) || feat.category
    });
  }

  return out;
}

/** Localized labels for a feat's ticked types, for display and search. */
export function typeLabels(feat) {
  const all = getTypes();
  const categories = getCategories();
  return (feat.types ?? []).map(id => {
    const entry = all.find(t => t.id === id);
    if (entry) return taxonomyLabel(entry);
    const cat = categories.find(c => `category:${c.id}` === id);
    return cat ? taxonomyLabel(cat) : id;
  });
}

/* ── Mutations (GM only) ───────────────────────────────────────────────────── */

/** Registers a compendium as a Feat source. */
export async function addSource(packId) {
  const registry = foundry.utils.deepClone(getRegistry());
  registry.sources ??= [];
  if (registry.sources.some(s => s.packId === packId)) return registry;
  registry.sources.push({ packId, enabled: true });
  await setRegistry(registry);
  return registry;
}

export async function removeSource(packId) {
  const registry = foundry.utils.deepClone(getRegistry());
  registry.sources = (registry.sources ?? []).filter(s => s.packId !== packId);
  await setRegistry(registry);
  return registry;
}

/** Registers a single Feature item as a Feat, uncurated. */
export async function addFeat(uuid) {
  const registry = foundry.utils.deepClone(getRegistry());
  registry.feats ??= {};
  if (!registry.feats[uuid]) registry.feats[uuid] = blankFeat(uuid);
  await setRegistry(registry);
  return registry;
}

/**
 * Writes ONE feat's entry through to the saved registry, leaving every other key of
 * the setting exactly as it is on disk.
 *
 * This is the Curation tab's File action, and the surgical shape is the whole point.
 * The registry app holds a working copy of four settings and commits all of them on
 * Save; if File reused that path, filing one feat would also push a half-renamed
 * Category, an unsure new source and an untested point formula live to players — and
 * the unsaved-changes prompt would stop firing, because everything had been committed
 * through a side door.
 *
 * Reads the saved value fresh rather than taking a caller-supplied registry, so a
 * concurrent GM edit elsewhere is merged into rather than overwritten.
 *
 * @param {string} uuid
 * @param {object} entry  the feat record from the caller's working copy
 * @returns {Promise<void>}
 */
export async function saveFeatEntry(uuid, entry) {
  const registry = foundry.utils.deepClone(getRegistry());
  registry.feats ??= {};
  registry.feats[uuid] = foundry.utils.deepClone(entry);
  await setRegistry(registry);
}

export async function removeFeat(uuid) {
  const registry = foundry.utils.deepClone(getRegistry());
  delete registry.feats?.[uuid];
  await setRegistry(registry);
  return registry;
}

/**
 * Drops registry entries whose source item no longer resolves and which belong to no
 * registered pack. Mirrors the reputation-tracker's cleanupOrphanedRelations.
 * @returns {Promise<string[]>}  the UUIDs that were pruned
 */
export async function pruneOrphans() {
  const registry = foundry.utils.deepClone(getRegistry());
  const sources = await loadAllSourceFeatures(registry);
  const pruned = [];

  for (const uuid of Object.keys(registry.feats ?? {})) {
    if (sources.has(uuid)) continue;
    if (await resolveQuietly(uuid)) continue;
    delete registry.feats[uuid];
    pruned.push(uuid);
  }

  if (pruned.length) {
    await setRegistry(registry);
    console.warn(`${MODULE_ID} | Pruned ${pruned.length} orphaned feat entries.`);
  }
  return pruned;
}
