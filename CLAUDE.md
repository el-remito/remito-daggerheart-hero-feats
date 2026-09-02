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
    migrations.mjs          one-way world data migrations, run once each by the GM on ready
  logic/                    PURE — plain values in, plain values out
    requirements.mjs        structured checks + the AND/OR expression grammar
    points.mjs              total / spent / remaining
    filters.mjs             catalog filter predicate and sort comparators
  apps/
    feat-catalog.mjs        player + GM catalog (one instance per actor, tracked in openCatalogs)
    feat-registry-config.mjs  GM registry, registered via registerMenu
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

- **Filtering never re-renders.** `FeatCatalog._applyFilters` toggles `hidden` on each row's `<li>`
  in place. A re-render on every keystroke steals focus from the search box. Row state lives
  entirely in `data-*` attributes so the filter pass needs no context object.
- **Neither does switching catalog tabs.** Catalog / My Feats are two `.rdhf-section` elements
  rendered at once; `_applyFilters` displays the one matching `_tab` and counts only its rows. The
  registry's tabs *do* re-render, because each is a different form.
- **The GM registry mirrors the player catalog** — same rail, same row shape, same `matchesFilters`
  predicate, so curation happens against the view the table sees. Only the player-facing switches
  (eligibility, hide-acquired) are left out, replaced by "uncurated only" / "hidden only".
- **Requirement checks return descriptors, not strings.** `{ kind, key, data, met }` — the app layer
  localizes. That is what keeps `logic/` free of `game.i18n` and testable in node.
- **Working copy, save on Save.** The registry app clones the setting into `#config`, mutates it on
  every `input`, and writes only in `_onSave`. Open `<details>` state is captured before
  `super.render()` and restored by uuid, never by index.
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
- Two things are withheld from players, and `listFeats` applies both: uncurated feats (no Category)
  and feats the GM flagged `hidden`. A GM who registers a large pack and forgets to curate will see
  an empty player catalog — the Feats tab badge counts them. Both are overridden by `keepUuids`,
  which the catalog fills with the character's own acquisitions, so a feat already owned never
  disappears from **My Feats** because the GM later hid it or cleared its Category.
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
