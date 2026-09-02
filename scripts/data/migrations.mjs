/**
 * migrations.mjs
 * One-way world data migrations, run once each by the GM on `ready`.
 *
 * The stored version is a plain integer in the `migration` world setting. Every
 * migration is written to be safe to re-run, but the version guard means it should not
 * have to be: a migration that throws leaves the version untouched and is retried next
 * load rather than half-applying and being forgotten.
 *
 * Only a GM may write world settings, so this is a no-op for players — which is why
 * every read path (getCategories, normalizeFeat) also tolerates un-migrated data.
 */

import { MODULE_ID, MIGRATION_VERSION, GENERAL_CATEGORY_ID, SETTINGS } from '../constants.mjs';
import {
  getRegistry,
  setRegistry,
  getCategories,
  setCategories,
  getTypes,
  setTypes
} from '../settings.mjs';

/**
 * Runs every migration this world has not seen yet.
 * @returns {Promise<void>}
 */
export async function runMigrations() {
  if (!game.user.isGM) return;

  const from = Number(game.settings.get(MODULE_ID, SETTINGS.MIGRATION)) || 0;
  if (from >= MIGRATION_VERSION) return;

  try {
    if (from < 1) await migrateGeneralTypeToCategory();
    await game.settings.set(MODULE_ID, SETTINGS.MIGRATION, MIGRATION_VERSION);
    console.log(`${MODULE_ID} | Migrated world data ${from} → ${MIGRATION_VERSION}.`);
  } catch (err) {
    // Deliberately leaves the version alone so the next load tries again.
    console.error(`${MODULE_ID} | Migration ${from} → ${MIGRATION_VERSION} failed:`, err);
    ui.notifications?.error(game.i18n.localize('RDHF.notify.migrationFailed'));
  }
}

/**
 * Migration 1 — "General" stops being a Type and becomes the fixed Category.
 *
 * A type could never lift a feat out of uncurated, so "General" as a type left GMs with
 * feats that were tagged but still invisible to players. As a Category it does the job
 * it was always meant to do.
 *
 * Order matters: file the feats first, then drop the type, so nothing is stranded.
 */
async function migrateGeneralTypeToCategory() {
  // getCategories() re-inserts the fixed General entry, so reading and writing it back
  // is what actually persists it into the world.
  const categories = getCategories();
  await setCategories(categories);

  const types = getTypes();
  const remaining = types.filter(t => t?.id !== GENERAL_CATEGORY_ID);

  const registry = foundry.utils.deepClone(getRegistry());
  let filed = 0;
  let stripped = 0;

  for (const feat of Object.values(registry.feats ?? {})) {
    if (!Array.isArray(feat.types) || !feat.types.includes(GENERAL_CATEGORY_ID)) continue;
    // Only an *uncategorised* feat is filed under General — a GM who already sorted a
    // General-typed feat into a real Category meant that Category.
    if (!feat.category) {
      feat.category = GENERAL_CATEGORY_ID;
      filed++;
    }
    feat.types = feat.types.filter(t => t !== GENERAL_CATEGORY_ID);
    stripped++;
  }

  if (stripped) await setRegistry(registry);
  if (remaining.length !== types.length) await setTypes(remaining);

  if (filed || stripped) {
    ui.notifications?.info(
      game.i18n.format('RDHF.notify.migratedGeneral', { filed, stripped })
    );
  }
}
