/**
 * resync.mjs
 * Pushing a changed source Feature back out to the characters who already own it.
 *
 * An acquired Feat is an independent COPY (grantFeat does source.toObject() and embeds
 * it), which is what makes it behave like any other Feature and what makes revoke able
 * to delete exactly the right item. The cost of that is a buff or nerf to the source
 * never reaching characters who already bought it. This file is the deliberate,
 * GM-triggered bridge across that gap.
 *
 * It is a FULL replace: name, image, description, actions, effects. A buff usually
 * lives in an action or an effect, so refreshing only the text would miss the point.
 * The embedded item keeps its `_id` and its sort order, so the acquisition record
 * (which stores that id) stays valid and nothing has to be revoked and re-granted.
 *
 * Data layer only — no imports from apps/. The hooks that call into the cache
 * invalidation below are registered in the catalog app, which may import downwards.
 */

import { MODULE_ID, ACTOR_TYPES, ITEM_TYPES } from '../constants.mjs';
import { getRegistry } from '../settings.mjs';
import { invalidateDescription, invalidatePackCache, resolveQuietly } from './registry.mjs';
import { acquisitionOf, getState } from './actor-state.mjs';

/** Every player character in the world. */
function characters() {
  return game.actors?.filter(a => a.type === ACTOR_TYPES.PC) ?? [];
}

/**
 * How much work a re-sync would be, without doing any of it. Feeds the confirmation
 * dialog, so a GM is told what they are about to overwrite before they agree to it.
 *
 * @param {string[]|null} [uuids]  defaults to every registered feat
 * @returns {{feats: number, characters: number, acquisitions: number}}
 */
export function countAffected(uuids = null) {
  const list = uuids ?? Object.keys(getRegistry().feats ?? {});
  const wanted = new Set(list);
  const touchedFeats = new Set();
  const touchedActors = new Set();
  let acquisitions = 0;

  for (const actor of characters()) {
    for (const entry of getState(actor).acquired) {
      if (!wanted.has(entry.uuid) || !entry.itemId) continue;
      if (!actor.items.get(entry.itemId)) continue;
      touchedFeats.add(entry.uuid);
      touchedActors.add(actor.id);
      acquisitions++;
    }
  }

  return { feats: touchedFeats.size, characters: touchedActors.size, acquisitions };
}

/**
 * Rewrites every owner's copy of one feat from its source.
 *
 * @param {string} uuid
 * @param {object} [options]
 * @param {Actor[]} [options.actors]  pre-filtered actor list, to avoid re-scanning
 * @returns {Promise<{uuid: string, updated: number, missing?: boolean}>}
 */
export async function resyncFeat(uuid, { actors = null } = {}) {
  const source = await resolveQuietly(uuid);
  if (!source) return { uuid, updated: 0, missing: true };

  const template = source.toObject();
  delete template._id;

  let updated = 0;
  for (const actor of actors ?? characters()) {
    const entry = acquisitionOf(getState(actor), uuid);
    if (!entry?.itemId) continue;
    const item = actor.items.get(entry.itemId);
    if (!item) continue;

    try {
      await actor.updateEmbeddedDocuments(
        'Item',
        [
          {
            ...template,
            _id: item.id,
            // Keeping the existing sort stops a re-sync from reshuffling the sheet.
            sort: item.sort,
            _stats: { ...(template._stats ?? {}), compendiumSource: uuid },
            // The same three overrides grantFeat applies, for the same reason:
            // originItemType null is what routes a Feat into the generic Features
            // fieldset (DhCharacter.sheetLists, build/daggerheart.js:33319).
            system: {
              ...(template.system ?? {}),
              originItemType: null,
              identifier: null,
              multiclassOrigin: false
            }
          }
        ],
        // recursive:false replaces sub-objects instead of merging them, so an action or
        // effect REMOVED from the source is actually removed from the copy. A merging
        // update would leave deleted content behind for ever.
        { diff: false, recursive: false }
      );
      updated++;
    } catch (err) {
      console.error(`${MODULE_ID} | Re-sync failed for ${uuid} on ${actor.name}:`, err);
    }
  }

  return { uuid, updated };
}

/**
 * Re-syncs many feats in one pass. The actor list is resolved once and reused, because
 * the scan is per-feat-per-actor and a large world would otherwise re-filter constantly.
 *
 * @param {object} [options]
 * @param {string[]|null} [options.uuids]  defaults to every registered feat
 * @returns {Promise<{feats: number, updated: number, missing: string[]}>}
 */
export async function resyncAll({ uuids = null } = {}) {
  const list = uuids ?? Object.keys(getRegistry().feats ?? {});
  const actors = characters();
  const missing = [];
  let feats = 0;
  let updated = 0;

  for (const uuid of list) {
    const result = await resyncFeat(uuid, { actors });
    if (result.missing) {
      missing.push(uuid);
      continue;
    }
    if (result.updated) {
      feats++;
      updated += result.updated;
    }
  }

  return { feats, updated, missing };
}

/**
 * Called when a Feature document changes anywhere in the world or a compendium.
 *
 * This is the other half of the staleness problem: the catalog reads names and teasers
 * from a cached pack index, and an expanded row's enriched description was cached for
 * the session and never invalidated at all — so an edited Feature kept showing its old
 * text until a full reload.
 *
 * Embedded items are ignored on purpose. Granting a feat creates one, so reacting to
 * them would invalidate the caches on every acquisition for no gain.
 *
 * @param {Document} doc
 * @returns {boolean}  true when the caches were actually dropped
 */
export function onFeatureDocumentChanged(doc) {
  if (doc?.documentName !== 'Item' || doc.type !== ITEM_TYPES.FEATURE) return false;
  if (doc.isEmbedded) return false;
  invalidateDescription(doc.uuid);
  invalidatePackCache();
  return true;
}
