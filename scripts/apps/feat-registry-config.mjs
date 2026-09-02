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
  SETTINGS,
  GENERAL_CATEGORY_ID
} from '../constants.mjs';
import {
  getRegistry,
  setRegistry,
  getCategories,
  setCategories,
  getTypes,
  setTypes,
  getPointFormula,
  taxonomyLabel,
  isFixedCategory
} from '../settings.mjs';
import {
  loadAllSourceFeatures,
  normalizeFeat,
  blankFeat,
  isUncurated,
  invalidatePackCache,
  getEnrichedDescription,
  resolveQuietly
} from '../data/registry.mjs';
import { countAffected, resyncAll, resyncFeat } from '../data/resync.mjs';
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
  /** uuid -> source Feature name, for resolving requirement reference chips. */
  #sourceNames = new Map();

  constructor(options = {}) {
    super(options);
    this._tab = 'sources';
    this._filters = blankFilterState();
    this._uncuratedOnly = false;
    this._hiddenOnly = false;
    this._sourceSearch = '';
    // Rail sections are collapsible; which ones are open survives a re-render.
    this._railOpen = { categories: true, types: true };
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
      resyncFeat: FeatRegistryConfig._onResyncFeat,
      resyncAll: FeatRegistryConfig._onResyncAll,
      removeReference: FeatRegistryConfig._onRemoveReference,
      openReference: FeatRegistryConfig._onOpenReference,
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
    for (const rail of this.element.querySelectorAll(`.${PREFIX}-rail-details[data-rail]`)) {
      this._railOpen[rail.dataset.rail] = rail.open;
    }
  }

  async _prepareContext(_options) {
    this.#config ??= foundry.utils.deepClone(getRegistry());
    this.#categories ??= foundry.utils.deepClone(getCategories());
    this.#types ??= foundry.utils.deepClone(getTypes());
    this.#formula ??= getPointFormula();

    // The working copy, so a source added or a Feature dropped this session shows up
    // immediately instead of only after Save-and-reopen.
    const sources = await loadAllSourceFeatures(this.#config);
    this.#sourceNames = new Map([...sources].map(([uuid, src]) => [uuid, src.name]));
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
          // Investment rows and reference chips are built in _onRender rather than here,
          // so adding one costs no re-render. Only the raw data travels.
          investment: feat.requirements.categoryInvestment,
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
      sources: (this.#config.sources ?? []).map(s => {
        const label = game.packs.get(s.packId)?.metadata?.label ?? s.packId;
        return {
          ...s,
          label,
          missing: !game.packs.get(s.packId),
          searchText: `${label} ${s.packId}`.toLowerCase()
        };
      }),
      availablePacks: game.packs
        .filter(p => p.documentName === 'Item' && !(this.#config.sources ?? []).some(s => s.packId === p.collection))
        .map(p => ({ id: p.collection, label: `${p.metadata.label} (${p.collection})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      feats,
      standaloneFeats: feats.filter(f => f.standalone),
      featCount: feats.length,
      uncuratedCount: feats.filter(f => f.uncurated).length,
      categories: this.#categories.map(c => ({
        ...c,
        resolved: taxonomyLabel(c),
        fixed: isFixedCategory(c.id)
      })),
      types: this.#types.map(t => ({ ...t, resolved: taxonomyLabel(t) })),
      formula: this.#formula,
      formulaPreview: this._previewFormula(),
      filterCategories: categoryOptions,
      filterTypes: typeOptions,
      filters: this._filters,
      uncuratedOnly: this._uncuratedOnly,
      hiddenOnly: this._hiddenOnly,
      sourceSearch: this._sourceSearch,
      railOpen: this._railOpen
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

    // Sources tab: one search over both lists, filtered in place like every other
    // search in this module.
    const sourceSearch = el.querySelector(`.${PREFIX}-source-search`);
    sourceSearch?.addEventListener('input', () => {
      this._sourceSearch = sourceSearch.value;
      this._applySourceFilter();
    });

    // Lazily enrich the full description the first time its panel is opened. It is a
    // compendium document more often than not, so it cannot resolve synchronously.
    for (const panel of el.querySelectorAll(`.${PREFIX}-desc-panel`)) {
      panel.addEventListener('toggle', () => {
        if (panel.open) this._loadFullDescription(panel);
      });
      if (panel.open) this._loadFullDescription(panel);
    }

    for (const row of el.querySelectorAll(`.${PREFIX}-reg-feat[data-uuid]`)) {
      this._renderInvestment(row);
      this._renderReferenceChips(row);
      // On change rather than input: re-chipping every keystroke would fire a document
      // lookup for each half-typed UUID, and the chips would flicker while typing.
      row
        .querySelector('[data-field="features"]')
        ?.addEventListener('change', () => this._renderReferenceChips(row));
    }

    this._renderAtomRows();
    this._applySourceFilter();
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

  /**
   * Repaints one row's chips, classes and data attributes from the working copy.
   *
   * Called on every edit because the chips are derived state: without this, ticking
   * "Hide from players" or choosing a Category left the Hidden and Uncurated chips
   * showing the old answer until the GM switched tabs and came back. Also refreshes the
   * tab badge and re-runs the filters, since both read the same derived state.
   *
   * @param {string} uuid
   */
  _refreshRow(uuid) {
    // Matched in JS rather than through an attribute selector: a UUID is full of dots
    // and would need escaping to survive one, for no gain over a direct comparison.
    const row = [...(this.element?.querySelectorAll(`.${PREFIX}-reg-feat[data-uuid]`) ?? [])].find(
      el => el.dataset.uuid === uuid
    );
    if (!row) return;
    const feat = normalizeFeat(uuid, this.#config.feats?.[uuid]);
    const uncurated = isUncurated(feat);

    row.dataset.level = String(feat.level);
    row.dataset.category = feat.category ?? '';
    row.dataset.types = (feat.types ?? []).join('|');
    row.dataset.uncurated = String(uncurated);
    row.dataset.hidden = String(feat.hidden);
    row.classList.toggle('is-uncurated', uncurated);
    row.classList.toggle('is-hidden', feat.hidden);

    const chips = row.querySelector(`.${PREFIX}-reg-chips`);
    if (chips) chips.replaceChildren(...this._buildChips(feat, uncurated));

    const badge = this.element.querySelector(`.${PREFIX}-tab-badge`);
    const outstanding = Object.keys(this.#config.feats ?? {}).length
      ? [...this.element.querySelectorAll(`.${PREFIX}-reg-feat`)].filter(
          r => r.dataset.uncurated === 'true'
        ).length
      : 0;
    if (badge) {
      badge.textContent = String(outstanding);
      badge.hidden = outstanding === 0;
    }

    this._applyRegFilters();
  }

  /** One chip element. Kept tiny because _buildChips calls it six times a row. */
  _chip(modifier, text, { icon = null, tooltip = null } = {}) {
    const chip = document.createElement('span');
    chip.className = `${PREFIX}-chip ${PREFIX}-chip--${modifier}`;
    if (tooltip) chip.dataset.tooltip = tooltip;
    if (icon) {
      const i = document.createElement('i');
      i.className = icon;
      chip.appendChild(i);
    }
    if (text) chip.appendChild(document.createTextNode(text));
    return chip;
  }

  /** The chip row for one feat, mirroring what the template renders on a full pass. */
  _buildChips(feat, uncurated) {
    const chips = [
      this._chip('level', `${game.i18n.localize('RDHF.catalog.levelShort')} ${feat.level}`)
    ];

    if (feat.category) {
      const entry = this.#categories.find(c => c.id === feat.category);
      chips.push(this._chip('category', taxonomyLabel(entry) || feat.category));
    }
    for (const id of feat.types ?? []) {
      const entry = this.#types.find(t => t.id === id);
      chips.push(this._chip('type', taxonomyLabel(entry) || id));
    }
    if (uncurated) {
      chips.push(
        this._chip('uncurated', game.i18n.localize('RDHF.catalog.uncurated'), {
          tooltip: game.i18n.localize('RDHF.catalog.uncuratedTooltip')
        })
      );
    }
    if (feat.hidden) {
      chips.push(
        this._chip('hidden', game.i18n.localize('RDHF.catalog.hidden'), {
          icon: 'fa-solid fa-eye-slash',
          tooltip: game.i18n.localize('RDHF.catalog.hiddenTooltip')
        })
      );
    }
    if (feat.standalone) {
      chips.push(
        this._chip('standalone', '', {
          icon: 'fa-solid fa-hand-pointer',
          tooltip: game.i18n.localize('RDHF.registry.standaloneTooltip')
        })
      );
    }
    return chips;
  }

  /** Filters both Sources lists in place. No re-render, so the box keeps focus. */
  _applySourceFilter() {
    const el = this.element;
    if (!el) return;
    const query = this._sourceSearch.trim().toLowerCase();

    for (const list of el.querySelectorAll(`.${PREFIX}-source-list`)) {
      let visible = 0;
      for (const item of list.querySelectorAll(`.${PREFIX}-source`)) {
        const show = !query || (item.dataset.sourceSearch ?? '').includes(query);
        item.hidden = !show;
        if (show) visible++;
      }
      const empty = list.nextElementSibling;
      if (empty?.classList.contains(`${PREFIX}-source-empty`)) empty.hidden = visible > 0;
    }
  }

  /**
   * Rebuilds one feat's Investment in Category rows from the working copy.
   *
   * Rebuilt wholesale rather than patched, because removing a row shifts every later
   * row's index and the join selector on the new first row has to disappear. Doing it
   * here instead of through render() is what keeps the scroll position still.
   *
   * @param {HTMLElement} row  the feat's <details>
   */
  _renderInvestment(row) {
    const list = row.querySelector(`.${PREFIX}-investment-list`);
    if (!list) return;
    const uuid = row.dataset.uuid;
    const feat = this.#config.feats?.[uuid];
    const rules = feat?.requirements?.categoryInvestment ?? [];
    list.replaceChildren();

    rules.forEach((rule, index) => {
      const line = document.createElement('div');
      line.className = `${PREFIX}-investment-row`;

      // The connector to the PREVIOUS row, so the first row never shows one. AND binds
      // tighter than OR, matching the expression grammar.
      if (index > 0) {
        const join = document.createElement('select');
        join.className = `${PREFIX}-join-select`;
        join.dataset.field = 'investmentJoin';
        join.dataset.index = String(index);
        for (const value of ['and', 'or']) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = game.i18n.localize(
            value === 'or' ? 'RDHF.requirement.joinOr' : 'RDHF.requirement.joinAnd'
          );
          option.selected = (rule.join ?? 'and') === value;
          join.appendChild(option);
        }
        join.addEventListener('change', () => this._syncField(join));
        line.appendChild(join);
      } else {
        line.appendChild(document.createElement('span'));
      }

      const category = document.createElement('select');
      category.dataset.field = 'investmentCategory';
      category.dataset.index = String(index);
      for (const entry of this.#categories) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = taxonomyLabel(entry);
        option.selected = entry.id === rule.category;
        category.appendChild(option);
      }
      category.addEventListener('change', () => this._syncField(category));
      line.appendChild(category);

      const count = document.createElement('input');
      count.type = 'number';
      count.min = '1';
      count.dataset.field = 'investmentCount';
      count.dataset.index = String(index);
      count.value = String(rule.count ?? 1);
      count.addEventListener('input', () => this._syncField(count));
      line.appendChild(count);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = `${PREFIX}-icon-btn ${PREFIX}-danger`;
      remove.dataset.action = 'removeInvestment';
      remove.dataset.index = String(index);
      remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      line.appendChild(remove);

      list.appendChild(line);
    });
  }

  /**
   * Renders the "Other Feats or Features" field's current value as named chips.
   *
   * A dropped Feat lands in the field as a bare UUID, which tells the GM nothing about
   * what they just added. Each chip resolves to a name, opens its source item on click,
   * and carries its own remove button.
   *
   * @param {HTMLElement} row
   */
  _renderReferenceChips(row) {
    const input = row.querySelector('[data-field="features"]');
    const box = row.querySelector(`.${PREFIX}-ref-chips`);
    if (!input || !box) return;

    const refs = input.value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    box.replaceChildren();

    for (const ref of refs) {
      const isUuid = ref.includes('.') && !ref.includes(' ');
      const chip = document.createElement('span');
      chip.className = `${PREFIX}-chip ${PREFIX}-ref-chip`;
      chip.dataset.ref = ref;

      const label = document.createElement('button');
      label.type = 'button';
      label.className = `${PREFIX}-ref-open`;
      // A known Feat resolves immediately; anything else shows as typed until (and
      // unless) the async lookup below finds a document with a better name.
      label.textContent = this.#sourceNames.get(ref) ?? ref;
      if (isUuid) {
        label.dataset.action = 'openReference';
        label.dataset.tooltip = game.i18n.localize('RDHF.registry.openReference');
      } else {
        label.disabled = true;
      }
      chip.appendChild(label);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = `${PREFIX}-ref-remove`;
      remove.dataset.action = 'removeReference';
      remove.dataset.tooltip = game.i18n.localize('RDHF.registry.removeReference');
      remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      chip.appendChild(remove);

      box.appendChild(chip);

      // A UUID from an unregistered pack is not in #sourceNames; fetch its name once.
      if (isUuid && !this.#sourceNames.has(ref)) {
        resolveQuietly(ref).then(doc => {
          if (!doc?.name || !label.isConnected) return;
          this.#sourceNames.set(ref, doc.name);
          label.textContent = doc.name;
        });
      }
    }
  }

  /** Writes a reference list back to the field and re-chips it. */
  _setReferences(row, refs) {
    const input = row.querySelector('[data-field="features"]');
    if (!input) return;
    input.value = refs.join(', ');
    this._syncField(input);
    this._renderReferenceChips(row);
  }

  /** Loads the source Feature's enriched description into an open panel, once. */
  async _loadFullDescription(panel) {
    const body = panel.querySelector(`.${PREFIX}-desc-body`);
    const uuid = panel.closest('[data-uuid]')?.dataset.uuid;
    if (!body || !uuid || body.dataset.loaded === 'true') return;
    body.dataset.loaded = 'true';
    body.innerHTML = await getEnrichedDescription(uuid);
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
      case 'investmentJoin':
        feat.requirements.categoryInvestment[Number(input.dataset.index)].join =
          value === 'or' ? 'or' : 'and';
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

    // Every one of these can change what the row's chips say, so repaint them now
    // rather than waiting for the next full render.
    if (['level', 'category', 'type', 'hidden'].includes(field)) this._refreshRow(uuid);
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

    // Target A: an "Other Feats or Features" requirement field. Works from any tab,
    // because that is where the GM is when they want it.
    const refInput = event.target?.closest?.('[data-field="features"]');
    if (refInput) return this._addFeatureReference(refInput, item);

    // Target B: the Sources drop zone, and ONLY the drop zone. The DragDrop binding
    // covers the whole window (ApplicationV2 gives no per-element option), so without
    // this test a Feature dropped while curating on the Feats tab was silently
    // registered as a new source feat — never what the GM meant.
    if (!event.target?.closest?.(`.${PREFIX}-dropzone`)) {
      ui.notifications?.info(game.i18n.localize('RDHF.notify.dropOnZone'));
      return;
    }

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
    this.#sourceNames.set(ref, item.name);
    const row = input.closest(`.${PREFIX}-reg-feat`);
    if (row) this._renderReferenceChips(row);
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
    // The template hides this button for a fixed Category; the guard is here because
    // an imported registry could still be carrying one that has to survive.
    if (isFixedCategory(id)) {
      ui.notifications?.warn(game.i18n.localize('RDHF.notify.fixedCategory'));
      return;
    }
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

  /**
   * Adds an investment row. Rebuilds only that block — this used to call render(),
   * which threw the GM back to the top of a long Feats list every single time.
   */
  static _onAddInvestment(event, target) {
    event.preventDefault();
    const row = target.closest(`.${PREFIX}-reg-feat`);
    const uuid = row?.dataset.uuid;
    if (!uuid) return;
    const feat = (this.#config.feats[uuid] ??= blankFeat(uuid));
    feat.requirements ??= blankRequirements();
    feat.requirements.categoryInvestment.push({
      category: this.#categories.find(c => c.id === GENERAL_CATEGORY_ID)?.id ??
        this.#categories[0]?.id ??
        '',
      count: 1,
      join: 'and'
    });
    this._renderInvestment(row);
  }

  static _onRemoveInvestment(event, target) {
    event.preventDefault();
    const row = target.closest(`.${PREFIX}-reg-feat`);
    const uuid = row?.dataset.uuid;
    const index = Number(target.dataset.index);
    this.#config.feats[uuid]?.requirements?.categoryInvestment.splice(index, 1);
    if (row) this._renderInvestment(row);
  }

  /** Removes one requirement reference chip and rewrites the field behind it. */
  static _onRemoveReference(event, target) {
    event.preventDefault();
    const row = target.closest(`.${PREFIX}-reg-feat`);
    const ref = target.closest('[data-ref]')?.dataset.ref;
    const input = row?.querySelector('[data-field="features"]');
    if (!row || !input || ref === undefined) return;
    const refs = input.value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
      .filter(v => v !== ref);
    this._setReferences(row, refs);
  }

  /** Opens the Feature a reference chip points at, in its own sheet. */
  static async _onOpenReference(event, target) {
    event.preventDefault();
    const ref = target.closest('[data-ref]')?.dataset.ref;
    if (!ref) return;
    const doc = await resolveQuietly(ref);
    if (!doc) {
      ui.notifications?.warn(game.i18n.format('RDHF.notify.sourceMissing', { uuid: ref }));
      return;
    }
    doc.sheet?.render(true);
  }

  /**
   * Pushes one feat's source back out to every character who owns it.
   *
   * The confirmation names the count first, because this overwrites whatever those
   * characters' copies currently hold — including any per-character edits.
   */
  static async _onResyncFeat(event, target) {
    event.preventDefault();
    const row = target.closest(`.${PREFIX}-reg-feat`);
    const uuid = row?.dataset.uuid;
    if (!uuid) return;

    const { acquisitions } = countAffected([uuid]);
    if (!acquisitions) {
      ui.notifications?.info(game.i18n.localize('RDHF.notify.resyncNobody'));
      return;
    }

    const name = foundry.utils.escapeHTML(row.querySelector(`.${PREFIX}-feat-name`)?.textContent ?? uuid);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.registry.resyncTitle') },
      content:
        `<p>${game.i18n.format('RDHF.registry.resyncFeatBody', { name, count: acquisitions })}</p>` +
        `<p class="${PREFIX}-warning">${game.i18n.localize('RDHF.registry.resyncWarning')}</p>`
    });
    if (!confirmed) return;

    const result = await resyncFeat(uuid);
    ui.notifications?.info(game.i18n.format('RDHF.notify.resynced', { count: result.updated }));
  }

  /** The same, for every registered feat at once. */
  static async _onResyncAll(event) {
    event.preventDefault();
    const { feats, characters, acquisitions } = countAffected();
    if (!acquisitions) {
      ui.notifications?.info(game.i18n.localize('RDHF.notify.resyncNobody'));
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.registry.resyncTitle') },
      content:
        `<p>${game.i18n.format('RDHF.registry.resyncAllBody', { feats, characters, count: acquisitions })}</p>` +
        `<p class="${PREFIX}-warning">${game.i18n.localize('RDHF.registry.resyncWarning')}</p>`
    });
    if (!confirmed) return;

    const result = await resyncAll();
    ui.notifications?.info(game.i18n.format('RDHF.notify.resynced', { count: result.updated }));
    if (result.missing.length) {
      ui.notifications?.warn(
        game.i18n.format('RDHF.notify.resyncMissing', { count: result.missing.length })
      );
    }
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
