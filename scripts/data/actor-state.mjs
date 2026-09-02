/**
 * actor-state.mjs
 * The only file that reads or writes actor flags, plus the actor -> snapshot bridge
 * that keeps scripts/logic/ free of Foundry APIs.
 *
 * Actor flag shape — actor.flags["remito-daggerheart-hero-feats"].state:
 *   {
 *     acquired: [{ uuid, itemId, free, at }],
 *     pointAdjustment: 0
 *   }
 *
 * `acquired` is an ARRAY, and that is load-bearing. Foundry's expandObject
 * (common/utils/helpers.mjs) recurses into every plain object and runs setProperty on
 * each key, so a key containing dots is exploded into nested objects at every level.
 * Item UUIDs are full of dots ("Compendium.daggerheart.classes.Item.abc"), so keying
 * this map by UUID silently turned one entry into five nested levels: reads never
 * matched, the idempotency guard never fired, and the spent count only ever saw the
 * single "Compendium" key. Arrays are mapped element-wise, so a UUID held in a VALUE
 * is safe. Never key a flag object by UUID.
 *
 * `itemId` is the embedded Item this acquisition created, so a revoke deletes exactly
 * that item and nothing else (the skill-tree module's grantedItems pattern).
 */

import { MODULE_ID, FLAGS, TRAITS, RESOURCE_REQS, ACTOR_TYPES } from '../constants.mjs';
import { getPointFormula, getCategories, getRegistry, taxonomyLabel } from '../settings.mjs';
import { normalizeFeat } from './registry.mjs';
import { computePool } from '../logic/points.mjs';

/** Every player character in the world. The one definition, shared by every caller. */
export function characters() {
  return game.actors?.filter(a => a.type === ACTOR_TYPES.PC) ?? [];
}

/* ── Flag access ───────────────────────────────────────────────────────────── */

const BLANK_STATE = { acquired: [], pointAdjustment: 0 };

/**
 * Rebuilds the acquisition list from the mangled nested object that the pre-array
 * flag shape left behind. The original UUID is exactly the path to each leaf, so this
 * is lossless — worlds that acquired feats before the fix keep them.
 */
function recoverLegacyAcquired(node, path = [], out = []) {
  if (!node || typeof node !== 'object') return out;
  const isLeaf =
    Object.hasOwn(node, 'itemId') || Object.hasOwn(node, 'at') || Object.hasOwn(node, 'free');
  if (isLeaf && path.length) {
    out.push({
      uuid: path.join('.'),
      itemId: node.itemId ?? null,
      free: node.free === true,
      at: Number(node.at) || 0
    });
    return out;
  }
  for (const [key, value] of Object.entries(node)) recoverLegacyAcquired(value, [...path, key], out);
  return out;
}

/**
 * Deep-cloned so a caller cannot accidentally mutate the cached flag object.
 * @param {Actor} actor
 * @returns {{acquired: Array<{uuid: string, itemId: string|null, free: boolean, at: number}>,
 *            pointAdjustment: number}}
 */
export function getState(actor) {
  const stored = actor?.getFlag(MODULE_ID, FLAGS.STATE);
  if (!stored) return foundry.utils.deepClone(BLANK_STATE);

  const raw = stored.acquired;
  const acquired = Array.isArray(raw)
    ? foundry.utils.deepClone(raw).filter(e => e?.uuid)
    : recoverLegacyAcquired(raw);

  return { acquired, pointAdjustment: Number(stored.pointAdjustment) || 0 };
}

/** The acquisition entry for one feat, or undefined. */
export function acquisitionOf(state, uuid) {
  return state.acquired.find(e => e.uuid === uuid);
}

async function setState(actor, state) {
  return actor.setFlag(MODULE_ID, FLAGS.STATE, state);
}

export function isAcquired(actor, uuid) {
  return Boolean(acquisitionOf(getState(actor), uuid));
}

/* ── Roll data ─────────────────────────────────────────────────────────────── */

/**
 * Daggerheart's getRollData() exposes `prof` and `cast` at the top level but nests
 * tier and level under `system` (DhpActor.getRollData, build/daggerheart.js:16493 →
 * DhCharacter.getRollData, :33564). Writing "@system.level * 2" is a poor thing to ask
 * of a GM, so friendly top-level aliases are added here. The real @system.* paths keep
 * working untouched.
 *
 * The base object is a shallow proxy, so it is copied key-by-key rather than spread.
 * @param {Actor} actor
 * @returns {object}
 */
export function featRollData(actor) {
  const base = actor.getRollData() ?? {};
  const data = foundry.utils.mergeObject({}, base, { inplace: false });
  data.level ??= actor.system?.levelData?.level?.current ?? 1;
  data.tier ??= actor.system?.tier ?? 1;
  data.prof ??= actor.system?.proficiency ?? 1;
  return data;
}

/**
 * Evaluates the world point formula for one actor.
 * Delegates to Foundry's Roll — never eval() or new Function() — so a GM's formula can
 * only ever be dice/maths, not arbitrary code.
 * @param {Actor} actor
 * @returns {Promise<number>}  0 on a malformed formula, with a console warning
 */
export async function evaluatePointFormula(actor) {
  const formula = getPointFormula();
  try {
    const roll = new Roll(String(formula), featRollData(actor));
    await roll.evaluate();
    const total = roll.total;
    if (!Number.isFinite(total)) throw new Error(`"${formula}" did not evaluate to a number.`);
    return Math.floor(total);
  } catch (err) {
    console.warn(`${MODULE_ID} | Invalid Feat Point formula "${formula}":`, err);
    return 0;
  }
}

/**
 * The actor's full Feat Point picture.
 * @param {Actor} actor
 * @returns {Promise<object>}  see logic/points.mjs computePool
 */
export async function getPointPool(actor) {
  const state = getState(actor);
  return computePool({
    formulaTotal: await evaluatePointFormula(actor),
    adjustment: state.pointAdjustment,
    acquired: state.acquired
  });
}

/* ── Snapshot ──────────────────────────────────────────────────────────────── */

/**
 * Flattens everything the pure requirement checker needs into plain values.
 * Reading class/subclass/ancestry/community goes through the system's own getters on
 * DhCharacter — they are embedded Items, not fields.
 *
 * @param {Actor} actor
 * @returns {object}
 */
export function buildActorSnapshot(actor) {
  const sys = actor.system ?? {};
  const state = getState(actor);
  const registry = getRegistry();
  const categories = getCategories();

  // Count acquired feats per Category, for "Investment in Category" requirements.
  const categoryCounts = {};
  for (const entry of state.acquired) {
    const category = normalizeFeat(entry.uuid, registry.feats?.[entry.uuid]).category;
    if (category) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }

  const resources = {};
  for (const [key, path] of Object.entries(RESOURCE_REQS)) {
    resources[key] = Number(foundry.utils.getProperty(sys, path)) || 0;
  }

  return {
    level: sys.levelData?.level?.current ?? 0,
    tier: sys.tier ?? 0,
    prof: sys.proficiency ?? 1,
    traits: Object.fromEntries(TRAITS.map(t => [t, Number(sys.traits?.[t]?.value) || 0])),
    resources,
    className: sys.class?.value?.name ?? null,
    subclassName: sys.class?.subclass?.name ?? null,
    multiclassName: sys.multiclass?.value?.name ?? null,
    multiclassSubclassName: sys.multiclass?.subclass?.name ?? null,
    ancestryName: sys.ancestry?.name ?? null,
    communityName: sys.community?.name ?? null,
    domains: (sys.domainData ?? []).map(d => game.i18n.localize(d.label ?? d.id)),
    // spellcastModifier is the trait's VALUE and is 0 for a non-caster — but also 0 for
    // a caster whose trait happens to be 0, so presence of the trait is the real test
    // (DhCharacter.spellcastModifierTrait, build/daggerheart.js:33114).
    hasSpellcasting: Boolean(
      sys.spellcastModifierTrait ?? sys.class?.subclass?.system?.spellcastingTrait
    ),
    featureNames: actor.items
      .filter(i => i.type === 'feature')
      .map(i => i.name.toLowerCase()),
    acquiredUuids: state.acquired.map(e => e.uuid),
    categoryCounts,
    categoryLabels: Object.fromEntries(categories.map(c => [c.id, taxonomyLabel(c)])),
    featLabels: {}
  };
}

/* ── Granting and revoking ─────────────────────────────────────────────────── */

/**
 * Embeds the Feature on the actor and records the acquisition.
 *
 * `originItemType: null` is deliberate: DhCharacter.sheetLists
 * (build/daggerheart.js:33319) routes any feature without an originItemType into the
 * generic "Features" fieldset, which is exactly where an acquired Feat belongs.
 * `_stats.compendiumSource` matches how the system stamps its own cascaded features
 * (BaseDataItem._preCreate, :14716), keeping the compendium link intact.
 *
 * @param {Actor} actor
 * @param {string} uuid
 * @param {object} [options]
 * @param {boolean} [options.free]  a GM grant that does not charge a Feat Point
 * @returns {Promise<Item|null>}  the created item, or null on failure
 */
export async function grantFeat(actor, uuid, { free = false } = {}) {
  if (actor?.type !== ACTOR_TYPES.PC) return null;

  const state = getState(actor);
  if (acquisitionOf(state, uuid)) return null; // idempotency guard

  let source;
  try {
    source = await fromUuid(uuid);
  } catch (_) {
    source = null;
  }
  if (!source) {
    ui.notifications?.error(game.i18n.format('RDHF.notify.sourceMissing', { uuid }));
    return null;
  }

  let created = null;
  try {
    [created] = await actor.createEmbeddedDocuments('Item', [
      foundry.utils.mergeObject(
        source.toObject(),
        {
          _stats: { compendiumSource: uuid },
          system: { originItemType: null, identifier: null, multiclassOrigin: false }
        },
        { inplace: false }
      )
    ]);
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to embed feat ${uuid}:`, err);
    ui.notifications?.error(game.i18n.localize('RDHF.notify.grantFailed'));
    return null;
  }

  await setState(actor, {
    ...state,
    acquired: [...state.acquired, { uuid, itemId: created?.id ?? null, free, at: Date.now() }]
  });

  return created;
}

/**
 * GM-only. Deletes the item this acquisition created and forgets the acquisition,
 * refunding the point if one was charged.
 * @param {Actor} actor
 * @param {string} uuid
 * @returns {Promise<boolean>}
 */
export async function revokeFeat(actor, uuid) {
  const state = getState(actor);
  const entry = acquisitionOf(state, uuid);
  if (!entry) return false;

  if (entry.itemId && actor.items.get(entry.itemId)) {
    try {
      await actor.deleteEmbeddedDocuments('Item', [entry.itemId]);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not delete item ${entry.itemId}:`, err);
    }
  }

  await setState(actor, { ...state, acquired: state.acquired.filter(e => e.uuid !== uuid) });
  return true;
}

/**
 * GM-only per-actor point bonus or penalty.
 * @param {Actor} actor
 * @param {number} value
 */
export async function setPointAdjustment(actor, value) {
  const state = getState(actor);
  return setState(actor, { ...state, pointAdjustment: Number(value) || 0 });
}
