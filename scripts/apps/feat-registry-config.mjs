/**
 * feat-registry-config.mjs
 * The GM's Feat Registry: sources, curation, taxonomy and the point formula.
 *
 * Editing model is "working copy, save on Save" — #config holds a deep clone that
 * inputs mutate freely, and nothing reaches game.settings until _onSave. That keeps a
 * half-finished edit from leaking to players mid-session.
 */

import {
  MODULE_ID,
  PREFIX,
  TEMPLATES,
  TRAITS,
  RESOURCE_REQS,
  ITEM_TYPES,
  SETTINGS
} from '../constants.mjs';
import {
  getRegistry,
  setRegistry,
  getCategories,
  setCategories,
  getTypes,
  setTypes,
  getPointFormula,
  taxonomyLabel
} from '../settings.mjs';
import {
  loadAllSourceFeatures,
  normalizeFeat,
  blankFeat,
  isUncurated,
  invalidatePackCache
} from '../data/registry.mjs';
import { ATOMS, blankRequirements } from '../logic/requirements.mjs';
import { byCurationThenLevel, matchesFilters, blankFilterState } from '../logic/filters.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** A roll-data stand-in, so the formula preview works with no actor selected. */
const MOCK_ACTOR = {
  system: { levelData: { level: { current: 1 } }, tier: 1, proficiency: 1 },
  getRollData: () => ({
    level: 1,
    tier: 1,
    prof: 1,
    cast: 1,
    system: { level: 1, tier: 1, traits: {}, resources: {} }
  })
};

export class FeatRegistryConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  #config = null; // working copy of the registry setting
  #categories = null;
  #types = null;
  #formula = null;
  #dragDrop = null;
  #openFeats = new Set();

  constructor(options = {}) {
    super(options);
    this._tab = 'sources';
    this._filters = blankFilterState();
    this._uncuratedOnly = false;
    this._hiddenOnly = false;
  }

  static DEFAULT_OPTIONS = {
    id: `${PREFIX}-registry`,
    classes: ['daggerheart', 'dh-style', PREFIX, `${PREFIX}-registry`],
    tag: 'form',
    window: {
      title: 'RDHF.registry.title',
      icon: 'fa-solid fa-award',
      resizable: true
    },
    position: { width: 900, height: 720 },
    actions: {
      selectTab: FeatRegistryConfig._onSelectTab,
      addSource: FeatRegistryConfig._onAddSource,
      removeSource: FeatRegistryConfig._onRemoveSource,
      removeFeat: FeatRegistryConfig._onRemoveFeat,
      addCategory: FeatRegistryConfig._onAddCategory,
      removeCategory: FeatRegistryConfig._onRemoveCategory,
      addType: FeatRegistryConfig._onAddType,
      removeType: FeatRegistryConfig._onRemoveType,
      addInvestment: FeatRegistryConfig._onAddInvestment,
      removeInvestment: FeatRegistryConfig._onRemoveInvestment,
      exportRegistry: FeatRegistryConfig._onExport,
      importRegistry: FeatRegistryConfig._onImport,
      pruneOrphans: FeatRegistryConfig._onPrune,
      clearRegFilters: FeatRegistryConfig._onClearRegFilters,
      save: FeatRegistryConfig._onSave
    }
  };

  static PARTS = { main: { template: TEMPLATES.REGISTRY_CONFIG } };

  /**
   * ApplicationV2 has NO dragDrop option — only ActorSheetV2/ItemSheetV2 read one and
   * build a DragDrop from it. Declaring it here would silently bind nothing and every
   * drop would fall through the window. So it is constructed by hand.
   */
  get _dragDrop() {
    return (this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dropSelector: null, // null binds the whole window
      permissions: { dragstart: () => false, drop: () => game.user.isGM },
      callbacks: { drop: this._onDrop.bind(this) }
    }));
  }

  /**
   * Snapshot expanded rows AND scroll position before the DOM they live in is
   * replaced — otherwise every add/remove action throws the GM back to the top of a
   * long list.
   */
  render(options) {
    this._captureOpen();
    const scroller = this.element?.querySelector(`.${PREFIX}-reg-scroll`);
    if (scroller) this._scrollTop = scroller.scrollTop;
    return super.render(options);
  }

  _captureOpen() {
    if (!this.element) return;
    this.#openFeats = new Set(
      [...this.element.querySelectorAll(`.${PREFIX}-reg-feat[open]`)].map(el => el.dataset.uuid)
    );
  }

  async _prepareContext(_options) {
    this.#config ??= foundry.utils.deepClone(getRegistry());
    this.#categories ??= foundry.utils.deepClone(getCategories());
    this.#types ??= foundry.utils.deepClone(getTypes());
    this.#formula ??= getPointFormula();

    // The working copy, so a source added or a Feature dropped this session shows up
    // immediately instead of only after Save-and-reopen.
    const sources = await loadAllSourceFeatures(this.#config);
    const categoryOptions = this.#categories.map(c => ({
      id: c.id,
      label: taxonomyLabel(c),
      icon: c.icon
    }));
    const typeOptions = this.#types.map(t => ({ id: t.id, label: taxonomyLabel(t), icon: t.icon }));

    const feats = [...sources.values()]
      .map(source => {
        const feat = normalizeFeat(source.uuid, this.#config.feats?.[source.uuid]);
        return {
          ...feat,
          ...source,
          uncurated: isUncurated(feat),
          isOpen: this.#openFeats.has(source.uuid),
          registered: Boolean(this.#config.feats?.[source.uuid]),
          categoryOptions: categoryOptions.map(o => ({ ...o, selected: o.id === feat.category })),
          typeOptions: typeOptions.map(o => ({ ...o, checked: feat.types.includes(o.id) })),
          traitRows: TRAITS.map(t => ({
            key: t,
            label: game.i18n.localize(`RDHF.trait.${t}`),
            value: feat.requirements.traits[t] ?? ''
          })),
          resourceRows: Object.keys(RESOURCE_REQS).map(k => ({
            key: k,
            label: game.i18n.localize(`RDHF.resource.${k}`),
            value: feat.requirements.resources[k] ?? ''
          })),
          featuresText: feat.requirements.features.join(', '),
          classesText: feat.requirements.classes.join(', '),
          subclassesText: feat.requirements.subclasses.join(', '),
          investment: feat.requirements.categoryInvestment.map((row, index) => ({
            ...row,
            index,
            options: categoryOptions.map(o => ({ ...o, selected: o.id === row.category }))
          })),
          expression: feat.requirements.expression,
          // A GM-authored teaser, falling back to text derived from the description.
          summaryText: feat.summary ?? '',
          autoSummary: source.summary,
          // Row chrome mirroring the player catalog, so a GM curates against the same
          // presentation the table sees.
          teaser: feat.summary?.trim() || source.summary,
          categoryLabel: feat.category
            ? taxonomyLabel(this.#categories.find(c => c.id === feat.category)) || feat.category
            : null,
          typeLabels: feat.types.map(
            id => taxonomyLabel(this.#types.find(t => t.id === id)) || id
          ),
          typesAttr: (feat.types ?? []).join('|'),
          searchText: [source.name, source.summary, feat.summary]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
        };
      })
      .sort(byCurationThenLevel);

    return {
      tab: this._tab,
      isSources: this._tab === 'sources',
      isFeats: this._tab === 'feats',
      isTaxonomy: this._tab === 'taxonomy',
      isPoints: this._tab === 'points',
      sources: (this.#config.sources ?? []).map(s => ({
        ...s,
        label: game.packs.get(s.packId)?.metadata?.label ?? s.packId,
        missing: !game.packs.get(s.packId)
      })),
      availablePacks: game.packs
        .filter(p => p.documentName === 'Item' && !(this.#config.sources ?? []).some(s => s.packId === p.collection))
        .map(p => ({ id: p.collection, label: `${p.metadata.label} (${p.collection})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      feats,
      standaloneFeats: feats.filter(f => f.standalone),
      featCount: feats.length,
      uncuratedCount: feats.filter(f => f.uncurated).length,
      categories: this.#categories.map(c => ({ ...c, resolved: taxonomyLabel(c) })),
      types: this.#types.map(t => ({ ...t, resolved: taxonomyLabel(t) })),
      formula: this.#formula,
      formulaPreview: this._previewFormula(),
      filterCategories: categoryOptions,
      filterTypes: typeOptions,
      filters: this._filters,
      uncuratedOnly: this._uncuratedOnly,
      hiddenOnly: this._hiddenOnly
    };
  }

  /** Evaluates the formula against MOCK_ACTOR so a GM sees breakage before saving. */
  _previewFormula() {
    try {
      // The system's own idiom for a deterministic formula preview
      // (build/daggerheart.js:34880): substitute @paths, then safeEval the maths.
      // A point pool has no business rolling dice, so this is the right restriction.
      const substituted = Roll.replaceFormulaData(String(this.#formula), MOCK_ACTOR.getRollData(), {
        missing: '0'
      });
      const total = Roll.safeEval(substituted);
      return Number.isFinite(total)
        ? game.i18n.format('RDHF.registry.formulaPreview', { value: total })
        : game.i18n.localize('RDHF.registry.formulaInvalid');
    } catch (_) {
      return game.i18n.localize('RDHF.registry.formulaInvalid');
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._dragDrop.bind(this.element);
    const el = this.element;

    // Every editable field syncs into the working copy on input. Values arrive from
    // text inputs as strings, so numbers are coerced at the point of assignment.
    for (const input of el.querySelectorAll('[data-field]')) {
      const event = input.matches('select, input[type="checkbox"]') ? 'change' : 'input';
      input.addEventListener(event, ev => this._syncField(ev.currentTarget));
    }

    // Filtering is done in place. Re-rendering on every keystroke tore focus out of
    // the search box, exactly as it would in the catalog.
    const search = el.querySelector(`.${PREFIX}-reg-search`);
    search?.addEventListener('input', () => {
      this._filters.search = search.value;
      this._applyRegFilters();
    });

    for (const input of el.querySelectorAll('[data-filter]')) {
      const kind = input.dataset.filter;
      input.addEventListener('change', () => {
        if (kind === 'uncuratedOnly') this._uncuratedOnly = input.checked;
        else if (kind === 'hiddenOnly') this._hiddenOnly = input.checked;
        else if (kind === 'levelMin' || kind === 'levelMax') {
          this._filters[kind] = input.value === '' ? null : Number(input.value);
        } else if (kind === 'category' || kind === 'type') {
          const bucket = kind === 'category' ? 'categories' : 'types';
          const set = new Set(this._filters[bucket]);
          input.checked ? set.add(input.value) : set.delete(input.value);
          this._filters[bucket] = [...set];
        }
        this._applyRegFilters();
      });
    }

    this._renderAtomRows();
    this._applyRegFilters();

    const scroller = el.querySelector(`.${PREFIX}-reg-scroll`);
    if (scroller && this._scrollTop) scroller.scrollTop = this._scrollTop;
  }

  /**
   * Builds the expression atom shortcuts in JS rather than in the template.
   *
   * They are deliberately NOT rendered by Handlebars: the row sits inside two nested
   * #each blocks and did not appear from either `@root.atoms` or `this.atoms`, so the
   * template scope is not worth another guess. Building here also lets the buttons
   * bind their own listeners, so they do not depend on the action map either.
   */
  _renderAtomRows() {
    for (const input of this.element.querySelectorAll('[data-field="expression"]')) {
      let row = input.parentElement?.querySelector(`.${PREFIX}-atom-row`);
      if (!row) {
        row = document.createElement('div');
        row.className = `${PREFIX}-atom-row`;
        input.insertAdjacentElement('afterend', row);
      }
      row.replaceChildren();

      for (const atom of ATOMS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${PREFIX}-atom`;
        button.textContent = atom;
        button.dataset.tooltip = game.i18n.localize('RDHF.registry.atomTooltip');
        button.addEventListener('click', event => {
          event.preventDefault();
          const value = input.value.trim();
          input.value = value ? `${value} AND ${atom}` : atom;
          // Fire input so the normal [data-field] sync writes it to the working copy.
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        });
        row.appendChild(button);
      }
    }
  }

  /** Shows or hides curation rows to match the filters. No re-render. */
  _applyRegFilters() {
    const el = this.element;
    if (!el) return;
    let visible = 0;

    for (const row of el.querySelectorAll(`.${PREFIX}-reg-feat`)) {
      // Same predicate the player catalog uses, fed from the row's data attributes.
      const view = {
        level: Number(row.dataset.level) || 0,
        category: row.dataset.category || null,
        types: (row.dataset.types || '').split('|').filter(Boolean),
        owned: false,
        eligible: true,
        searchText: row.dataset.search || ''
      };
      const show =
        matchesFilters(view, this._filters) &&
        (!this._uncuratedOnly || row.dataset.uncurated === 'true') &&
        (!this._hiddenOnly || row.dataset.hidden === 'true');
      (row.closest('li') ?? row).hidden = !show;
      if (show) visible++;
    }

    const empty = el.querySelector(`.${PREFIX}-reg-empty`);
    if (empty) empty.hidden = visible > 0;
    const count = el.querySelector(`.${PREFIX}-reg-count`);
    if (count) count.textContent = String(visible);
  }

  /** Routes one edited control into the right slot of the working copy. */
  _syncField(input) {
    const field = input.dataset.field;
    const uuid = input.closest('[data-uuid]')?.dataset.uuid;
    const value = input.type === 'checkbox' ? input.checked : input.value;

    if (field === 'pointFormula') {
      this.#formula = String(value);
      const preview = this.element.querySelector(`.${PREFIX}-formula-preview`);
      if (preview) preview.textContent = this._previewFormula();
      return;
    }

    if (field.startsWith('category.') || field.startsWith('type.')) {
      const [kind, prop] = field.split('.');
      const list = kind === 'category' ? this.#categories : this.#types;
      const entry = list.find(e => e.id === input.closest('[data-entry-id]')?.dataset.entryId);
      if (entry) entry[prop] = String(value);
      return;
    }

    if (!uuid) return;
    const feat = (this.#config.feats[uuid] ??= blankFeat(uuid));
    feat.requirements ??= blankRequirements();

    switch (field) {
      case 'level':
        feat.level = Math.max(1, Number(value) || 1);
        break;
      case 'category':
        feat.category = value === '' ? null : String(value);
        break;
      case 'summary':
        feat.summary = String(value);
        break;
      case 'hidden':
        feat.hidden = value === true;
        break;
      case 'type': {
        const set = new Set(feat.types);
        value ? set.add(input.value) : set.delete(input.value);
        feat.types = [...set];
        break;
      }
      case 'trait':
        feat.requirements.traits[input.dataset.key] = value === '' ? null : Number(value);
        break;
      case 'resource':
        feat.requirements.resources[input.dataset.key] = value === '' ? null : Number(value);
        break;
      case 'features':
      case 'classes':
      case 'subclasses':
        feat.requirements[field] = String(value)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        break;
      case 'investmentCategory':
        feat.requirements.categoryInvestment[Number(input.dataset.index)].category = String(value);
        break;
      case 'investmentCount':
        feat.requirements.categoryInvestment[Number(input.dataset.index)].count = Number(value) || 0;
        break;
      case 'expression':
        feat.requirements.expression = String(value);
        break;
    }
  }

  /* ── Drag and drop ───────────────────────────────────────────────────────── */

  /**
   * One handler for both drop targets, so there is no listener-ordering problem: the
   * window-wide DragDrop binding would otherwise also fire for a drop aimed at a
   * requirement field and register it as a new Feat.
   */
  async _onDrop(event) {
    if (!game.user.isGM) return;
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== 'Item') return;

    // fromDropData resolves compendium drops correctly; fromUuid alone would not
    // handle the world/compendium split as cleanly.
    const item = await getDocumentClass('Item').fromDropData(data);
    if (!item) return;
    if (item.type !== ITEM_TYPES.FEATURE) {
      ui.notifications?.warn(game.i18n.localize('RDHF.notify.notAFeature'));
      return;
    }

    // Target A: an "Other Feats or Features" requirement field.
    const refInput = event.target?.closest?.('[data-field="features"]');
    if (refInput) return this._addFeatureReference(refInput, item);

    // Target B: anywhere else on the window — register the Feature as a Feat.
    const uuid = item.uuid;
    if (this.#config.feats[uuid]) {
      ui.notifications?.info(game.i18n.format('RDHF.notify.alreadyRegistered', { name: item.name }));
      return;
    }
    this.#config.feats[uuid] = { ...blankFeat(uuid), standalone: true };
    // Deliberately stays on the current tab — switching to Feats after every drop made
    // registering several Features in a row a chore.
    ui.notifications?.info(game.i18n.format('RDHF.notify.registered', { name: item.name }));
    this.render();
  }

  /**
   * Appends a dropped Feature to a requirement field.
   *
   * A registered Feat is referenced by UUID, because the check then means "has
   * acquired this Feat". Anything else is referenced by name, because the check means
   * "has a Feature called this" — a UUID would never match a plain feature.
   */
  _addFeatureReference(input, item) {
    const ref = this.#config.feats?.[item.uuid] ? item.uuid : item.name;
    const existing = input.value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    if (existing.includes(ref)) return;
    existing.push(ref);
    input.value = existing.join(', ');
    // Fire input so the normal [data-field] sync listener writes it to the working copy.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    ui.notifications?.info(game.i18n.format('RDHF.notify.featureRefAdded', { name: item.name }));
  }

  /* ── Actions ─────────────────────────────────────────────────────────────── */

  static _onSelectTab(event, target) {
    event.preventDefault();
    this._tab = target.dataset.tab;
    this.render();
  }

  static _onAddSource(event) {
    event.preventDefault();
    const select = this.element.querySelector(`.${PREFIX}-pack-select`);
    const packId = select?.value;
    if (!packId) return;
    this.#config.sources ??= [];
    if (!this.#config.sources.some(s => s.packId === packId)) {
      this.#config.sources.push({ packId, enabled: true });
    }
    this.render();
  }

  static _onRemoveSource(event, target) {
    event.preventDefault();
    const packId = target.dataset.packId;
    this.#config.sources = (this.#config.sources ?? []).filter(s => s.packId !== packId);
    this.render();
  }

  static async _onRemoveFeat(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid) return;
    delete this.#config.feats[uuid];
    this.render();
  }

  static _onAddCategory(event) {
    event.preventDefault();
    this.#categories.push({
      id: foundry.utils.randomID(),
      label: game.i18n.localize('RDHF.registry.newCategory'),
      icon: 'fa-solid fa-flask',
      description: ''
    });
    this.render();
  }

  static async _onRemoveCategory(event, target) {
    event.preventDefault();
    const id = target.closest('[data-entry-id]')?.dataset.entryId;
    const inUse = Object.values(this.#config.feats ?? {}).filter(f => f.category === id).length;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.registry.deleteCategoryTitle') },
      content: inUse
        ? `<p>${game.i18n.format('RDHF.registry.deleteCategoryInUse', { count: inUse })}</p>`
        : `<p>${game.i18n.localize('RDHF.registry.deleteCategoryBody')}</p>`
    });
    if (!confirmed) return;

    // Feats lose their Category and fall back to uncurated, which hides them from
    // players until the GM re-files them. That is the safe direction to fail.
    for (const feat of Object.values(this.#config.feats ?? {})) {
      if (feat.category === id) feat.category = null;
    }
    this.#categories = this.#categories.filter(c => c.id !== id);
    this.render();
  }

  static _onAddType(event) {
    event.preventDefault();
    this.#types.push({
      id: foundry.utils.randomID(),
      label: game.i18n.localize('RDHF.registry.newType'),
      icon: 'fa-solid fa-tag'
    });
    this.render();
  }

  static async _onRemoveType(event, target) {
    event.preventDefault();
    const id = target.closest('[data-entry-id]')?.dataset.entryId;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.registry.deleteTypeTitle') },
      content: `<p>${game.i18n.localize('RDHF.registry.deleteTypeBody')}</p>`
    });
    if (!confirmed) return;
    for (const feat of Object.values(this.#config.feats ?? {})) {
      feat.types = (feat.types ?? []).filter(t => t !== id);
    }
    this.#types = this.#types.filter(t => t.id !== id);
    this.render();
  }

  static _onAddInvestment(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    const feat = (this.#config.feats[uuid] ??= blankFeat(uuid));
    feat.requirements ??= blankRequirements();
    feat.requirements.categoryInvestment.push({ category: this.#categories[0]?.id ?? '', count: 1 });
    this.render();
  }

  static _onRemoveInvestment(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    const index = Number(target.dataset.index);
    this.#config.feats[uuid]?.requirements?.categoryInvestment.splice(index, 1);
    this.render();
  }

  static _onExport(event) {
    event.preventDefault();
    const payload = {
      module: MODULE_ID,
      version: game.modules.get(MODULE_ID)?.version ?? '0.0.0',
      registry: this.#config,
      categories: this.#categories,
      types: this.#types,
      pointFormula: this.#formula
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${MODULE_ID}-registry.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  static _onImport(event) {
    event.preventDefault();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch (_) {
        ui.notifications?.error(game.i18n.localize('RDHF.notify.importInvalid'));
        return;
      }
      if (!data?.registry?.feats || typeof data.registry.feats !== 'object') {
        ui.notifications?.error(game.i18n.localize('RDHF.notify.importInvalid'));
        return;
      }
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize('RDHF.registry.importTitle') },
        content: `<p>${game.i18n.localize('RDHF.registry.importBody')}</p>`
      });
      if (!confirmed) return;

      this.#config = data.registry;
      if (Array.isArray(data.categories)) this.#categories = data.categories;
      if (Array.isArray(data.types)) this.#types = data.types;
      if (typeof data.pointFormula === 'string') this.#formula = data.pointFormula;
      this.render();
    });
    input.click();
  }

  /** Mirrors the catalog's Clear filters: resets state and the controls, no re-render. */
  static _onClearRegFilters(event) {
    event.preventDefault();
    this._filters = blankFilterState();
    this._uncuratedOnly = false;
    this._hiddenOnly = false;
    const el = this.element;
    const search = el.querySelector(`.${PREFIX}-reg-search`);
    if (search) search.value = '';
    for (const input of el.querySelectorAll('[data-filter]')) {
      if (input.type === 'checkbox') input.checked = false;
      else input.value = '';
    }
    this._applyRegFilters();
  }

  static async _onPrune(event) {
    event.preventDefault();
    // Against the working copy, so a source added this session counts as reachable
    // and its feats are not pruned out from under the GM.
    const sources = await loadAllSourceFeatures(this.#config);
    const pruned = [];
    for (const uuid of Object.keys(this.#config.feats ?? {})) {
      if (sources.has(uuid)) continue;
      if (await fromUuid(uuid).catch(() => null)) continue;
      delete this.#config.feats[uuid];
      pruned.push(uuid);
    }
    ui.notifications?.info(game.i18n.format('RDHF.notify.pruned', { count: pruned.length }));
    this.render();
  }

  static async _onSave(event) {
    event.preventDefault();
    await setRegistry(this.#config);
    await setCategories(this.#categories);
    await setTypes(this.#types);
    await game.settings.set(MODULE_ID, SETTINGS.POINT_FORMULA, this.#formula);
    invalidatePackCache();
    ui.notifications?.info(game.i18n.localize('RDHF.notify.saved'));
    this.close();
  }
}
