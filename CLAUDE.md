# remito-daggerheart-hero-feats — Notes for Future Work

Foundry VTT **v14** module for the **Daggerheart** system (verified against 2.7.1). Facts below
were checked against the live installs at
`C:\Users\rafae\AppData\Local\FoundryVTT\Data\systems\daggerheart\` and the sibling modules on this
machine — re-check both if Foundry or the system moves forward.

## Commands

**There is no build step, no bundler, no linter and no test suite** — plain ES modules loaded
directly by Foundry from `module.json`. The repo root *is* the module folder.

To run: the repo is already junctioned into Foundry as
`%LOCALAPPDATA%\FoundryVTT\Data\modules\remito-daggerheart-hero-feats`. Enable it in a v14 world
running Daggerheart, reload (no HMR), and look for `remito-daggerheart-hero-feats | Ready.` in the
console.

Two things *can* be checked outside Foundry, and should be after any change:

- `scripts/logic/*.mjs` is pure — no `game.*`, no documents, no Foundry APIs. It imports only
  `constants.mjs`. That means `node` can import and exercise it directly.
- A static pass can verify import specifiers against real named exports, i18n keys used against
  `lang/en.json` in both directions, and every `data-action` in a template against a registered
  handler. Both were run when this module was written and were clean.

Everything else is verified by driving the UI.

Releasing: bump `version` in `module.json`, add a `## Changelog` entry at the bottom of
`README.md` (newest first, `### vX.Y.Z`, user-facing wording — the convention shared with
`daggerheart-languages` and `foundry-plot-board`), then commit and tag. The manifest and download
URLs point at raw GitHub `main`, so **the push is the release**.

## Architecture

```
hero-feats.mjs              entry: settings, hooks, module API, renderSettings button
scripts/
  constants.mjs             MODULE_ID, FLAGS, SETTINGS, TEMPLATES, TRAITS, RESOURCE_REQS, LEVEL_ANCHOR
  settings.mjs              registration + typed accessors (the ONLY place game.settings is touched)
  data/
    registry.mjs            compendium pack indexing, feat records, GM mutations
    actor-state.mjs         the ONLY place actor flags are touched; snapshot, grant, revoke, points
    resync.mjs              pushing an edited source Feature back to the copies characters own
    analytics.mjs           the ONLY actor read for statistics; gathers the acquisition ledger
    migrations.mjs          one-way world data migrations, run once each by the GM on ready
  logic/                    PURE — plain values in, plain values out
    requirements.mjs        structured checks + the AND/OR expression grammar
    points.mjs              total / spent / remaining
    filters.mjs             catalog filter predicate and sort comparators
    statistics.mjs          catalog-shape, coverage-gap and adoption derivation
    curation.mjs            the Curation queue's membership rule and advance order
    automation.mjs          Rule Automation: the derived-requirement rules
  apps/
    feat-catalog.mjs        player + GM catalog (one instance per actor, tracked in openCatalogs)
    feat-registry-config.mjs  GM registry (6 tabs), registered via registerMenu
  badge/badge.mjs           renderActorSheetV2 injection next to Level
```

Import direction is one-way: `apps/` → `data/` → `logic/` → `constants.mjs`.

## Data shapes

World setting `registry`:

```js
{
  sources: [{ packId: 'world.my-feats', enabled: true }],
  feats: {
    '<item uuid>': {
      uuid, level: 1,
      category: null,            // null === UNCURATED === withheld from players
      types: ['combat'],
      hidden: false,             // GM secret: withheld even once curated
      autoExempt: false,         // opts this feat out of every Rule Automation rule
      summary: '',               // GM teaser; blank falls back to the description
      standalone: false,         // registered by drag and drop, not from a pack source
      requirements: {
        resources: { hitPoints, stress, hope, evasion },   // minimum MAX values
        traits:    { agility … knowledge },
        features: [], classes: [], subclasses: [],          // any-of within each list
        categoryInvestment: [{ category, count, join }],   // join: connector to the PREVIOUS row
        expression: ''                                      // optional escape hatch
      }
    }
  }
}
```

World settings `categories` / `types` are `[{ id, label, icon, description }]`. A `label` starting
with `RDHF.` is an i18n key (the seeded entries); anything else is literal GM text. Editing a seeded
label in the Taxonomy tab converts it to literal text — that is intended.

World setting `automation` is `{ investmentByLevel: { enabled, table } }`, where `table` maps a
Level to the number of Feats required in a Category. **Its keys are strings**: the setting
round-trips through JSON, which has no numeric keys, so reading `table[7]` works only by accident of
coercion and `Object.keys()` yields strings either way — `investmentForLevel` normalizes both ends.
`getAutomation()` runs every read through `normalizeAutomation`, which rebuilds the table from the
ten default keys rather than copying the stored one, so a partial or hand-edited value cannot reach
the rule.

**`general` is a fixed Category**, seeded from `DEFAULT_CATEGORIES` and re-inserted by
`getCategories()` if a world ever loses it. It exists so a feat can be *curated* — and therefore
visible to players — without the GM inventing a filing system first. `isFixedCategory()` gates
renaming and deletion. It was a *type* until v1.1.0, which could never lift a feat out of uncurated;
migration 1 files General-typed uncategorised feats under it and strips the type everywhere.

**Ordering lives in the accessors**, not at the call sites: `getCategories()` returns General first
then alphabetical by displayed label, `getTypes()` alphabetical. That is the only way the two filter
rails, the curation dropdowns and the Taxonomy tab can be guaranteed to agree.

`SETTINGS.MIGRATION` holds an integer against `MIGRATION_VERSION`. A migration that throws leaves
the number alone and is retried next load rather than half-applying and being forgotten. Migrations
are GM-only, so every read path still has to tolerate un-migrated data.

Actor flag `actor.flags['remito-daggerheart-hero-feats'].state`:

```js
{ acquired: [{ uuid, itemId, free, at }], pointAdjustment: 0 }
```

`itemId` is the embedded Item the acquisition created, so a revoke deletes exactly that item.
`free: true` marks a GM grant that did not charge a point, is excluded from `spent`, and is what
makes the row read **Granted** rather than **Acquired**.

**`acquired` is an ARRAY, and that is load-bearing — never key a flag object by UUID.**
`foundry.utils.expandObject` (`common/utils/helpers.mjs`) recurses into every plain object and runs
`setProperty` on each key, so a key containing dots is exploded into nested objects at every level.
Item UUIDs are full of dots, so the original object shape silently turned one entry into five
nested levels: reads never matched, the idempotency guard never fired, and `spent` only ever saw the
single `"Compendium"` key — a feat could be bought repeatedly and only the first cost a point.
Arrays are mapped element-wise, so a UUID held in a *value* is safe. `getState` still carries
`recoverLegacyAcquired()`, which rebuilds the list from the mangled nesting (the original UUID is
exactly the path to each leaf). World settings are JSON-stringified and so are *not* affected —
that is why the registry may key `feats` by UUID and the actor flag may not.

## Verified Daggerheart / Foundry v14 facts

- **`renderActorSheet` never fires.** Use `renderActorSheetV2`; the actor is **`app.document`**,
  not `app.actor`.
- **`ApplicationV2` alone renders `static PARTS` empty** — the Handlebars mixin must be explicit.
- **`position.height` must be a fixed integer.** `"auto"` scrolls the page instead of the window.
- **`ApplicationV2` has NO `dragDrop` option.** Only `ActorSheetV2`/`ItemSheetV2` read one. The
  registry builds a `foundry.applications.ux.DragDrop.implementation` by hand and re-binds it in
  `_onRender`, because a re-render replaces the elements the previous bind attached to.
- **Every `<button>` is one line tall and centres its content.** Core's
  `a.button, button, kbd` rule (`public/css/foundry2.css`) declares
  `display: flex; justify-content: center; height: var(--button-size); min-height: var(--button-size)`
  with `--button-size: 2em`. A button used as a *row* — anything stacking two lines, or leading with
  an icon the text must sit beside — is therefore cropped to 2em, its overflow paints over the rows
  around it, and the centring drags the content back across the icon. That was the Curation queue's
  alignment bug in v1.3.1. Any multi-line button has to restate `height: auto; min-height: 0;
  justify-content: flex-start`. Same trap for the padding: core sets `padding: 0 0.5rem`, so a row
  that also carries a state border (`.rdhf-cur-row.is-uncurated`'s 3px left edge) must give the
  extra border width back as padding or the column of icons goes ragged.
- **Compendium UUIDs cannot resolve synchronously.** `fromUuidSync` is world-documents-only, which
  is why full descriptions load lazily on row expand.
- **Roll data — the sibling modules' note is half wrong.** `DhpActor.getRollData()`
  (`build/daggerheart.js:16493`) puts `prof` and `cast` at the top level, but `tier` and `level`
  live under `system` (`DhCharacter.getRollData`, `:33564`). `@tier` alone resolves to nothing.
  `featRollData()` in `data/actor-state.mjs` adds top-level `level` / `tier` / `prof` aliases so a
  GM can write `@level * 2`.
- **`hasSpellcasting` must test `spellcastModifierTrait`, not `spellcastModifier`** — the latter is
  the trait's *value* and is 0 both for a non-caster and for a caster whose trait is 0.
- **The level anchor** is `.character-header-sheet .name-row .level-div h3.label`
  (`templates/sheets/actors/character/header.hbs:12-38`). Under LIMITED permission the header part
  is not rendered at all — a missing anchor is normal, not an error.
- **Granted feats need `originItemType: null`.** `DhCharacter.sheetLists` (`:33319`) buckets
  features by `originItemType`; the catch-all branch takes any feature without one, so a feat lands
  in the sheet's generic **Features** fieldset with no injection at all.
- **There is no "features" compendium.** Feature items live *inside* the `classes`, `subclasses` and
  `ancestries` packs, referenced from each parent's `system.features[].item`.
- **Handlebars `eq` is not available to module templates.** Pre-compute booleans in
  `_prepareContext` — this module does that throughout and registers no helpers.
- `DialogV2.confirm` / `.prompt` live at `foundry.applications.api.DialogV2`, and `content` is raw
  HTML, so every feat name passes through `foundry.utils.escapeHTML`.
- **A `DialogV2` button's callback return value *is* the dialog's result.** `_onSubmit` does
  `(await button.callback(...)) ?? button.action` (`client/applications/api/dialog.mjs:246`), and
  `confirm()` supplies the default `yes` callback `() => true` — so overriding `yes.callback` to
  read a form field replaces that, and the result becomes the button's *action string*. Where the
  outcome matters, use `DialogV2.wait` with one button per outcome and let each callback return its
  own value; that is what `_onGrantAnyway` does for free-versus-charged grants.

## Patterns worth preserving

- **The rail's filter controls render their own state.** `filterCategories` / `filterTypes` carry a
  `checked` flag and the level inputs carry values. Until the statistics grid could set a filter
  programmatically this was invisible — filters were only ever set by clicking those same boxes, and
  `_onClearRegFilters` resets them by writing the DOM rather than re-rendering. Switching tabs *does*
  re-render, so without it a filter set from a grid cell would apply with an untouched rail
  contradicting the visible row count.
- **Filtering never re-renders.** `FeatCatalog._applyFilters` toggles `hidden` on each row's `<li>`
  in place. A re-render on every keystroke steals focus from the search box. Row state lives
  entirely in `data-*` attributes so the filter pass needs no context object.
- **Neither does switching catalog tabs.** Catalog / My Feats are two `.rdhf-section` elements
  rendered at once; `_applyFilters` displays the one matching `_tab` and counts only its rows. The
  registry's tabs *do* re-render, because each is a different form.
- **The GM registry mirrors the player catalog** — same rail, same row shape, same `matchesFilters`
  predicate, so curation happens against the view the table sees. Only the player-facing switches
  (eligibility, hide-acquired) are left out, replaced by "uncurated only" / "hidden only". The
  section order is part of the mirror and is **search, Level, Type, Category, then the switches** in
  both templates — the registry's are `<details>` and the catalog's are plain `<section>`s, so
  nothing but source order keeps them agreeing. Rail open-state is keyed by `data-rail`, never by
  index, so reordering is safe.
- **Requirement checks return descriptors, not strings.** `{ kind, key, data, met }` — the app layer
  localizes. That is what keeps `logic/` free of `game.i18n` and testable in node.
- **Working copy, save on Save.** The registry app clones the setting into `#config`, mutates it on
  every `input`, and writes only in `_onSave`. Open `<details>` state is captured before
  `super.render()` and restored by uuid, never by index.
- **Closing is destructive, so it asks.** `close()` compares a stable-JSON snapshot of the four
  working copies against `#baseline` and offers Save / Discard / Keep editing through `DialogV2.wait`
  — three outcomes, so `confirm()` could not express it, and `rejectClose: false` makes a dismissed
  dialog mean Cancel. A snapshot rather than a dirty flag set at each mutation site: there are a
  dozen of those, and the next one to forget the flag would silently discard the GM's work, which is
  the exact bug this exists to fix. The comparison sorts object keys at every depth because
  `#commitFeat` rebases one uuid-keyed entry and insertion order would otherwise read as an edit.
- **Curation's File is the ONE surgical write.** `saveFeatEntry` merges a single feat's entry into
  the *saved* registry and `#commitFeat` rebases only that key of `#baseline`; taxonomy, sources and
  the formula stay working copies and still need Save. Reusing `#commit()` would have pushed a
  half-renamed Category live as a side effect of filing a feat AND stopped the close prompt from
  firing, because everything would have been committed through a side door. It also skips the write
  entirely when the entry is unchanged.
- **The Curation queue is derived and session-local.** Membership is
  `(uncurated OR already seen) AND NOT filed`, held in two `Set`s on the app instance — no setting,
  no flag, no migration. The `seen` half is load-bearing: choosing a Category stops a feat being
  uncurated, and a queue derived strictly from that would delete the row out from under the GM
  before they could reach its dependencies or traits. Reopening the registry rebuilds the backlog
  from the registry itself, which is what makes filing an uncurated feat safe.
- **The Curation editor is the Feats row's controls in a second host.** It renders from the same
  feat views and carries `data-uuid`, so `_syncField`, `_renderInvestment`, `_renderReferenceChips`,
  `_bindReferenceSearch`, `_renderAtomRows` and `_loadFullDescription` all apply unchanged — every
  one of them takes a container and queries inside it. `_onRender`'s wiring loop selects
  `FEAT_HOST`; `_applyRegFilters` and `_refreshRow` deliberately still match only
  `.rdhf-reg-feat`, because the queue is not filtered.
- **An action handler that names only `.rdhf-reg-feat` is dead on the Curation tab, silently.**
  The helpers above are host-agnostic because each is *given* its container. Action handlers are
  not: ApplicationV2 hands them the clicked element, so every one has to walk up to the container
  carrying `data-uuid` itself, and `target.closest('.rdhf-reg-feat')` resolves `null` on the
  Curation tab. The handler then returns at its own `if (!uuid) return` guard — no throw, no
  warning, nothing in the console, and a button that simply does nothing. That was v1.3.2:
  `addInvestment`, `removeInvestment`, `removeReference` and the chip repaint in
  `_addFeatureReference` had all shipped Feats-only. **Never write the selector at a call site.**
  `FEAT_HOST` (`.rdhf-reg-feat[data-uuid], .rdhf-cur-editor[data-uuid]`) is declared once at the
  top of `feat-registry-config.mjs` and `_featHost(el)` is the only way a handler should resolve
  its feat. `_paintBadges()` exists for the same reason one rail below: the uncurated badge sits on
  Curation (the tab that clears it, not the one that lists it), and a `querySelector` for it would
  paint only the first badge a nav ever grows.
- **Selecting a queue feat re-renders; editing one does not.** The pane is a whole form, and
  rebuilding it by hand would duplicate every control the Feats tab declares. So `render()` captures
  and restores the queue's own scroller (`.rdhf-cur-queue-scroll`) alongside `.rdhf-reg-scroll`, and
  field edits still go through `_refreshCurationRow`, which repaints the row's chips and both
  counters in place.
- **The registry setting's `onChange` invalidates the pack cache only when `sources` changed**,
  compared against a signature held in `settings.mjs`. Curation writes the registry once per filed
  feat, and invalidating on each would force a full re-index of every source pack on the next render
  for a change that cannot affect what a pack contains.
- **Reset and unregister are different verbs.** `resetFeat` (Feats tab) clears curation; `removeFeat`
  (Sources tab) unregisters a standalone Feature outright. They were one action, and it deleted the
  registry entry either way — fine for a pack-sourced feat, which `loadAllSourceFeatures`
  rediscovers on the next render, but for a **standalone** feat the entry IS the registration, so
  "reset this feat's metadata" removed it from the module. `_onResetFeat` therefore rewrites a
  standalone feat as `{ ...blankFeat(uuid), standalone: true }` — the flag has to be re-applied by
  hand, because `blankFeat` does not carry it.
- **Rule Automation derives; it never writes.** `logic/automation.mjs` is pure and holds the whole
  rule, and `listFeats()` is the ONE seam where it enters the world: each normalized feat goes
  through `applyAutoInvestment` before the record is assembled. The derived row is an ordinary
  `categoryInvestment` row, so `checkRequirements` emits the existing descriptor and the catalog
  renders it with the existing strings — **the feature added no player-facing i18n at all**, and a
  player cannot tell a derived requirement from an authored one. The registry app deliberately does
  NOT go through `listFeats` (it builds its own list from `normalizeFeat`), which is what keeps the
  GM's *editable* rows authored-only while `_paintAutoInvestment` shows the derived one read-only
  beside them. That helper is a five-state machine — hidden / exempt / pending / General /
  automatic / overridden — and the branch ORDER is the contract: `would === 0` short-circuits
  first so a Level 1 feat is never annotated, and the *pending* state (uncurated, announcing what
  filing a Category is about to add) exists because Curation is where the hint earns its keep. Switching the rule off restores the catalog exactly; there is no migration.
- **The derived row REPLACES the investment chain, and that is only safe because the rule and
  authored rows are mutually exclusive.** `evaluateInvestment` is left to right with AND binding
  tighter than OR, so appending a row to an `A or B` chain silently changes its meaning —
  `[A, B(or), D(and)]` evaluates as `A || (B && D)`, not `(A || B) && D`. Because a feat with any
  authored row opts out, the derived row is always the only one and the hazard cannot arise. Any
  future rule that wants to *add* to an existing chain has to solve that first.
- **Adoption, and why the redundant row is deleted.** A single authored row that exactly equals
  what the rule would derive means the GM applied the curve by hand, so it opts the feat IN, not
  out. Matching on the value alone is not durable: retune the curve and the stored number stops
  matching, and exactly the feats that looked adopted would desert the rule, frozen at the old
  value. `#adoptRedundantInvestment()` therefore deletes the row — from `_prepareContext` while the
  rule is on (so the GM sees it and Discard reverts it) and again inside `#commit()` and
  `#commitFeat()` (a curve edit changes what "redundant" means without re-rendering). It only
  touches feats that actually match, so a clean world never goes dirty from merely being opened.
- **`authoredRows()` uses the same filter `checkRequirements` does** — `r.category && r.count`. A
  row with a count of 0 produces no visible requirement there, so it must not silently opt a feat
  out here. Any future reader of the investment chain owes it the same filter.
- **The reachability audit lives in `logic/statistics.mjs` and imports `logic/automation.mjs`** —
  the module's one sibling import inside `logic/`, taken deliberately over restating the rule where
  it would drift from the one the catalog evaluates. `buildAutomationReach` asks whether the curve
  is satisfiable at all: supply is feats in the same Category at or below the same Level, **minus
  one**, because a feat can never be its own prerequisite. Hidden feats are not supply (a player
  cannot acquire one) and are not consumers; exempt feats and feats with authored rows are supply
  but not consumers. Requirements on the supplying feats are not modelled, so a pass means "not
  provably impossible", never "comfortable" — the panel says so. With the seeded curve a Category
  needs 17 feats at or below Level 10 to support a single Level 10 feat.
- **Permissive requirement failure.** An unrecognized expression atom returns `true`. A GM's typo
  must not silently lock a feat away with no visible cause.
- **Formula evaluation goes through `Roll`**, never `eval` or `new Function`. The registry's live
  preview uses the system's own idiom — `Roll.replaceFormulaData` then `Roll.safeEval` — because a
  point pool has no business rolling dice.
- **One precedence rule for the whole module.** Investment in Category rows carry a `join` to the
  *previous* row (so the first never has one) and evaluate left to right with AND binding tighter
  than OR — identical to the expression grammar. `checkRequirements` emits ONE descriptor for the
  whole chain, never one per row: with OR in play a single unmet row is not a failure, and a per-row
  chip would contradict the evaluation. The connectors are localized in the app layer from
  `data.parts`, which is what keeps `logic/` free of `game.i18n`.
- **An acquired Feat is a COPY, and re-sync is the deliberate bridge.** `grantFeat` embeds
  `source.toObject()`, which is what makes a Feat behave like any other Feature and lets revoke
  delete exactly the right item — at the cost that editing the source never reaches existing owners.
  `data/resync.mjs` rewrites each owner's copy in place, keeping `_id` (the acquisition record
  stores it) and `sort` (so the sheet does not reshuffle), and updates with **`recursive: false`**
  so an action or effect *removed* from the source is actually removed rather than merged back in.
- **Derived state is repainted, not re-rendered.** `_refreshRow()` rewrites a registry row's chips,
  classes, `data-*` and the tab badge straight from the working copy on every edit. Anything built
  in JS rather than Handlebars — atom buttons, investment rows, reference chips — exists for the
  same reason: `render()` resets scroll and steals focus, and a GM adding a requirement row should
  not be thrown to the top of a long list.
- **Drops are targeted, not global.** `ApplicationV2` gives no per-element drop option, so the
  DragDrop binds the whole window; `_onDrop` therefore tests the target itself. Only
  `.rdhf-dropzone` registers a new Feat. A requirement field accepts a drop from any tab, and
  anything else is refused with a hint — otherwise curating on the Feats tab silently registered
  new source feats.

## Known scope simplifications

- Feat cost is a flat 1 Feat Point; there is no per-feat cost field.
- Curation scope decisions worth not re-litigating: **one feat at a time, no multi-select** (only
  Level, Category and Types would batch; prerequisites, Trait minimums and investment are per-feat
  and relational), **name-only ordering** (chains are authored through the reference search, which
  does not need its members adjacent), **no assist** — neither keyword suggestion nor reading a
  Level off a class pack's `system.features[]` parent — and **no "dismiss / not a Feat" flag**, on
  the explicit basis that only packs consisting entirely of Features are ever registered, so the
  queue always reaches zero on its own.
- The Statistics tab **derives everything and stores nothing** — no setting, no flag, no migration.
  It reads the registry app's *working copy*, so a Category assigned a moment ago is reflected
  before Save, and it is computed **only while that tab is open**: the Feats tab re-renders on every
  source add, feat drop and taxonomy edit, and scanning every actor each time would be waste.
  `SETTINGS.SHOW_STATS` hides the tab entirely, in which case nothing is computed at all. The
  re-render on toggling that setting rides a core `updateSetting` hook in `hero-feats.mjs` rather
  than the setting's own `onChange`, because `onChange` is given at registration time and wiring it
  there would make `settings.mjs` import from `apps/`.
- Statistics scope decisions worth not re-litigating: the ledger lists **only characters who own at
  least one Feat** (so a character sitting on unspent points but no Feats does not appear), and
  there is deliberately **no never-taken list** — at a few hundred feats it is the catalog again,
  and it conflates "not reached yet", "nobody qualifies" and "actually passed over". Separating the
  third needs the same feat × character eligibility pass as the deferred reachability audit.
- The heat grid shades against **its own busiest cell**, not a figure shared between grids: a shared
  maximum flattens a catalog with one crowded Category into near-identical squares. The count is
  always printed on top of the shade, never conveyed by shade alone.
- Two things are withheld from players, and `listFeats` applies both: uncurated feats (no Category)
  and feats the GM flagged `hidden`. A GM who registers a large pack and forgets to curate will see
  an empty player catalog — the Feats tab badge counts them. Both are overridden by `keepUuids`,
  which the catalog fills with the character's own acquisitions, so a feat already owned never
  disappears from **My Feats** because the GM later hid it or cleared its Category.
- Rule Automation scope decisions worth not re-litigating: the investment number counts **acquired
  Feats**, not a sum of their Levels and not Feat Points (`categoryCounts` unchanged); **General is
  exempt** by explicit design, as is any uncurated feat; the opt-out is **one boolean covering every
  future rule**, not one per rule; and the Statistics requirement-usage bars keep counting
  **authored** rows only — the rule reaches nearly every feat, so folding it in would peg that bar
  at ~100% and destroy the signal the panel exists to give.
- The Types list is free-form. The whitepaper's "Class" and "Domain" types are not auto-populated
  from `daggerheart.classes` / `CONFIG.DH.DOMAIN.allDomains()`; a GM adds the ones they want as
  ordinary types. Category is handled by its own filter section rather than as a pseudo-type.
- `categoryInvestment` counts acquired feats per Category including GM-granted ones.
- No chat integration, no socket traffic, no compendium shipped with the module.
- Re-sync is manual and GM-triggered. There is no automatic propagation on `updateItem`: it would
  be silent, would fire on every save, and has no undo. The document hooks only drop the caches.
- The catalog's cached pack index and enriched descriptions are invalidated on `updateItem` /
  `deleteItem` / `createItem` for non-embedded Features, which re-renders open catalogs. The
  registry app is deliberately NOT re-rendered there — it holds an unsaved working copy and the GM
  may be mid-edit; its next render re-reads the now-empty caches anyway.
