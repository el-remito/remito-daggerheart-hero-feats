/**
 * badge.mjs
 * The Feat Point badge injected beside Level on the Daggerheart character sheet.
 *
 * Anchor (verified against daggerheart 2.7.1,
 * templates/sheets/actors/character/header.hbs:12-38):
 *     .character-header-sheet .name-row .level-div h3.label
 * That h3 is a baseline-aligned flex row holding the "Level" label and the level input,
 * so appending to it puts the badge immediately after the number.
 *
 * Under LIMITED permission the header part is not rendered at all (the sheet swaps to
 * limited.hbs), so a missing anchor is a normal outcome, not an error.
 */

import { MODULE_ID, ACTOR_TYPES, PREFIX, LEVEL_ANCHOR } from '../constants.mjs';
import { getPointPool } from '../data/actor-state.mjs';

const BADGE_CLASS = `${PREFIX}-badge`;

/**
 * @param {ActorSheetV2} app   the sheet application; the actor is app.document, not app.actor
 * @param {HTMLElement|jQuery} html
 */
export function injectBadge(app, html) {
  const actor = app?.document;
  if (actor?.type !== ACTOR_TYPES.PC) return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // Idempotent: the sheet re-renders per-part, so strip our own node before re-adding.
  root.querySelector(`.${BADGE_CLASS}`)?.remove();

  const anchor = root.querySelector(LEVEL_ANCHOR);
  if (!anchor) return; // limited view, or the system moved the header

  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  badge.dataset.actorId = actor.id;
  badge.dataset.tooltip = game.i18n.localize('RDHF.badge.tooltip');
  badge.innerHTML = '<i class="fa-solid fa-award"></i>';

  if (actor.isOwner || game.user.isGM) {
    badge.classList.add(`${BADGE_CLASS}--interactive`);
    badge.addEventListener('click', ev => {
      // The header rows carry their own click handlers — do not let this bubble.
      ev.preventDefault();
      ev.stopPropagation();
      openCatalogFor(actor);
    });
  }

  anchor.appendChild(badge);

  // The pool needs an async formula evaluation. Deliberately not awaited: the badge is
  // already in the DOM, and the glow is a decoration that can land a tick later.
  applyGlow(badge, actor);
}

/** Adds the unspent/overspent state once the point pool resolves. */
async function applyGlow(badge, actor) {
  try {
    const pool = await getPointPool(actor);
    if (!badge.isConnected) return; // sheet re-rendered while we were awaiting

    if (pool.overspent) {
      badge.classList.add(`${BADGE_CLASS}--overspent`);
      badge.dataset.tooltip = game.i18n.format('RDHF.badge.overspent', {
        over: Math.abs(pool.remaining)
      });
    } else if (pool.remaining > 0) {
      badge.classList.add(`${BADGE_CLASS}--unspent`);
      badge.dataset.tooltip = game.i18n.format('RDHF.badge.unspent', {
        remaining: pool.remaining
      });
    } else {
      badge.dataset.tooltip = game.i18n.format('RDHF.badge.spent', { total: pool.total });
    }
  } catch (err) {
    // A malformed formula must never break the sheet — the plain badge still opens.
    console.warn(`${MODULE_ID} | Could not resolve Feat Points for ${actor.name}:`, err);
  }
}

/** Lazily imported so the badge module carries no load-time dependency on the app. */
async function openCatalogFor(actor) {
  const { openCatalog } = await import('../apps/feat-catalog.mjs');
  openCatalog(actor);
}
