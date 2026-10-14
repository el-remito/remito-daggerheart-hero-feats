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
import { getPointPool, pendingFor } from '../data/actor-state.mjs';

const BADGE_CLASS = `${PREFIX}-badge`;

/** The three glow states, strongest first. Exactly one is painted at a time. */
const GLOWS = ['pending', 'overspent', 'unspent'].map(state => `${BADGE_CLASS}--${state}`);

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

/**
 * Repaints every badge on screen in place, without re-rendering a sheet.
 *
 * A change to an owned Feat arrives as a REGISTRY setting write, not an actor update,
 * so no sheet re-renders by itself — and re-rendering every open sheet to recolour one
 * 20px circle would be the flicker the rest of this module goes out of its way to avoid.
 * Called from the updateSetting hook in hero-feats.mjs.
 */
export function repaintBadges() {
  for (const badge of document.querySelectorAll(`.${BADGE_CLASS}[data-actor-id]`)) {
    const actor = game.actors?.get(badge.dataset.actorId);
    if (actor) applyGlow(badge, actor);
  }
}

/**
 * Paints the glow once the point pool resolves.
 *
 * ONE ring, strongest state first: a change waiting on Keep or Refund, then overspent,
 * then unspent. The pending decision outranks the points because it is the one with an
 * action attached — and refunding the changed Feat is often what cures an overspend —
 * while unspent points can wait for ever. The tooltip still states every fact that
 * applies, so the ring hides nothing it outranks.
 */
async function applyGlow(badge, actor) {
  let pending = [];
  try {
    pending = pendingFor(actor);
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not read changed Feats for ${actor.name}:`, err);
  }

  let pool = null;
  try {
    pool = await getPointPool(actor);
  } catch (err) {
    // A malformed formula must never break the sheet — the plain badge still opens.
    console.warn(`${MODULE_ID} | Could not resolve Feat Points for ${actor.name}:`, err);
  }
  if (!badge.isConnected) return; // sheet re-rendered while we were awaiting

  const lines = [];
  let glow = null;
  if (pending.length) {
    glow = 'pending';
    lines.push(game.i18n.format('RDHF.badge.pending', { count: pending.length }));
  }
  if (pool?.overspent) {
    glow ??= 'overspent';
    lines.push(game.i18n.format('RDHF.badge.overspent', { over: Math.abs(pool.remaining) }));
  } else if (pool && pool.remaining > 0) {
    glow ??= 'unspent';
    lines.push(game.i18n.format('RDHF.badge.unspent', { remaining: pool.remaining }));
  } else if (pool) {
    lines.push(game.i18n.format('RDHF.badge.spent', { total: pool.total }));
  }

  badge.classList.remove(...GLOWS);
  if (glow) badge.classList.add(`${BADGE_CLASS}--${glow}`);
  badge.dataset.tooltip = lines.length ? lines.join(' · ') : game.i18n.localize('RDHF.badge.tooltip');
}

/** Lazily imported so the badge module carries no load-time dependency on the app. */
async function openCatalogFor(actor) {
  const { openCatalog } = await import('../apps/feat-catalog.mjs');
  openCatalog(actor);
}
