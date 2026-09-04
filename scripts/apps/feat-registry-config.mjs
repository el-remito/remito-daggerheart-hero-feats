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
  GENERAL_CATEGORY_ID,
  DEFAULT_INVESTMENT_BY_LEVEL
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
  isFixedCategory,
  getShowStatistics,
  getAutomation,
  setAutomation
} from '../settings.mjs';
import {
  loadAllSourceFeatures,
  normalizeFeat,
  blankFeat,
  isUncurated,
  invalidatePackCache,
  getEnrichedDescription,
  resolveQuietly,
  saveFeatEntry
} from '../data/registry.mjs';
import { countAffected, resyncAll, resyncFeat } from '../data/resync.mjs';
import { gatherLedger } from '../data/analytics.mjs';
import {
  buildAdoptionStats,
  buildInvestmentReach,
  buildCatalogStats,
  UNCURATED_ROW
} from '../logic/statistics.mjs';
import { ATOMS, blankRequirements } from '../logic/requirements.mjs';
import {
  applyAutoInvestment,
  autoInvestmentRow,
  investmentForLevel,
  stripRedundantInvestment
} from '../logic/automation.mjs';
import { describeRequirements, localizeCheck } from './requirement-text.mjs';
import {
  byCurationThenLevel,
  matchesFilters,
  blankFilterState,
  newestCurated
} from '../logic/filters.mjs';
import { buildCurationQueue, nextInQueue } from '../logic/curation.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The two hosts a feat's requirement controls render into: a Feats-tab row and the
 * Curation editor. Every lookup answering "which feat is this control editing?" has to
 * accept BOTH — a handler that names only the Feats row resolves null on the Curation
 * tab, returns at its own guard, and does nothing at all with nothing logged. That is
 * exactly how Add category requirement came to be dead there.
 */
const FEAT_HOST = `.${PREFIX}-reg-feat[data-uuid], .${PREFIX}-cur-editor[data-uuid]`;

/**
 * The fields whose value can change what a feat's collapsed "Requires" line says.
 *
 * Level and Category are in here not because they are shown — the line drops the Level
 * chip and the Category is a chip of its own — but because both feed Rule Automation,
 * which can add or remove an investment clause without any requirement field moving.
 * `summary`, `hidden` and `type` are the only feat fields deliberately left out.
 */
const REQUIREMENT_FIELDS = [
  'level',
  'category',
  'autoExempt',
  'trait',
  'resource',
  'features',
  'classes',
  'subclasses',
  'investmentCategory',
  'investmentCount',
  'investmentJoin',
  'expression'
];

/** Longest the requirement-reference search drops down before it stops listing. */
const MAX_REFERENCE_RESULTS = 8;

/** Empty Category/Level cells listed by name before the panel falls back to a count. */
const MAX_GAP_ROWS = 12;

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
  #automation = null; // working copy of the Rule Automation setting
  #dragDrop = null;
  #openFeats = new Set();
  /**
   * A deep clone of the working copy as it stood at the last commit, so close() can
   * tell an untouched registry from an edited one. A snapshot rather than a flag set
   * at every mutation site: there are a dozen of those and a future one that forgot
   * the flag would silently discard the GM's work again.
   *
   * Held as an object, not a string, because Curation's File writes one feat through
   * and has to rebase exactly that key without claiming the rest of the session is
   * saved. Comparison is by stable JSON, so a rebased key landing in a different
   * position never reads as an edit.
   */
  #baseline = null;
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
    // Which axis the statistics grid is showing. Swapping it repaints, never renders.
    this._statsAxis = 'category';
    // uuids of the most recently curated feats. Recency belongs to the SET, not to a
    // feat — the tenth-newest stops being new when an eleventh is filed, with nothing
    // about it changing — so it is decided once and read by both the chips and the
    // filter, which is what keeps them from disagreeing.
    this._newFeats = new Set();
    // Actor ids the GM has set aside from the adoption figures. Session-local, like
    // every other thing this tab knows: the Statistics tab derives everything and
    // stores nothing, so there is no setting, no flag and no migration here either.
    this._excludedActors = new Set();
    // Whether the Coverage gaps list is showing past its default cap. Same deal: the
    // rows are all in the DOM, and the toggle unhides them rather than re-rendering.
    this._showAllGaps = false;

    /* Curation queue state. All three are session-local by design: the queue is
       DERIVED from "has no Category", so anything left half-done is simply back the
       next time the registry opens. Nothing here is stored, and there is no migration. */
    // Feats that have appeared in the queue at least once. Keeps a feat in place after
    // a Category is chosen — otherwise picking one would delete the row out from under
    // the GM before they could set its dependencies or traits.
    this._curationSeen = new Set();
    // Explicitly filed this session, and gone from the queue until the app is reopened.
    this._curationFiled = new Set();
    this._curationUuid = null;
    this._curationMore = false;
    this._curationScroll = 0;
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
      resetFeat: FeatRegistryConfig._onResetFeat,
      addCategory: FeatRegistryConfig._onAddCategory,
      removeCategory: FeatRegistryConfig._onRemoveCategory,
      addType: FeatRegistryConfig._onAddType,
      removeType: FeatRegistryConfig._onRemoveType,
      addInvestment: FeatRegistryConfig._onAddInvestment,
      removeInvestment: FeatRegistryConfig._onRemoveInvestment,
      resetAutomation: FeatRegistryConfig._onResetAutomation,
      exportRegistry: FeatRegistryConfig._onExport,
      importRegistry: FeatRegistryConfig._onImport,
      pruneOrphans: FeatRegistryConfig._onPrune,
      clearRegFilters: FeatRegistryConfig._onClearRegFilters,
      resyncFeat: FeatRegistryConfig._onResyncFeat,
      resyncAll: FeatRegistryConfig._onResyncAll,
      removeReference: FeatRegistryConfig._onRemoveReference,
      openReference: FeatRegistryConfig._onOpenReference,
      statsAxis: FeatRegistryConfig._onStatsAxis,
      curationSelect: FeatRegistryConfig._onCurationSelect,
      curationFile: FeatRegistryConfig._onCurationFile,
      curationSkip: FeatRegistryConfig._onCurationSkip,
      focusCell: FeatRegistryConfig._onFocusCell,
      toggleLedgerActor: FeatRegistryConfig._onToggleLedgerActor,
      toggleGaps: FeatRegistryConfig._onToggleGaps,
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
    // The Curation tab has two scrollers: the editor pane is the rdhf-reg-scroll one,
    // and the queue keeps its own place so picking a feat does not throw the list back
    // to the top on every selection.
    const queue = this.element?.querySelector(`.${PREFIX}-cur-queue-scroll`);
    if (queue) this._curationScroll = queue.scrollTop;
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
    this.#automation ??= foundry.utils.deepClone(getAutomation());
    this.#baseline ??= foundry.utils.deepClone(this.#snapshot());

    // Absorb rows that merely restate the rule, so a GM who applied this curve by hand
    // before switching the rule on is adopted by it rather than excluded from it. Only
    // feats that actually match are touched, so a world with nothing redundant never
    // goes dirty; one that does becomes dirty exactly once, and the close prompt is
    // this app's existing way of saying there is a real pending change.
    this.#adoptRedundantInvestment();

    // The working copy, so a source added or a Feature dropped this session shows up
    // immediately instead of only after Save-and-reopen.
    // A registry left open on Statistics when the setting is switched off would
    // render a tab bar with nothing selected, so the guard runs before the context is
    // built rather than at the point of use.
    const showStats = getShowStatistics();
    if (!showStats && this._tab === 'stats') this._tab = 'sources';

    const sources = await loadAllSourceFeatures(this.#config);
    this.#sourceNames = new Map([...sources].map(([uuid, src]) => [uuid, src.name]));
    const categoryOptions = this.#categories.map(c => ({
      id: c.id,
      label: taxonomyLabel(c),
      icon: c.icon,
      hidden: c.hidden === true
    }));
    const typeOptions = this.#types.map(t => ({
      id: t.id,
      label: taxonomyLabel(t),
      icon: t.icon,
      hidden: t.hidden === true
    }));

    // The rail's own controls carry their filter state into the markup. Until the
    // statistics grid could set a filter programmatically this was invisible — filters
    // were only ever set by clicking these same boxes, and _onClearRegFilters resets
    // them by writing the DOM rather than re-rendering. Switching tabs DOES re-render,
    // so without this a filter set from a grid cell would apply with an untouched rail
    // contradicting the visible row count.
    const railCategories = categoryOptions.map(o => ({
      ...o,
      checked: this._filters.categories.includes(o.id)
    }));
    const railTypes = typeOptions.map(o => ({
      ...o,
      checked: this._filters.types.includes(o.id)
    }));

    // Decided once for the whole list, before the views are built, because recency is
    // a property of the set: the tenth-newest feat stops being new when an eleventh is
    // filed without anything about it changing.
    this._recomputeNewFeats();

    const feats = [...sources.values()]
      .map(source => {
        const feat = normalizeFeat(source.uuid, this.#config.feats?.[source.uuid]);
        return {
          ...feat,
          ...source,
          uncurated: isUncurated(feat),
          isNew: this._newFeats.has(source.uuid),
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
          // A feat withheld because its Category or one of its Types is hidden looked
          // exactly like a visible one until v1.4.4 — the Hidden chip only ever tracked
          // the per-feat flag. The state is carried per CHIP rather than as one row-level
          // "withheld" marker so the row says WHICH entry is doing it; on a feat carrying
          // four Types a bare marker would just start a hunt.
          categoryHidden:
            this.#categories.find(c => c.id === feat.category)?.hidden === true,
          typeChips: feat.types.map(id => {
            const entry = this.#types.find(t => t.id === id);
            return { label: taxonomyLabel(entry) || id, hidden: entry?.hidden === true };
          }),
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

    // Carried so _refreshCurationRow can move the Feats badge without re-deriving the
    // whole catalog: it counts ALL uncurated feats, filed ones included, and the
    // Curation queue does not contain those.
    this._uncuratedTotal = feats.filter(f => f.uncurated).length;

    return {
      tab: this._tab,
      isSources: this._tab === 'sources',
      isFeats: this._tab === 'feats',
      isCuration: this._tab === 'curation',
      isTaxonomy: this._tab === 'taxonomy',
      isPoints: this._tab === 'points',
      isAutomation: this._tab === 'automation',
      autoInvestEnabled: this.#automation.investmentByLevel.enabled === true,
      // Descending, so the table reads like a progression ceiling downwards and matches
      // how the curve was specified. Precomputed because Handlebars has no `eq` here.
      automationRows: Object.keys(this.#automation.investmentByLevel.table)
        .map(Number)
        .sort((a, b) => b - a)
        .map(level => ({ level, count: this.#automation.investmentByLevel.table[String(level)] })),
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
      uncuratedCount: this._uncuratedTotal,
      categories: this.#categories.map(c => ({
        ...c,
        resolved: taxonomyLabel(c),
        fixed: isFixedCategory(c.id)
      })),
      types: this.#types.map(t => ({ ...t, resolved: taxonomyLabel(t) })),
      formula: this.#formula,
      formulaPreview: this._previewFormula(),
      filterCategories: railCategories,
      filterTypes: railTypes,
      filters: this._filters,
      uncuratedOnly: this._uncuratedOnly,
      hiddenOnly: this._hiddenOnly,
      newOnly: this._filters.newOnly,
      sourceSearch: this._sourceSearch,
      railOpen: this._railOpen,
      showStats,
      isStats: showStats && this._tab === 'stats',
      // Computed ONLY when the tab is open. The Feats tab re-renders on every source
      // add, feat drop and taxonomy edit; scanning every actor each time would be pure
      // waste, and with the tab switched off nothing here runs at all.
      stats: showStats && this._tab === 'stats' ? await this._buildStats(feats) : null,
      statsAxis: this._statsAxis,
      isAxisCategory: this._statsAxis === 'category',
      isAxisType: this._statsAxis === 'type',
      // Built from the same feat views the Feats tab uses, so the editor pane needs no
      // second shape and every [data-field] control behaves identically in both.
      curation: this._tab === 'curation' ? this._buildCuration(feats) : null
    };
  }

  /**
   * The Curation queue and whichever feat it currently has open.
   *
   * Everything here is session state on the app; nothing is read from or written to a
   * setting. Feats reaching the queue are recorded in `_curationSeen` as a side effect
   * of building it — that set is what keeps a row in place after its Category is
   * chosen, and there is no other moment at which membership is known.
   *
   * @param {Array<object>} feats  the feat views from _prepareContext
   */
  _buildCuration(feats) {
    const { queue, outstanding, ready, filed } = buildCurationQueue({
      feats,
      seen: this._curationSeen,
      filed: this._curationFiled
    });
    for (const feat of queue) this._curationSeen.add(feat.uuid);

    // A selection can go stale in three ways: it was just filed, it was pruned, or the
    // tab is being opened for the first time. All three land on the head of the queue.
    if (!queue.some(f => f.uuid === this._curationUuid)) {
      this._curationUuid = queue[0]?.uuid ?? null;
    }
    const index = queue.findIndex(f => f.uuid === this._curationUuid);

    return {
      queue: queue.map(feat => ({
        uuid: feat.uuid,
        name: feat.name,
        img: feat.img,
        level: feat.level,
        categoryLabel: feat.categoryLabel,
        categoryHidden: feat.categoryHidden,
        uncurated: feat.uncurated,
        isCurrent: feat.uuid === this._curationUuid
      })),
      feat: index === -1 ? null : queue[index],
      position: index + 1,
      total: queue.length,
      hasQueue: queue.length > 0,
      outstanding,
      ready,
      filed,
      moreOpen: this._curationMore
    };
  }

  /**
   * Assembles both halves of the Statistics tab.
   *
   * Reads the WORKING copy through the feat views already built for this render, so a
   * Category assigned a moment ago on the Feats tab is reflected before Save. The
   * arithmetic itself is pure and lives in logic/statistics.mjs; everything localized
   * is resolved here, which is what keeps that file free of game.i18n.
   *
   * @param {Array<object>} feats  the feat views from _prepareContext
   */
  async _buildStats(feats) {
    // The same four withholds listFeats applies. buildInvestmentReach measures supply
    // as what a player could actually ACQUIRE, and a Feat withheld by its Category or
    // by one of its Types is no more acquirable than one flagged Hidden outright — so
    // the audit is given the collapsed answer rather than the taxonomy, which is the
    // app's to read and not logic/'s. Uncurated is in here for the same reason, which
    // is why the audit carries no separate branch for it.
    const hiddenCategories = new Set(this.#categories.filter(c => c?.hidden).map(c => c.id));
    const hiddenTypes = new Set(this.#types.filter(t => t?.hidden).map(t => t.id));
    const withheld = feat =>
      feat.hidden === true ||
      !feat.category ||
      hiddenCategories.has(feat.category) ||
      (feat.types ?? []).some(t => hiddenTypes.has(t));

    const records = feats.map(view => ({
      uuid: view.uuid,
      label: view.name,
      level: view.level,
      category: view.category,
      types: view.types,
      hidden: view.hidden,
      withheld: withheld(view),
      standalone: view.standalone,
      // Load-bearing for buildInvestmentReach: without it every exempt feat would be
      // audited as though the rule still reached it.
      autoExempt: view.autoExempt,
      requirements: view.requirements,
      resolves: true
    }));

    // A registered feat whose source Feature no longer resolves never reaches the feat
    // views at all — loadAllSourceFeatures simply cannot produce a record for it. It
    // still occupies a slot in the registry, and it is exactly what the Prune button
    // exists to clear, so it is counted here from the working copy directly.
    const seen = new Set(records.map(r => r.uuid));
    for (const [uuid, stored] of Object.entries(this.#config.feats ?? {})) {
      if (seen.has(uuid)) continue;
      const feat = normalizeFeat(uuid, stored);
      records.push({ ...feat, label: uuid, withheld: withheld(feat), resolves: false });
    }

    const localCategories = this.#categories.map(c => ({
      id: c.id,
      label: taxonomyLabel(c),
      icon: c.icon
    }));

    const catalog = buildCatalogStats({
      feats: records,
      categories: localCategories,
      types: this.#types.map(t => ({ id: t.id, label: taxonomyLabel(t), icon: t.icon })),
      uncuratedLabel: game.i18n.localize('RDHF.catalog.uncurated')
    });

    const adoption = buildAdoptionStats({
      feats: records,
      ledger: await gatherLedger(),
      excluded: this._excludedActors
    });

    // Reads the working copy of BOTH the registry and the automation curve, so a
    // Category filed or a table value retuned a moment ago is already reflected —
    // the same contract every other figure on this tab honours.
    const reach = buildInvestmentReach({
      feats: records,
      categories: localCategories,
      rule: this.#automation.investmentByLevel
    });
    const categoryLabels = Object.fromEntries(localCategories.map(c => [c.id, c.label]));

    return {
      catalog: this._decorateCatalog(catalog),
      reach: {
        ...reach,
        clean: reach.checked > 0 && reach.blocked.length === 0,
        // Feats, not findings: `checked` counts Feats, and a finding can stand for
        // several of them, so the summary line would otherwise divide one unit by
        // another.
        blockedFeats: reach.blocked.reduce((n, b) => n + b.feats, 0),
        // Each finding says what the requirement IS, in the words the player is shown
        // for it — same descriptor shape, same connectors, through the one place a
        // descriptor becomes text. Writing a second wording of the same clause here is
        // exactly what apps/requirement-text.mjs exists to prevent.
        blocked: reach.blocked.map(b => ({
          ...b,
          requirement: localizeCheck({
            kind: 'categoryInvestment',
            key: 'RDHF.requirement.categoryInvestment',
            data: {
              parts: b.parts.map(p => ({ ...p, category: categoryLabels[p.category] ?? p.category }))
            },
            met: false
          }).label
        }))
      },
      adoption: {
        ...adoption,
        recent: adoption.recent.map(entry => ({
          ...entry,
          // Formatted here rather than in logic/: a date is a localized display string,
          // and the pure layer never touches game.i18n or the user's locale. An entry
          // acquired before the timestamp existed carries 0 and shows a dash.
          when: entry.at ? new Date(entry.at).toLocaleDateString() : '—'
        }))
      },
      hasFeats: records.length > 0,
      // The full list, not the counted one: excluding every character must grey the
      // table, never replace it with the "nobody has taken a Feat" empty state, which
      // would take away the only control that puts them back.
      hasPlayData: adoption.characters.length > 0
    };
  }

  /** Localizes the label-bearing rows and precomputes the shading percentages. */
  _decorateCatalog(catalog) {
    // A flat list rather than an object, each entry carrying its own axis and hidden
    // state. The module registers no Handlebars helpers, so the template can neither
    // look a key up nor compare one — every boolean it needs is computed here.
    const gridList = ['category', 'type'].map(axis => {
      const grid = catalog.grids[axis];
      return {
        axis,
        hidden: this._statsAxis !== axis,
        columns: grid.columns,
        columnTotals: grid.columnTotals,
        rows: grid.rows.map(row => ({
          ...row,
          cells: row.cells.map(cell => ({
            ...cell,
            rowId: row.id,
            axis,
            // Against this grid's own busiest cell. Handlebars gets a finished number
            // because the module does no maths in templates.
            intensity: grid.max ? Math.round((cell.count / grid.max) * 100) : 0,
            empty: cell.count === 0
          }))
        }))
      };
    });

    return {
      ...catalog,
      gridList,
      requirementUsage: {
        ...catalog.requirementUsage,
        rows: catalog.requirementUsage.rows.map(r => ({
          ...r,
          label: game.i18n.localize(`RDHF.stats.requirement.${r.kind}`)
        }))
      },
      traitDemand: {
        ...catalog.traitDemand,
        rows: catalog.traitDemand.rows.map(r => ({
          ...r,
          label: game.i18n.localize(`RDHF.trait.${r.key}`)
        }))
      },
      resourceDemand: {
        ...catalog.resourceDemand,
        rows: catalog.resourceDemand.rows.map(r => ({
          ...r,
          label: game.i18n.localize(`RDHF.resource.${r.key}`)
        }))
      },
      gaps: {
        ...catalog.gaps,
        // Capped, because a brand-new catalog is nothing BUT empty cells and a
        // thousand-row list is not a finding — but the cap is a default view, not a
        // ceiling. Slicing the overflow away left a GM able to read that thirty
        // combinations were missing and with no way to learn WHICH, which is the one
        // question this panel exists to answer. Every row is rendered; the ones past
        // the cap start hidden and the toggle unhides them in place, so revealing them
        // costs nothing — no part of the statistics pass runs a second time.
        //
        // `hidden` is written here AND by _onToggleGaps, so the flag has to travel
        // through the context: switching tabs rebuilds this pane, and without it an
        // expanded list would come back collapsed while the toggle still read "Show
        // fewer". Same contract the axis buttons keep one panel above.
        cells: catalog.gaps.emptyCells.map((cell, i) => ({
          ...cell,
          overflow: i >= MAX_GAP_ROWS,
          hidden: i >= MAX_GAP_ROWS && !this._showAllGaps
        })),
        moreCells: Math.max(0, catalog.gaps.emptyCells.length - MAX_GAP_ROWS),
        showAll: this._showAllGaps
      }
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
        else if (kind === 'newOnly') this._filters.newOnly = input.checked;
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

    // The Curation editor is a second host for the very same requirement controls, so
    // it is wired by the same loop. Every helper below takes the containing element and
    // queries inside it, and _syncField routes on the nearest [data-uuid] ancestor, so
    // none of them care which tab the controls are sitting on.
    const rows = el.querySelectorAll(FEAT_HOST);
    for (const row of rows) {
      this._renderInvestment(row);
      this._paintAutoInvestment(row);
      this._paintRequirementLine(row);
      this._renderReferenceChips(row);
      // On change rather than input: re-chipping every keystroke would fire a document
      // lookup for each half-typed UUID, and the chips would flicker while typing.
      row
        .querySelector('[data-field="features"]')
        ?.addEventListener('change', () => this._renderReferenceChips(row));
      this._bindReferenceSearch(row);
    }

    // Whether the Curation pane's secondary fields are open has to survive the
    // re-render that selecting the next feat causes.
    const more = el.querySelector(`.${PREFIX}-cur-more`);
    more?.addEventListener('toggle', () => {
      this._curationMore = more.open;
    });

    this._renderAtomRows();
    this._applySourceFilter();
    this._applyRegFilters();

    const scroller = el.querySelector(`.${PREFIX}-reg-scroll`);
    if (scroller && this._scrollTop) scroller.scrollTop = this._scrollTop;
    const queue = el.querySelector(`.${PREFIX}-cur-queue-scroll`);
    if (queue && this._curationScroll) queue.scrollTop = this._curationScroll;
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
    // The filter reads this attribute, the chip below reads the same set. Repainting
    // the chip without the attribute would leave "Newly added Feats" filtering on the
    // answer from the last full render.
    row.dataset.new = String(this._newFeats.has(uuid));
    row.classList.toggle('is-uncurated', uncurated);
    row.classList.toggle('is-hidden', feat.hidden);

    const chips = row.querySelector(`.${PREFIX}-reg-chips`);
    if (chips) chips.replaceChildren(...this._buildChips(feat, uncurated));

    this._paintBadges(
      Object.keys(this.#config.feats ?? {}).length
        ? [...this.element.querySelectorAll(`.${PREFIX}-reg-feat`)].filter(
            r => r.dataset.uncurated === 'true'
          ).length
        : 0
    );

    this._applyRegFilters();
  }

  /**
   * Repaints one Curation queue row from the working copy.
   *
   * The queue row is derived state exactly as the Feats tab's chips are, and for the
   * same reason it cannot re-render: picking a Category is a keystroke away from
   * picking the next one, and render() resets scroll and steals focus. The row stays
   * in place once curated — it leaves only on File — so what changes here is the level
   * badge, the Category chip and the still-uncurated marker.
   *
   * @param {string} uuid
   */
  _refreshCurationRow(uuid) {
    const row = [...(this.element?.querySelectorAll(`.${PREFIX}-cur-row[data-uuid]`) ?? [])].find(
      el => el.dataset.uuid === uuid
    );
    if (!row) return;
    const feat = normalizeFeat(uuid, this.#config.feats?.[uuid]);
    const uncurated = isUncurated(feat);
    const was = row.dataset.uncurated === 'true';

    row.classList.toggle('is-uncurated', uncurated);
    row.dataset.uncurated = String(uncurated);

    const level = row.querySelector(`.${PREFIX}-cur-row-level`);
    if (level) level.textContent = `${game.i18n.localize('RDHF.catalog.levelShort')} ${feat.level}`;

    const category = row.querySelector(`.${PREFIX}-cur-row-category`);
    if (category) {
      const entry = this.#categories.find(c => c.id === feat.category);
      category.textContent = feat.category ? taxonomyLabel(entry) || feat.category : '';
      category.hidden = !feat.category;
      const withheld = Boolean(feat.category) && entry?.hidden === true;
      category.classList.toggle('is-hidden', withheld);
      if (withheld) category.dataset.tooltip = game.i18n.localize('RDHF.registry.withheldByCategory');
      else delete category.dataset.tooltip;
    }

    // The header counts what is still outstanding, so it moves the moment a Category
    // is chosen even though the row itself stays put. Every uncurated feat that has not
    // been filed IS a queue row, so the rows are the whole population.
    const outstanding = [
      ...this.element.querySelectorAll(`.${PREFIX}-cur-row[data-uncurated="true"]`)
    ].length;
    const counter = this.element.querySelector(`.${PREFIX}-cur-outstanding`);
    if (counter) counter.textContent = String(outstanding);

    // Rows that now have a Category and are only waiting on File. Without this the
    // queue looks like it is not shrinking as the GM works.
    const rows = this.element.querySelectorAll(`.${PREFIX}-cur-row`).length;
    const ready = this.element.querySelector(`.${PREFIX}-cur-ready`);
    if (ready) {
      ready.textContent = game.i18n.format('RDHF.curation.readyCount', {
        count: rows - outstanding
      });
      ready.hidden = rows - outstanding === 0;
    }

    // The Feats tab badge counts ALL uncurated feats, filed ones included, so it cannot
    // be read off the queue. Carried as a running total from the last render and moved
    // by this one edit — the same repaint-don't-re-render rule, one tab over.
    if (was !== uncurated) {
      this._paintBadges((this._uncuratedTotal ?? 0) + (uncurated ? 1 : -1));
    }

    // Filing a feat that still has no Category is legal but temporary, and the GM
    // should know that before they press it rather than after it reappears.
    if (uuid === this._curationUuid) {
      const note = this.element.querySelector(`.${PREFIX}-cur-file-note`);
      if (note) note.hidden = !uncurated;
    }
  }

  /** One chip element. Kept tiny because _buildChips calls it six times a row. */
  _chip(modifier, text, { icon = null, tooltip = null, withheld = false } = {}) {
    const chip = document.createElement('span');
    chip.className = `${PREFIX}-chip ${PREFIX}-chip--${modifier}${withheld ? ' is-hidden' : ''}`;
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

    // A hidden Category or Type withholds the feat from players just as feat.hidden
    // does, so the chip that causes it says so. Marked per chip, not once per row: the
    // GM needs to know which entry to untick.
    if (feat.category) {
      const entry = this.#categories.find(c => c.id === feat.category);
      chips.push(
        this._chip('category', taxonomyLabel(entry) || feat.category, {
          withheld: entry?.hidden === true,
          icon: entry?.hidden ? 'fa-solid fa-eye-slash' : null,
          tooltip: entry?.hidden ? game.i18n.localize('RDHF.registry.withheldByCategory') : null
        })
      );
    }
    for (const id of feat.types ?? []) {
      const entry = this.#types.find(t => t.id === id);
      chips.push(
        this._chip('type', taxonomyLabel(entry) || id, {
          withheld: entry?.hidden === true,
          icon: entry?.hidden ? 'fa-solid fa-eye-slash' : null,
          tooltip: entry?.hidden ? game.i18n.localize('RDHF.registry.withheldByType') : null
        })
      );
    }
    if (uncurated) {
      chips.push(
        this._chip('uncurated', game.i18n.localize('RDHF.catalog.uncurated'), {
          tooltip: game.i18n.localize('RDHF.catalog.uncuratedTooltip')
        })
      );
    }
    if (this._newFeats.has(feat.uuid)) {
      chips.push(
        this._chip('new', game.i18n.localize('RDHF.catalog.new'), {
          tooltip: game.i18n.localize('RDHF.catalog.newTooltip')
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
    // An exempt feat is an exception to a world-level rule, and the whole point of an
    // exception is being able to find it again in a long list.
    if (feat.autoExempt) {
      chips.push(
        this._chip('exempt', '', {
          icon: 'fa-solid fa-robot',
          tooltip: game.i18n.localize('RDHF.registry.autoExemptTooltip')
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
        // No connector, and no placeholder element standing in for one: the row drops
        // to a three-column template instead. The 1fr category column absorbs the
        // difference, so the count and remove controls still line up down the list.
        line.classList.add(`${PREFIX}-investment-row--first`);
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

  /**
   * Wires one feat's "Other Feats or Features" search box.
   *
   * Typing a UUID by hand used to be the only way to name a prerequisite that was not
   * to hand for a drag. This searches every Feature the registry knows about by name
   * and adds the one picked, so the GM never has to see a UUID at all.
   *
   * @param {HTMLElement} row  the feat's <details>
   */
  _bindReferenceSearch(row) {
    const box = row.querySelector(`.${PREFIX}-ref-search`);
    const input = box?.querySelector(`.${PREFIX}-ref-search-input`);
    const results = box?.querySelector(`.${PREFIX}-ref-results`);
    if (!input || !results) return;

    const close = () => {
      results.replaceChildren();
      results.hidden = true;
    };

    const currentRefs = () =>
      (row.querySelector('[data-field="features"]')?.value ?? '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

    const add = uuid => {
      const refs = currentRefs();
      if (!refs.includes(uuid)) refs.push(uuid);
      this._setReferences(row, refs);
      input.value = '';
      close();
    };

    const paint = () => {
      const query = input.value.trim().toLowerCase();
      if (!query) return close();

      // Already-referenced Feats are dropped, and so is the feat being edited — a
      // requirement on itself could never be met.
      const taken = new Set(currentRefs());
      taken.add(row.dataset.uuid);

      const matches = [...this.#sourceNames]
        .filter(([uuid, name]) => !taken.has(uuid) && String(name).toLowerCase().includes(query))
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
        .slice(0, MAX_REFERENCE_RESULTS);

      results.replaceChildren();
      if (!matches.length) {
        const empty = document.createElement('li');
        empty.className = `${PREFIX}-ref-result-empty`;
        empty.textContent = game.i18n.localize('RDHF.registry.featureSearchEmpty');
        results.appendChild(empty);
      }
      for (const [uuid, name] of matches) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${PREFIX}-ref-result`;
        button.dataset.uuid = uuid;
        button.textContent = name;
        // mousedown, not click: the input's blur tears the list down before a click
        // would ever land on it.
        button.addEventListener('mousedown', event => {
          event.preventDefault();
          add(uuid);
        });
        item.appendChild(button);
        results.appendChild(item);
      }
      results.hidden = false;
    };

    input.addEventListener('input', paint);
    input.addEventListener('focus', paint);
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        input.value = '';
        close();
      } else if (event.key === 'Enter') {
        // The box sits inside the registry form; a stray Enter would submit it.
        event.preventDefault();
        const first = results.querySelector(`.${PREFIX}-ref-result`);
        if (first) add(first.dataset.uuid);
      }
    });
  }

  /** Writes a reference list back to the field and re-chips it. */
  /**
   * Writes the uncurated count onto EVERY tab badge and keeps the running total in
   * step with it.
   *
   * The badge sits on Curation — the tab that clears the count. querySelectorAll rather
   * than querySelector because a nav is free to grow a second badge: the singular lookup
   * would paint whichever came first in the DOM and leave the other stale, which is a
   * silent wrong number rather than a visible break.
   *
   * @param {number} count
   */
  _paintBadges(count) {
    this._uncuratedTotal = Math.max(0, count);
    for (const badge of this.element?.querySelectorAll(`.${PREFIX}-tab-badge`) ?? []) {
      badge.textContent = String(this._uncuratedTotal);
      badge.hidden = this._uncuratedTotal === 0;
    }
  }

  /**
   * The feat host an event target sits in, on whichever tab that is.
   *
   * Action handlers get the clicked element, not the feat, so each one has to walk up
   * to the container carrying data-uuid. Going through here rather than writing the
   * selector at each call site is what stops the next handler being added Feats-only.
   *
   * @param {HTMLElement|null} el
   * @returns {HTMLElement|null}
   */
  _featHost(el) {
    return el?.closest(FEAT_HOST) ?? null;
  }

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
        isNew: row.dataset.new === 'true',
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

    // App-level Rule Automation fields. Like pointFormula they belong to no feat, so
    // they must be handled before the uuid guard below.
    if (field === 'automationEnabled') {
      this.#automation.investmentByLevel.enabled = value === true;
      this._paintAutomationState();
      return;
    }

    if (field === 'automationLevel') {
      const level = String(Math.floor(Number(input.dataset.level) || 1));
      this.#automation.investmentByLevel.table[level] = Math.max(0, Math.floor(Number(value) || 0));
      return;
    }

    if (field.startsWith('category.') || field.startsWith('type.')) {
      const [kind, prop] = field.split('.');
      const list = kind === 'category' ? this.#categories : this.#types;
      const entry = list.find(e => e.id === input.closest('[data-entry-id]')?.dataset.entryId);
      // Every other taxonomy field is text; `hidden` is the one checkbox, and
      // String(true) would store the word rather than the flag.
      if (entry) entry[prop] = prop === 'hidden' ? value === true : String(value);
      // Repainted, not re-rendered — the Taxonomy tab is a form the GM may be several
      // fields into, and render() would reset its scroll and steal focus. The class
      // drives the dimmed row and the lit eye, so without this the state only appears
      // on the next render for some other reason.
      if (entry && prop === 'hidden') {
        input.closest('[data-entry-id]')?.classList.toggle('is-hidden', entry.hidden === true);
      }
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
        // "Newly added" measures the moment a feat became available to players, which
        // is the moment it gained a Category. Re-filing a curated feat re-stamps it:
        // the filter says "recently curated", not "first curated ever".
        feat.curatedAt = feat.category ? Date.now() : 0;
        break;
      case 'summary':
        feat.summary = String(value);
        break;
      case 'hidden':
        feat.hidden = value === true;
        break;
      case 'autoExempt':
        feat.autoExempt = value === true;
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
    if (['level', 'category', 'type', 'hidden', 'autoExempt'].includes(field)) {
      // Curating changes the newest-ten set, which can add a chip to this row and take
      // one off another. Recompute first so _refreshRow below paints the new answer.
      const moved = field === 'category' ? this._recomputeNewFeats() : [];
      this._refreshRow(uuid);
      this._refreshCurationRow(uuid);
      for (const other of moved) if (other !== uuid) this._refreshRow(other);
    }

    // These five are exactly the fields that can flip whether Rule Automation applies
    // to this feat. Painted, never re-rendered: _renderInvestment rebuilds the whole
    // row list, which would steal focus from a count input mid-keystroke.
    if (
      ['level', 'category', 'autoExempt', 'investmentCount', 'investmentCategory'].includes(field)
    ) {
      this._paintAutoInvestment(this._featHost(input));
    }

    if (REQUIREMENT_FIELDS.includes(field)) {
      this._paintRequirementLine(this._featHost(input));
    }
  }

  /**
   * Recomputes which feats count as newly curated, and returns the uuids whose
   * membership changed so the caller can repaint exactly those rows.
   *
   * Filing one feat can move two rows: the new arrival gains the chip and whatever was
   * tenth loses it. Repainting only the row being edited would leave that second row
   * wearing a stale chip until the next full render — the same class of lag the rest of
   * _refreshRow exists to prevent.
   */
  _recomputeNewFeats() {
    const before = this._newFeats;
    const after = newestCurated(
      Object.entries(this.#config.feats ?? {}).map(([uuid, stored]) => ({
        uuid,
        curatedAt: Number(stored?.curatedAt) || 0
      }))
    );
    this._newFeats = after;
    return [...new Set([...before, ...after])].filter(uuid => before.has(uuid) !== after.has(uuid));
  }

  /** Greys the curve table while the rule is off. Repaint, never a re-render. */
  _paintAutomationState() {
    const pane = this.element?.querySelector(`.${PREFIX}-auto-table`);
    if (!pane) return;
    pane.classList.toggle('is-disabled', this.#automation.investmentByLevel.enabled !== true);
  }

  /**
   * Writes the read-only "this feat's requirement comes from the rule" line into one
   * feat host.
   *
   * It lives OUTSIDE .rdhf-investment-list on purpose — that list is rebuilt wholesale
   * by _renderInvestment, so folding this line into it would tie a passive note to a
   * destructive repaint. The host is resolved through _featHost, never a call-site
   * selector, so it works on the Curation editor as well as a Feats row.
   *
   * @param {HTMLElement|null} host
   */
  _paintAutoInvestment(host) {
    const line = host?.querySelector(`.${PREFIX}-auto-invest`);
    if (!line) return;

    const say = (key, data, muted) => {
      line.textContent = data ? game.i18n.format(key, data) : game.i18n.localize(key);
      line.classList.toggle('is-overridden', muted);
      line.hidden = false;
    };

    const uuid = host.dataset.uuid;
    const rule = this.#automation?.investmentByLevel;
    const feat = normalizeFeat(uuid, this.#config.feats?.[uuid]);

    // Off, or a Level the curve asks nothing of: there is nothing to announce, and a
    // note on every Level 1 feat would be noise on the row the GM reads most.
    const would = rule?.enabled === true ? investmentForLevel(feat.level, rule.table) : 0;
    if (!would) {
      line.textContent = '';
      line.classList.remove('is-overridden');
      line.hidden = true;
      return;
    }

    if (feat.autoExempt) {
      say('RDHF.registry.autoInvestmentExempt', { count: would }, true);
      return;
    }

    // Uncurated, and therefore mid-curation: this is the moment the hint is worth the
    // most, because filing the Category is exactly the act that turns the rule on for
    // this feat. Said forward-looking, since the Category is not chosen yet.
    if (!feat.category) {
      say('RDHF.registry.autoInvestmentPending', { count: would, level: feat.level }, true);
      return;
    }

    // General is exempt by design. Stated rather than left blank, so a GM filing under
    // General learns why this feat is the one without an automatic requirement.
    if (feat.category === GENERAL_CATEGORY_ID) {
      say('RDHF.registry.autoInvestmentGeneral', null, true);
      return;
    }

    const category =
      taxonomyLabel(this.#categories.find(c => c.id === feat.category)) || feat.category;
    const row = autoInvestmentRow(feat, rule);

    if (row) {
      say('RDHF.registry.autoInvestment', { count: row.count, category, level: feat.level }, false);
      return;
    }

    // The rule would apply but the GM's own rows take precedence. Say what it WOULD
    // have asked for, so the deviation they are authoring is visible next to it.
    say('RDHF.registry.autoInvestmentOverridden', { count: would, category }, true);
  }

  /**
   * Writes the collapsed "Requires" line into one Feats row.
   *
   * The point of it is scanning: a GM curating a chain needs to see what every feat
   * asks for while scrolling past it, not by opening each one in turn. So the line
   * carries the same clauses, in the same order, worded the same way as the player
   * catalog — through the very same evaluator — but with NO met/unmet colour, because
   * there is no character here for "met" to mean anything against. The Level clause is
   * dropped by describeRequirements: the row already wears a Level chip.
   *
   * Rule Automation is applied first, exactly as listFeats does for players, so the
   * derived investment clause appears here even though it has no editable row behind
   * it. That is the whole value of the line — it reports what the table will face, not
   * what the GM happened to type. The read-only automation note inside the open form is
   * where the same fact is attributed to the rule.
   *
   * Only the Feats tab has this element. Passed a Curation editor the querySelector
   * misses and the call is a no-op, which is why it can sit in the shared FEAT_HOST
   * loop unguarded.
   *
   * @param {HTMLElement|null} host
   */
  _paintRequirementLine(host) {
    const line = host?.querySelector(`.${PREFIX}-reg-reqs`);
    if (!line) return;

    const uuid = host.dataset.uuid;
    const feat = applyAutoInvestment(
      normalizeFeat(uuid, this.#config.feats?.[uuid]),
      this.#automation?.investmentByLevel
    );

    const labels = describeRequirements(feat, {
      categoryLabels: Object.fromEntries(
        this.#categories.map(c => [c.id, taxonomyLabel(c) || c.id])
      ),
      // A requirement may name another Feat by UUID; #sourceNames is the same map the
      // reference chips resolve against, so both render the Feature's actual name.
      featLabels: Object.fromEntries(this.#sourceNames)
    });

    // The heading is markup, not derived, so it is kept rather than rebuilt.
    const heading = line.querySelector(`.${PREFIX}-req-label`);
    line.replaceChildren(heading, ...labels.map(text => this._chip('req', text)));
    line.hidden = labels.length === 0;
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

    // Target A: the "Other Feats or Features" requirement block. Works from any tab,
    // because that is where the GM is when they want it. The whole block counts, not
    // just the text field — that field now lives inside a collapsed <details>, so on a
    // normal drop it is not even visible to aim at.
    const refBlock = event.target?.closest?.(`.${PREFIX}-ref-block`);
    const refInput = refBlock?.querySelector('[data-field="features"]');
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
    const row = this._featHost(input);
    if (row) this._renderReferenceChips(row);
    ui.notifications?.info(game.i18n.format('RDHF.notify.featureRefAdded', { name: item.name }));
  }

  /* ── Actions ─────────────────────────────────────────────────────────────── */

  /**
   * Swaps the statistics grid between its Category and Type rows.
   *
   * Both grids are rendered; this toggles which one is shown, exactly as the player
   * catalog does for Catalog / My Feats. A re-render would reset the scroll position
   * of a tab a GM is reading down.
   */
  static _onStatsAxis(event, target) {
    event.preventDefault();
    this._statsAxis = target.dataset.axis === 'type' ? 'type' : 'category';
    for (const button of this.element.querySelectorAll(`.${PREFIX}-axis-btn[data-axis]`)) {
      button.classList.toggle('is-active', button.dataset.axis === this._statsAxis);
    }
    for (const grid of this.element.querySelectorAll(`.${PREFIX}-heat[data-axis]`)) {
      grid.hidden = grid.dataset.axis !== this._statsAxis;
    }
  }

  /**
   * Reveals the Coverage gaps rows held back by MAX_GAP_ROWS, and puts them back.
   *
   * Repainted, never re-rendered — and here that is not only the usual scroll-and-focus
   * argument. Rebuilding this context runs the whole statistics pass, which reads every
   * actor in the world; asking to see the rest of a list already sitting in the DOM has
   * no business costing that. The rows and both button labels render their own state
   * from `_showAllGaps`, so this is only the in-place half of the same switch.
   */
  static _onToggleGaps(event, target) {
    event.preventDefault();
    this._showAllGaps = !this._showAllGaps;
    for (const li of this.element.querySelectorAll('li[data-gap-overflow="true"]')) {
      li.hidden = !this._showAllGaps;
    }
    // Both labels are in the markup and one of them is hidden, so the script stays
    // free of display strings exactly as the rest of the module does.
    for (const label of target.querySelectorAll('[data-gaps-label]')) {
      label.hidden = (label.dataset.gapsLabel === 'fewer') !== this._showAllGaps;
    }
    target.querySelector('[data-gaps-icon]')?.classList.toggle('fa-chevron-up', this._showAllGaps);
    target.querySelector('[data-gaps-icon]')?.classList.toggle('fa-chevron-down', !this._showAllGaps);
  }

  /**
   * Sets one character aside from the adoption figures, or puts them back.
   *
   * This one DOES re-render, unlike the axis and gap toggles beside it: the numbers
   * themselves move — Most taken, Recent acquisitions and every counter — so there is
   * no repaint short of rebuilding the panel, and rebuilding it by hand would duplicate
   * markup the template already declares. The scroll position is preserved by render()
   * as it is for every other action here.
   */
  static _onToggleLedgerActor(event, target) {
    event.preventDefault();
    const id = target.dataset.actorId;
    if (!id) return;
    if (this._excludedActors.has(id)) this._excludedActors.delete(id);
    else this._excludedActors.add(id);
    this.render();
  }

  /**
   * Clicking a grid cell lands on the Feats tab showing exactly that cell's contents.
   *
   * The whole point of spotting "level 7 Alchemy is empty" is being one click from the
   * rows themselves — including when the answer is no rows at all.
   */
  static _onFocusCell(event, target) {
    event.preventDefault();
    const { row, level, axis } = target.dataset;
    if (!row) return;

    this._filters = blankFilterState();
    this._uncuratedOnly = false;
    this._hiddenOnly = false;

    // Uncurated is a grid row but not a Category, so it maps to the rail's own switch.
    if (row === UNCURATED_ROW) this._uncuratedOnly = true;
    else if (axis === 'type') this._filters.types = [row];
    else this._filters.categories = [row];

    if (level) {
      this._filters.levelMin = Number(level);
      this._filters.levelMax = Number(level);
    }

    this._tab = 'feats';
    this.render();
  }

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

  /**
   * Sources tab — unregisters a standalone Feature outright. This is the only place a
   * standalone entry may legitimately be deleted: the entry IS the registration, so
   * there is no pack to rediscover it from afterwards.
   */
  static async _onRemoveFeat(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.registry.unregisterTitle') },
      content: `<p>${game.i18n.format('RDHF.registry.unregisterBody', {
        name: foundry.utils.escapeHTML(this.#sourceNames.get(uuid) ?? uuid)
      })}</p>`
    });
    if (!confirmed) return;

    delete this.#config.feats[uuid];
    this.render();
  }

  /**
   * Feats tab — clears a feat's curation and starts it over as uncurated.
   *
   * The distinction is load-bearing. A pack-sourced feat is rediscovered by
   * loadAllSourceFeatures on the next render whether or not it has a registry entry,
   * so dropping the entry IS a reset. A **standalone** feat is reachable only because
   * its entry exists — dropping that entry unregistered it from the module entirely,
   * which is emphatically not what "reset this feat's metadata" promises. So a
   * standalone feat is rewritten blank instead, keeping the flag that lists it on the
   * Sources tab.
   */
  static async _onResetFeat(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid) return;
    const standalone = this.#config.feats?.[uuid]?.standalone === true;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('RDHF.registry.resetFeatTitle') },
      content: `<p>${game.i18n.format('RDHF.registry.resetFeatBody', {
        name: foundry.utils.escapeHTML(this.#sourceNames.get(uuid) ?? uuid)
      })}</p>`
    });
    if (!confirmed) return;

    if (standalone) this.#config.feats[uuid] = { ...blankFeat(uuid), standalone: true };
    else delete this.#config.feats[uuid];
    this.render();
  }

  static _onAddCategory(event) {
    event.preventDefault();
    this.#categories.push({
      id: foundry.utils.randomID(),
      label: game.i18n.localize('RDHF.registry.newCategory'),
      icon: 'fa-solid fa-flask',
      description: '',
      hidden: false
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
      icon: 'fa-solid fa-tag',
      hidden: false
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
    const row = this._featHost(target);
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
    // Adding the first row suppresses the rule, removing the last restores it.
    this._paintAutoInvestment(row);
    this._paintRequirementLine(row);
  }

  static _onRemoveInvestment(event, target) {
    event.preventDefault();
    const row = this._featHost(target);
    const uuid = row?.dataset.uuid;
    const index = Number(target.dataset.index);
    this.#config.feats[uuid]?.requirements?.categoryInvestment.splice(index, 1);
    if (row) {
      this._renderInvestment(row);
      this._paintAutoInvestment(row);
      this._paintRequirementLine(row);
    }
  }

  /** Restores the seeded investment curve. Still a working copy until Save. */
  static _onResetAutomation(event) {
    event.preventDefault();
    this.#automation.investmentByLevel.table = foundry.utils.deepClone(DEFAULT_INVESTMENT_BY_LEVEL);
    this.render();
  }

  /** Removes one requirement reference chip and rewrites the field behind it. */
  static _onRemoveReference(event, target) {
    event.preventDefault();
    const row = this._featHost(target);
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
    const row = this._featHost(target);
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

  /* ── Curation ────────────────────────────────────────────────────────────── */

  /**
   * The queue as it currently stands, read off the DOM.
   *
   * The rendered rows ARE the queue, in queue order, so there is nothing to recompute
   * — and recomputing would mean re-indexing every source pack to answer "which feat
   * comes after this one".
   */
  _curationOrder() {
    return [...(this.element?.querySelectorAll(`.${PREFIX}-cur-row[data-uuid]`) ?? [])].map(el => ({
      uuid: el.dataset.uuid
    }));
  }

  static _onCurationSelect(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid || uuid === this._curationUuid) return;
    this._curationUuid = uuid;
    this.render();
  }

  /**
   * Commits the open feat to the world and drops it out of the queue.
   *
   * The write is surgical — see #commitFeat. Filing a feat that still has no Category
   * is allowed and means "done with this for now": it leaves the session's queue, and
   * because the queue is derived from the registry it is simply back the next time the
   * registry opens. The pane says so before the button is pressed.
   */
  static async _onCurationFile(event) {
    event.preventDefault();
    const uuid = this._curationUuid;
    if (!uuid) return;

    try {
      await this.#commitFeat(uuid);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to file feat ${uuid}:`, err);
      ui.notifications?.error(game.i18n.localize('RDHF.notify.fileFailed'));
      return;
    }

    // Read the order BEFORE filing: the row is still present, so "the one after this"
    // is answerable, and the fallback to the previous row keeps the selection where
    // the GM was working instead of throwing them to the top.
    this._curationUuid = nextInQueue(this._curationOrder(), uuid);
    this._curationFiled.add(uuid);
    this.render();
  }

  /** Moves on without filing or writing. Wraps, so a skipped feat is reachable again. */
  static _onCurationSkip(event) {
    event.preventDefault();
    const uuid = this._curationUuid;
    if (!uuid) return;
    const next = nextInQueue(this._curationOrder(), uuid, { wrap: true });
    if (!next || next === uuid) return;
    this._curationUuid = next;
    this.render();
  }

  static async _onSave(event) {
    event.preventDefault();
    await this.#commit();
    this.close();
  }

  /* ── Unsaved work ────────────────────────────────────────────────────────── */

  /** The four working copies as one object. References, not a clone. */
  #snapshot() {
    return {
      registry: this.#config,
      categories: this.#categories,
      types: this.#types,
      formula: this.#formula,
      automation: this.#automation
    };
  }

  /**
   * Absorbs investment rows that merely restate the Rule Automation curve.
   *
   * A row equal to what the rule would derive, in the feat's own Category, means the
   * GM applied the curve by hand — so the feat opts IN rather than out. Matching on
   * the value alone is not durable, though: retune the curve and the stored number no
   * longer matches, and the feat would quietly desert the rule frozen at its old
   * value. Removing the row is what makes the adoption permanent.
   *
   * Run from _prepareContext (so the GM sees it, and Discard reverts it) and again
   * inside both commit paths (a curve edit changes what "redundant" means without
   * re-rendering, and Save must not persist a row the rule has just absorbed).
   *
   * @param {string|null} only  restrict to one uuid, for the single-feat commit
   * @returns {boolean}  whether anything changed
   */
  #adoptRedundantInvestment(only = null) {
    const rule = this.#automation?.investmentByLevel;
    if (!rule?.enabled || !this.#config?.feats) return false;

    let changed = false;
    for (const [uuid, entry] of Object.entries(this.#config.feats)) {
      if (only && uuid !== only) continue;
      const feat = normalizeFeat(uuid, entry);
      const stripped = stripRedundantInvestment(feat, rule);
      if (stripped === feat) continue;
      entry.requirements = stripped.requirements;
      changed = true;
    }
    return changed;
  }

  /**
   * Comparable JSON with every object's keys sorted, at every depth.
   *
   * JSON rather than a deep-equality helper because these four ARE the world settings
   * and are stored the same way, so anything that round-trips through a setting is
   * representable here. The key sort is what makes the comparison safe: Curation's
   * File rebases one feat's key in the baseline, and `registry.feats` is keyed by
   * uuid, so a rebased entry lands wherever object insertion order puts it. Comparing
   * raw JSON would read that as an edit and prompt about work that is already on disk.
   */
  #stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(v => this.#stableJson(v)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map(k => `${JSON.stringify(k)}:${this.#stableJson(value[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
  }

  /** True once anything in the working copy has moved away from what is on disk. */
  #isDirty() {
    if (this.#baseline === null) return false;
    return this.#stableJson(this.#snapshot()) !== this.#stableJson(this.#baseline);
  }

  /** Writes all four working copies through, and rebases so the app is clean again. */
  async #commit() {
    this.#adoptRedundantInvestment();
    await setRegistry(this.#config);
    await setCategories(this.#categories);
    await setTypes(this.#types);
    await game.settings.set(MODULE_ID, SETTINGS.POINT_FORMULA, this.#formula);
    await setAutomation(this.#automation);
    invalidatePackCache();
    this.#baseline = foundry.utils.deepClone(this.#snapshot());
    ui.notifications?.info(game.i18n.localize('RDHF.notify.saved'));
  }

  /**
   * Writes ONE feat through to the world and rebases only that key of the baseline.
   *
   * Everything else the GM has touched this session — taxonomy, sources, the point
   * formula, other feats — stays in the working copy and still needs Save, and the
   * close prompt still catches it. Returns false when there was nothing to write, so
   * File on an untouched feat costs no setting write and no broadcast.
   *
   * @param {string} uuid
   * @returns {Promise<boolean>}  whether anything reached the world
   */
  async #commitFeat(uuid) {
    const entry = this.#config.feats?.[uuid];
    if (!entry || !this.#baseline) return false;

    // Before the comparison, not after: a row the rule has absorbed must not be what
    // makes this write look unnecessary, nor be persisted by it.
    this.#adoptRedundantInvestment(uuid);

    const saved = this.#baseline.registry?.feats?.[uuid];
    if (saved && this.#stableJson(saved) === this.#stableJson(entry)) return false;

    await saveFeatEntry(uuid, entry);
    this.#baseline.registry.feats ??= {};
    this.#baseline.registry.feats[uuid] = foundry.utils.deepClone(entry);
    return true;
  }

  /**
   * "Working copy, save on Save" means closing the window throws every edit away, and
   * the window closes on the header X, on Escape and on a click outside — none of which
   * read as destructive. So an edited registry asks first.
   *
   * DialogV2.wait with one button per outcome, not confirm(): the choice is three-way,
   * and a button's callback return value IS the dialog's result, so `confirm` could
   * only ever distinguish two of them. `rejectClose: false` turns a dismissed dialog
   * into null, which is treated as Cancel — dismissing a "you have unsaved work" prompt
   * must never be the thing that discards it.
   */
  async close(options = {}) {
    if (options.rdhfDiscard || !this.#isDirty()) return super.close(options);

    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize('RDHF.registry.unsavedTitle') },
      content: `<p>${game.i18n.localize('RDHF.registry.unsavedBody')}</p>`,
      rejectClose: false,
      buttons: [
        {
          action: 'save',
          icon: 'fa-solid fa-floppy-disk',
          label: 'RDHF.registry.unsavedSave',
          default: true,
          callback: () => 'save'
        },
        {
          action: 'discard',
          icon: 'fa-solid fa-trash',
          label: 'RDHF.registry.unsavedDiscard',
          callback: () => 'discard'
        },
        {
          action: 'cancel',
          icon: 'fa-solid fa-xmark',
          label: 'RDHF.registry.unsavedCancel',
          callback: () => 'cancel'
        }
      ]
    });

    if (choice === 'save') await this.#commit();
    else if (choice !== 'discard') return this; // cancel, or the dialog was dismissed

    return super.close(options);
  }
}
