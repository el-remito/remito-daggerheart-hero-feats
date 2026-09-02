/**
 * remito-daggerheart-hero-feats
 * Entry point: settings, hooks, module API.
 *
 * No build step and no bundler — Foundry loads this module directly, and every import
 * below is a plain ES module path.
 */

import { MODULE_ID, PREFIX, TEMPLATES, ACTOR_TYPES, SETTINGS } from './scripts/constants.mjs';
import { registerSettings, registerRegistryMenu } from './scripts/settings.mjs';
import { FeatRegistryConfig } from './scripts/apps/feat-registry-config.mjs';
import { FeatCatalog, openCatalog, registerCatalogHooks } from './scripts/apps/feat-catalog.mjs';
import { injectBadge } from './scripts/badge/badge.mjs';
import { grantFeat, revokeFeat, getPointPool, buildActorSnapshot } from './scripts/data/actor-state.mjs';
import { listFeats, pruneOrphans, invalidatePackCache } from './scripts/data/registry.mjs';
import { runMigrations } from './scripts/data/migrations.mjs';
import { resyncFeat, resyncAll, countAffected } from './scripts/data/resync.mjs';

Hooks.once('init', () => {
  registerSettings();
  registerRegistryMenu(FeatRegistryConfig);
  foundry.applications.handlebars.loadTemplates(Object.values(TEMPLATES));
});

Hooks.once('ready', async () => {
  if (game.system.id !== 'daggerheart') {
    console.warn(`${MODULE_ID} | Inactive: this module requires the Daggerheart system.`);
    return;
  }

  registerCatalogHooks();
  invalidatePackCache();

  // Awaited before the API is exposed, so nothing renders a taxonomy that is about
  // to change under it. Foundry does not await the hook itself, but the ordering
  // within this callback is what matters.
  await runMigrations();

  // The badge must survive every sheet re-render, so it re-injects on each one.
  // renderActorSheet never fires in v14 — renderActorSheetV2 is the live hook, and it
  // hands over the sheet application whose `document` is the actor.
  Hooks.on('renderActorSheetV2', injectBadge);

  // Re-render open sheets when our own flags or the character's level move.
  Hooks.on('updateActor', (actor, changes) => {
    if (!changes.flags?.[MODULE_ID] && !changes.system?.levelData) return;
    // foundry.applications.instances, not the legacy ui.windows registry — an
    // ApplicationV2 sheet never appears in the latter.
    for (const app of foundry.applications.instances.values()) {
      if (app.document?.id === actor.id) app.render(false);
    }
  });

  // Toggling the Statistics tab has to reach a registry that is already open. This is
  // a hook rather than the setting's own onChange: onChange is supplied at
  // registration time, and wiring it there would make settings.mjs import from apps/,
  // against the module's one-way import rule.
  Hooks.on('updateSetting', setting => {
    if (setting?.key !== `${MODULE_ID}.${SETTINGS.SHOW_STATS}`) return;
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof FeatRegistryConfig) app.render();
    }
  });

  game.modules.get(MODULE_ID).api = {
    openCatalog,
    openRegistry: () => new FeatRegistryConfig().render(true),
    grantFeat,
    revokeFeat,
    getPointPool,
    buildActorSnapshot,
    listFeats,
    pruneOrphans,
    resyncFeat,
    resyncAll,
    countAffected
  };

  console.log(`${MODULE_ID} | Ready.`);
});

/** A second way into the registry, next to Foundry's own settings entries. */
Hooks.on('renderSettings', (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const section = root?.querySelector('#settings-game');
  if (!section || section.querySelector(`.${PREFIX}-open-registry`)) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add(`${PREFIX}-open-registry`);
  button.innerHTML = `<i class="fa-solid fa-award"></i> ${game.i18n.localize('RDHF.registry.title')}`;
  button.addEventListener('click', () => new FeatRegistryConfig().render(true));
  section.appendChild(button);
});

export { FeatCatalog, FeatRegistryConfig, ACTOR_TYPES };
