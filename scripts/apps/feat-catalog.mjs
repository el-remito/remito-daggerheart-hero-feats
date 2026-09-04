/**
 * feat-catalog.mjs
 * The player-facing Feat catalog: a filter rail on the left, a scrollable list of
 * expandable feat rows on the right, and a sticky Feat Point bar across the top.
 *
 * Two rules govern this window, both learned from sibling modules:
 *   • Filtering NEVER re-renders. Rows are hidden in place, because a re-render on
 *     every keystroke steals focus from the search box.
 *   • Row open-state is captured and restored across the re-renders that DO happen
 *     (acquisitions), keyed by uuid rather than index.
 */

import { MODULE_ID, PREFIX, TEMPLATES, ACTOR_TYPES } from '../constants.mjs';
import { getCategories, getTypes, taxonomyLabel } from '../settings.mjs';
import { listFeats, typeLabels, getEnrichedDescription } from '../data/registry.mjs';
import { onFeatureDocumentChanged } from '../data/resync.mjs';
import {
  acquisitionOf,
  buildActorSnapshot,
  getPointPool,
  getState,
  grantFeat,
  revokeFeat,
  setPointAdjustment
} from '../data/actor-state.mjs';
import { isEligible } from '../logic/requirements.mjs';
import { matchesFilters, blankFilterState, buildSearchText, byLevelThenName } from '../logic/filters.mjs';
import { localizeCheck } from './requirement-text.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** actorId -> open catalog. One window per actor. */
export const openCatalogs = new Map();

/**
 * Opens (or focuses) the catalog for an actor.
 * @param {Actor} actor
 * @returns {FeatCatalog|null}
 */
export function openCatalog(actor) {
  if (actor?.type !== ACTOR_TYPES.PC) return null;
  const existing = openCatalogs.get(actor.id);
  if (existing) {
    existing.render(true);
    existing.bringToFront?.();
    return existing;
  }
  const app = new FeatCatalog(actor);
  return app.render(true);
}

/** Re-renders any open catalog for this actor. */
export function refreshCatalog(actorId) {
  openCatalogs.get(actorId)?.render();
}

export class FeatCatalog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this._filters = blankFilterState();
    this._openRows = new Set();
    // Whether each collapsible rail section is expanded, keyed by data-rail rather than
    // by index so reordering the rail cannot silently swap the two. Both start open:
    // a filter the player cannot see is a filter they will not think to clear.
    this._railOpen = { types: true, categories: true };
    // 'available' | 'acquired'. Switching tabs is a pure DOM toggle in _applyFilters,
    // never a re-render, so the filter rail keeps its state and the search box its focus.
    this._tab = 'available';
  }

  static DEFAULT_OPTIONS = {
    classes: ['daggerheart', 'dh-style', PREFIX, `${PREFIX}-catalog`],
    tag: 'div',
    window: {
      frame: true,
      positioned: true,
      title: 'RDHF.catalog.title',
      icon: 'fa-solid fa-award',
      minimizable: true,
      resizable: true
    },
    // Must be a fixed integer — "auto" makes the page scroll instead of the window.
    position: { width: 980, height: 720 },
    actions: {
      acquireFeat: FeatCatalog._onAcquire,
      grantAnyway: FeatCatalog._onGrantAnyway,
      revokeFeat: FeatCatalog._onRevoke,
      adjustPoints: FeatCatalog._onAdjustPoints,
      clearFilters: FeatCatalog._onClearFilters,
      selectTab: FeatCatalog._onSelectTab
    }
  };

  static PARTS = { main: { template: TEMPLATES.CATALOG } };

  get id() {
    return `${PREFIX}-catalog-${this.actor.id}`;
  }

  get title() {
    return `${game.i18n.localize('RDHF.catalog.title')} — ${this.actor.name}`;
  }

  /** @override — refuse to open for someone who may not see this actor. */
  render(options) {
    if (!this.actor.isOwner && !game.user.isGM) {
      ui.notifications?.warn(game.i18n.localize('RDHF.notify.noPermission'));
      return this;
    }
    openCatalogs.set(this.actor.id, this);
    this._captureOpenRows();
    this._captureRails();
    return super.render(options);
  }

  async close(options) {
    openCatalogs.delete(this.actor.id);
    return super.close(options);
  }

  /** Remembers which rows were expanded, so a re-render does not collapse them. */
  _captureOpenRows() {
    if (!this.element) return;
    this._openRows = new Set(
      [...this.element.querySelectorAll(`.${PREFIX}-feat[open]`)].map(el => el.dataset.uuid)
    );
  }

  /** Same, for the collapsible rail sections. Keyed by data-rail, never by index. */
  _captureRails() {
    if (!this.element) return;
    for (const rail of this.element.querySelectorAll(`.${PREFIX}-rail-details[data-rail]`)) {
      this._railOpen[rail.dataset.rail] = rail.open;
    }
  }

  async _prepareContext(_options) {
    const isGM = game.user.isGM;
    const snapshot = buildActorSnapshot(this.actor);
    const pool = await getPointPool(this.actor);
    const state = getState(this.actor);
    // A hidden taxonomy entry is dropped from the rail for players, because listFeats
    // has already withheld everything it could have matched — an entry that can only
    // ever filter to zero rows is worse than absent. The GM keeps every entry: they
    // are also the person who has to find the feats they just withdrew.
    const showAll = isGM;
    const categories = getCategories().filter(c => showAll || !c?.hidden);
    const types = getTypes().filter(t => showAll || !t?.hidden);

    // keepUuids: a feat this character already owns stays listed even if the GM has
    // since hidden it or cleared its Category. Otherwise "My Feats" would lose rows.
    const feats = await listFeats({
      forGM: isGM,
      keepUuids: state.acquired.map(e => e.uuid)
    });
    // So a requirement that references another Feat by UUID renders as its name
    // rather than as a raw "Compendium.pack.Item.abc123".
    snapshot.featLabels = Object.fromEntries(feats.map(f => [f.uuid, f.name]));

    const views = feats
      .map(feat => {
        const evaluation = isEligible(feat, snapshot, pool.remaining);
        const labels = typeLabels(feat);
        const view = {
          ...feat,
          typeLabels: labels,
          typesAttr: (feat.types ?? []).join('|'),
          isGM,
          checks: evaluation.checks.map(localizeCheck),
          eligible: evaluation.ok,
          owned: evaluation.owned,
          unmetCount: evaluation.failures.length,
          free: acquisitionOf(state, feat.uuid)?.free === true,
          hidden: feat.hidden === true,
          isOpen: this._openRows.has(feat.uuid)
        };
        view.searchText = buildSearchText(view);
        return view;
      })
      .sort(byLevelThenName);

    const available = views.filter(v => !v.owned);
    const acquired = views.filter(v => v.owned);

    return {
      actor: this.actor,
      isGM,
      pool,
      available,
      acquired,
      acquiredCount: acquired.length,
      tab: this._tab,
      isAvailableTab: this._tab === 'available',
      isAcquiredTab: this._tab === 'acquired',
      hasFeats: views.length > 0,
      // The rail renders its OWN state. Filtering never re-renders, so for a long time
      // the only way a box could be ticked was the player ticking it and nothing had to
      // be carried; but the catalog does re-render on an acquisition and on any module
      // setting change, and without this the boxes came back empty while _applyFilters
      // went on filtering — a rail contradicting the row count below it.
      categories: categories.map(c => ({
        id: c.id,
        label: taxonomyLabel(c),
        icon: c.icon,
        checked: this._filters.categories.includes(c.id)
      })),
      types: types.map(t => ({
        id: t.id,
        label: taxonomyLabel(t),
        icon: t.icon,
        checked: this._filters.types.includes(t.id)
      })),
      railOpen: this._railOpen,
      filters: this._filters
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // ── Filter rail: everything below filters IN PLACE, never by re-rendering.
    const search = el.querySelector(`.${PREFIX}-search`);
    search?.addEventListener('input', () => {
      this._filters.search = search.value;
      this._applyFilters();
    });

    for (const input of el.querySelectorAll('[data-filter]')) {
      const kind = input.dataset.filter;
      input.addEventListener('change', () => {
        if (kind === 'levelMin' || kind === 'levelMax') {
          this._filters[kind] = input.value === '' ? null : Number(input.value);
        } else if (kind === 'eligibleOnly' || kind === 'hideOwned') {
          this._filters[kind] = input.checked;
        } else if (kind === 'category' || kind === 'type') {
          const bucket = kind === 'category' ? 'categories' : 'types';
          const set = new Set(this._filters[bucket]);
          input.checked ? set.add(input.value) : set.delete(input.value);
          this._filters[bucket] = [...set];
        }
        this._applyFilters();
      });
    }

    // ── Lazy description loading on first expand.
    for (const row of el.querySelectorAll(`.${PREFIX}-feat`)) {
      row.addEventListener('toggle', () => {
        if (row.open) this._loadDescription(row);
      });
      if (row.open) this._loadDescription(row);
    }

    this._applyFilters();
  }

  /**
   * Shows or hides rows to match the current filter state and the active tab. Never
   * re-renders: both tabs' rows are in the DOM at once, and a tab switch is only a
   * change of which section is displayed.
   */
  _applyFilters() {
    const el = this.element;
    if (!el) return;
    let visible = 0;

    for (const section of el.querySelectorAll(`.${PREFIX}-section`)) {
      const active = section.dataset.section === this._tab;
      section.hidden = !active;
      if (!active) continue;
      for (const row of section.querySelectorAll(`.${PREFIX}-feat`)) {
        const show = matchesFilters(this._viewFor(row), this._filters);
        // Hide the <li>, not the <details> — hiding only the details would leave the
        // list item's own box behind as a gap in the list.
        (row.closest('li') ?? row).hidden = !show;
        if (show) visible++;
      }
    }

    // Each tab explains its own emptiness: "nothing matches" versus "nothing acquired".
    for (const empty of el.querySelectorAll('[data-empty]')) {
      empty.hidden = visible > 0 || empty.dataset.empty !== this._tab;
    }
    const count = el.querySelector(`.${PREFIX}-result-count`);
    if (count) count.textContent = String(visible);
  }

  /** Rebuilds the minimal view a filter needs, straight off the row's data attributes. */
  _viewFor(row) {
    return {
      level: Number(row.dataset.level) || 0,
      category: row.dataset.category || null,
      types: (row.dataset.types || '').split('|').filter(Boolean),
      owned: row.dataset.owned === 'true',
      eligible: row.dataset.eligible === 'true',
      searchText: row.dataset.search || ''
    };
  }

  async _loadDescription(row) {
    const body = row.querySelector(`.${PREFIX}-feat-description`);
    if (!body || body.dataset.loaded === 'true') return;
    body.dataset.loaded = 'true';
    body.innerHTML = await getEnrichedDescription(row.dataset.uuid, this.actor);
  }

  /* ── Actions ─────────────────────────────────────────────────────────────── */

  /**
   * The whitepaper's acquisition dialog: either confirm the spend, or explain exactly
   * why it cannot happen.
   */
  static async _onAcquire(event, target) {
    event.preventDefault();
    const uuid = target.closest(`.${PREFIX}-feat`)?.dataset.uuid;
    if (!uuid) return;

    const snapshot = buildActorSnapshot(this.actor);
    const pool = await getPointPool(this.actor);
    const feats = await listFeats({ forGM: game.user.isGM });
    const feat = feats.find(f => f.uuid === uuid);
    if (!feat) return;

    const evaluation = isEligible(feat, snapshot, pool.remaining);
    const name = foundry.utils.escapeHTML(feat.name);

    // Belt and braces: the flag is the authority on ownership, not the rendered row.
    if (acquisitionOf(getState(this.actor), uuid)) {
      ui.notifications?.warn(game.i18n.localize('RDHF.dialog.reasonOwned'));
      this.render();
      return;
    }

    if (!evaluation.ok) {
      const reasons = [];
      if (evaluation.owned) reasons.push(game.i18n.localize('RDHF.dialog.reasonOwned'));
      if (!evaluation.hasPoints) reasons.push(game.i18n.localize('RDHF.dialog.reasonNoPoints'));
      for (const failure of evaluation.failures) {
        reasons.push(foundry.utils.escapeHTML(localizeCheck(failure).label));
      }
      await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.localize('RDHF.dialog.ineligibleTitle') },
        content:
          `<p>${game.i18n.format('RDHF.dialog.ineligibleBody', { name })}</p>` +
          `<ul class="${PREFIX}-reasons">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`,
        ok: { label: game.i18n.localize('RDHF.dialog.close') }
      });
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.dialog.acquireTitle') },
      content:
        `<p>${game.i18n.format('RDHF.dialog.acquireBody', { name })}</p>` +
        `<p class="${PREFIX}-warning">${game.i18n.localize('RDHF.dialog.acquireWarning')}</p>`
    });
    if (!confirmed) return;

    this._captureOpenRows();
    await grantFeat(this.actor, uuid);
    this.render();
  }

  /** GM only. Grants without charging a point and without checking requirements. */
  static async _onGrantAnyway(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const uuid = target.closest(`.${PREFIX}-feat`)?.dataset.uuid;
    if (!uuid) return;

    // Two explicit buttons rather than a checkbox read back off button.form: whether a
    // grant charges a point decides whether the row later reads "Granted" or
    // "Acquired", and that is too visible an outcome to hang on a form lookup.
    // DialogV2.wait resolves to the pressed button's callback value.
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize('RDHF.dialog.grantTitle') },
      content: `<p>${game.i18n.localize('RDHF.dialog.grantBody')}</p>`,
      buttons: [
        {
          action: 'free',
          label: game.i18n.localize('RDHF.dialog.grantFree'),
          icon: 'fa-solid fa-gift',
          default: true,
          callback: () => 'free'
        },
        {
          action: 'charge',
          label: game.i18n.localize('RDHF.dialog.grantCharge'),
          icon: 'fa-solid fa-coins',
          callback: () => 'charge'
        },
        {
          action: 'cancel',
          label: game.i18n.localize('RDHF.dialog.cancel'),
          icon: 'fa-solid fa-xmark',
          callback: () => null
        }
      ],
      rejectClose: false
    });
    if (choice !== 'free' && choice !== 'charge') return;

    this._captureOpenRows();
    await grantFeat(this.actor, uuid, { free: choice === 'free' });
    this.render();
  }

  /** GM only. Deletes the granted item and refunds the point. */
  static async _onRevoke(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const row = target.closest(`.${PREFIX}-feat`);
    const uuid = row?.dataset.uuid;
    if (!uuid) return;

    const name = foundry.utils.escapeHTML(row.dataset.name ?? uuid);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.dialog.revokeTitle') },
      content: `<p>${game.i18n.format('RDHF.dialog.revokeBody', { name })}</p>`
    });
    if (!confirmed) return;

    this._captureOpenRows();
    await revokeFeat(this.actor, uuid);
    this.render();
  }

  /** GM only. Nudges the per-actor point adjustment. */
  static async _onAdjustPoints(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const delta = Number(target.dataset.delta) || 0;
    const current = getState(this.actor).pointAdjustment;
    this._captureOpenRows();
    await setPointAdjustment(this.actor, current + delta);
    this.render();
  }

  /**
   * Tab switching is deliberately NOT a re-render — the rows for both tabs are already
   * rendered, so this is a class swap plus a filter pass. Re-rendering here would reset
   * the filter rail and steal focus, the same trap filtering itself has to avoid.
   */
  static _onSelectTab(event, target) {
    event.preventDefault();
    this._tab = target.dataset.tab === 'acquired' ? 'acquired' : 'available';
    for (const tab of this.element.querySelectorAll(`.${PREFIX}-tab[data-tab]`)) {
      tab.classList.toggle('is-active', tab.dataset.tab === this._tab);
    }
    this._applyFilters();
  }

  static _onClearFilters(event) {
    event.preventDefault();
    this._filters = blankFilterState();
    const el = this.element;
    el.querySelector(`.${PREFIX}-search`).value = '';
    for (const input of el.querySelectorAll('[data-filter]')) {
      if (input.type === 'checkbox') input.checked = false;
      else input.value = '';
    }
    this._applyFilters();
  }
}

/** Re-render open catalogs when the underlying data moves. */
export function registerCatalogHooks() {
  Hooks.on('updateActor', (actor, changes) => {
    if (changes.flags?.[MODULE_ID] || changes.system?.levelData) refreshCatalog(actor.id);
  });

  // Editing a Feature invalidates the cached pack index and its enriched description,
  // then re-renders every open catalog so the edit is visible without a reload. The
  // registry app is deliberately NOT re-rendered: it holds an unsaved working copy and
  // the GM may be mid-edit, and its next render re-reads the now-empty caches anyway.
  for (const hook of ['updateItem', 'deleteItem', 'createItem']) {
    Hooks.on(hook, doc => {
      if (!onFeatureDocumentChanged(doc)) return;
      for (const app of openCatalogs.values()) app.render();
    });
  }
  Hooks.on('updateSetting', setting => {
    if (setting.key?.startsWith(`${MODULE_ID}.`)) {
      for (const app of openCatalogs.values()) app.render();
    }
  });
}
