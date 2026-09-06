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
    visibility.mjs          the withholding precedence: visible / hidden / revealed
    automation.mjs          Rule Automation: the derived-requirement rules
    recency.mjs             how long a Feat wears its NEW / UPDATED chip
  apps/
    requirement-text.mjs    the ONLY place a requirement descriptor becomes display text
    recency-text.mjs        the ONLY place a recency rule becomes a chip tooltip
    feat-catalog.mjs        player + GM catalog (one instance per actor, tracked in openCatalogs)
    feat-registry-config.mjs  GM registry (7 tabs), registered via registerMenu
  badge/badge.mjs           renderActorSheetV2 injection next to Level
```

Import direction is one-way: `apps/` → `data/` → `logic/` → `constants.mjs`. `requirement-text.mjs`
and `recency-text.mjs` are the two modules inside `apps/` that another app imports; both are leaves
(they reach only `logic/`), so the direction still holds and there is no cycle.

## Data shapes

World setting `registry`:

```js
{
  sources: [{ packId: 'world.my-feats', enabled: true }],
  feats: {
    '<item uuid>': {
      uuid, level: 1,
      filedAt: 0,                // 0 === NEVER PUBLISHED === withheld from players
      curatedAt: 0,              // when it was ANNOUNCED; stamped by File, drives NEW
      category: null,            // null === uncurated === cannot be filed yet
      types: ['combat'],
      hidden: false,             // GM secret: withheld even once curated
      autoExempt: false,         // opts this feat out of every Rule Automation rule
      summary: '',               // GM teaser; blank falls back to the description
      standalone: false,         // registered by drag and drop, not from a pack source
      requirements: {
        resources: { hitPoints, stress, hope, evasion },   // minimum MAX values
        traits:    { agility … knowledge },
        features: [], classes: [], subclasses: [],          // any-of within each list
        narrative: [],                                      // stated, NEVER evaluated
        categoryInvestment: [{ category, count, join }],   // join: connector to the PREVIOUS row
        expression: ''                                      // optional escape hatch
      }
    }
  }
}
```

World settings `categories` / `types` are `[{ id, label, icon, description, hidden }]`. A `label`
starting with `RDHF.` is an i18n key (the seeded entries); anything else is literal GM text. Editing
a seeded label in the Taxonomy tab converts it to literal text — that is intended.

`hidden` (v1.4.2) withholds the entry's Feats from players. **No migration**: an entry written
before v1.4.2 has no such key, and `undefined` is falsy, which is the same inline-default mechanism
`normalizeFeat` uses for a new feat field. The **accessors do not filter it** — `getCategories()`
and `getTypes()` still return hidden entries, because the GM has to be able to file into one and the
Taxonomy tab has to render its own checkbox. The filtering lives at exactly two call sites: the
withhold in `listFeats`, and the player half of the catalog rail.

World setting `automation` is `{ investmentByLevel: { enabled, table } }`, where `table` maps a
Level to the number of Feats required in a Category. **Its keys are strings**: the setting
round-trips through JSON, which has no numeric keys, so reading `table[7]` works only by accident of
coercion and `Object.keys()` yields strings either way — `investmentForLevel` normalizes both ends.
`getAutomation()` runs every read through `normalizeAutomation`, which rebuilds the table from the
ten default keys rather than copying the stored one, so a partial or hand-edited value cannot reach
the rule.

World setting `recency` (v1.7.1) is one rule per chip — `{ new: rule, updated: rule }`, where a rule
is `{ mode, amountMode, count, percent, days }`. `mode` is `amount` / `time` / `combined` and
`amountMode` is `count` / `percent`; `getRecency()` runs every read through `normalizeRecency`, the
same defensive-reader contract `automation` gets. It is **its own key rather than a corner of
`automation`**, even though both are edited on the Automation tab and folding it in would have cost
no plumbing at all: that rule DERIVES REQUIREMENTS and this decorates a chip, and a stored object
named `automation` holding both would be a name the next reader has to un-learn. The tab is a
surface; the setting is data. **No migration** — `DEFAULT_RECENCY` is the fixed window of ten every
world had before, so nothing moves until a GM moves it.

**`general` is a fixed Category**, seeded from `DEFAULT_CATEGORIES` and re-inserted by
`getCategories()` if a world ever loses it. It exists so a feat can be *curated* — and therefore
FILEABLE — without the GM inventing a filing system first. (Before v1.7.0 a Category was itself
visibility; now it is the precondition for File, which is the thing that publishes.)
`isFixedCategory()` gates renaming and deletion. It was a *type* until v1.1.0, which could never
lift a feat out of uncurated; migration 1 files General-typed uncategorised feats under it and
strips the type everywhere.

**Ordering lives in the accessors**, not at the call sites: `getCategories()` returns General first
then alphabetical by displayed label, `getTypes()` alphabetical. That is the only way the two filter
rails, the curation dropdowns and the Taxonomy tab can be guaranteed to agree.

`SETTINGS.MIGRATION` holds an integer against `MIGRATION_VERSION` (**3** as of v1.7.0). A migration
that throws leaves the number alone and is retried next load rather than half-applying and being
forgotten. Migrations are GM-only, so every read path still has to tolerate un-migrated data.

Migration 3 stamps `filedAt` for the publication gate, and it is the one migration that is a
**tidy-up rather than a requirement**: `normalizeFeat` reads an entry with no `filedAt` key at all
and a Category as published (`Number(stored.curatedAt) || 1` — the sentinel keeps the value a
number), because under the old rule a Category WAS visibility. Without that inline default a world
would go dark for every player until a GM next logged in, which is precisely the situation "every
read path tolerates un-migrated data" exists to cover. `blankFeat` writes `filedAt: 0` explicitly so
a genuinely new feat can never be mistaken for a legacy one. The migration is idempotent by its own
`filedAt !== undefined` guard, not by the version alone, so a world saved between a failed run and a
retry is not re-stamped with a later date.

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
- **`hasSpellcasting` must test `spellcastModifierTrait?.key` against `TRAITS`.** Neither the value
  nor the object will do, and they fail in OPPOSITE directions. `spellcastModifier` is the trait's
  *value* and is 0 both for a non-caster and for a caster whose trait is 0 — a false negative, and
  the reason this note used to recommend the object. But `Boolean(spellcastModifierTrait)` is truthy
  for nearly EVERY character: the getter (`:36259`) maps each subclass through
  `{ ...this.traits[sc.system.spellcastingTrait], key: sc.system.spellcastingTrait }`, and
  `spellcastingTrait` is `nullable, initial: null`, so a NON-caster subclass spreads `undefined`
  into `{ key: null }` — a truthy object the getter's own `.filter(x => x)` cannot catch. The system
  never notices, because its own readers take `.value` (→ 0) or compare `.key` (→ never matches a
  trait id); only a truthiness test is deceived. That shipped from v1.0.0 to v1.7.1 and let any
  character holding a subclass satisfy a `hasSpellcasting` atom. The KEY is the only branch that is
  the fact itself, and `TRAITS.includes` rejects both `null` and `undefined` without a guard. The
  `sys.class?.subclass?.system?.spellcastingTrait` fallback is a trait id STRING where the getter
  returns an OBJECT, and that asymmetry is what made the truthiness test look sound.
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
  (eligibility, hide-acquired) are left out, replaced by "hidden only". The
  shared sections are ordered the same way in both templates — **search, Clear filters, Level,
  the narrowing switches, Type, Category** — and nothing but source order keeps them agreeing. Type
  and Category are `<details>` in both since v1.4.1; rail open-state is keyed by `data-rail`, never
  by index, so reordering is safe.

  The **narrowing switches** (eligibility, Newly added) sit together directly under Level as of
  v1.6.0, because both answer *which of these Feats do I want to look at*, while Type and Category
  below them describe what a Feat IS. Newly added used to trail after Category, which put it at the
  opposite end of the rail from the question it belongs to. The registry's copy of the section has
  no eligibility switch, and that is the ONLY way the two rails differ. The registry's **hidden
  only** switch stays below Category on purpose: it asks what the GM has yet to DO, not which
  Feats to look at, so it is not part of the shared sequence. Its **uncurated only** companion is
  gone as of v1.7.0 — nothing on the Feats tab can be uncurated now, so the switch could only ever
  match zero rows.

  **UPDATED is a chip, not a filter.** It was briefly both; a switch for it earns nothing that
  reading the list does not already give, and every filter is a control a player has to understand
  before they can ignore it. So `isUpdated` travels through the CONTEXT to the chip and stops
  there — no `updatedOnly` in `blankFilterState`, no branch in `matchesFilters`, and no
  `data-updated` attribute, since that attribute exists only so `matchesFilters` can stay a per-row
  predicate with no context object. `isNew` still needs all four.
- **A rail renders its own state, in both apps.** `filters.search`, the level values, each box's
  `checked` and `railOpen` all travel through the context. Filtering never re-renders, so for a
  long time nothing had to be carried — but both windows re-render for other reasons (an
  acquisition, a saved setting, a tab switch), and without this the rail came back blank while
  `_applyFilters` went on filtering: a rail contradicting the row count beneath it. The catalog
  was missing this until v1.4.1; `_onClearFilters` still resets by writing the DOM rather than
  re-rendering, and both paths have to stay in step.
- **Requirement checks return descriptors, not strings.** `{ kind, key, data, met }` — the app layer
  localizes. That is what keeps `logic/` free of `game.i18n` and testable in node. A descriptor
  whose clause is a LIST must carry the list, never a pre-joined string: `data.items` for the
  any-of clauses (features / classes / subclasses) and `data.parts` for the investment chain.
  `checkRequirements` ORs the any-of lists, and joining them with a comma in `logic/` shipped
  "Has Expert: Heavy Armor, Expert: Light Armor" for a requirement either one satisfied — the
  connector is a word, so it belongs to the language layer. The third list is
  `data.branches`, the parsed free-text expression — an OR of ANDs whose atoms are
  themselves `{ key, data }` descriptors, so `localizeCheck` recurses one level into
  them and terminates because an atom carries no branches of its own. All three joins
  live in `apps/requirement-text.mjs`.
- **A `soft` descriptor is STATED and never evaluated, and it carries `met: true`.** That is the
  whole of narrative requirements (v1.7.0): free GM prose for anything no rule can measure. `met`
  being true is what makes `isEligible` need **no special case at all** — a soft clause can never
  reach `evaluation.failures`, so it can never block an acquisition or the eligibility filter, which
  is the same permissiveness an unrecognized expression atom already gets. The app layer reads
  `soft` to colour the chip and to warn in the acquisition dialog. One descriptor per entry, because
  the field is an ARRAY of strings: two soft conditions are two facts, and one giant chip is exactly
  the readability failure `.rdhf-chip--req`'s wrapping rule exists to fix.
  It is deliberately **NOT** in `PREREQUISITE_KINDS`, for the stronger version of the reason the
  expression hatch is not: prose cannot be classified as held-versus-grown OR evaluated, so
  revealing a Secret Feat on one would reveal it to everybody, always. `describeRequirements` returns
  `{ label, soft }` rather than bare strings so the GM's Requires line can mark them too — the
  registry mutes every requirement chip because it has no character to measure against, but "the
  module cannot check this" is not a verdict about anyone.
- **The expression escape hatch is parsed for display, and `parseExpression` shares
  `splitAtom` with `evaluateAtom`.** `RDHF.requirement.expression` is `"{value}"`, and
  before v1.4.1 `value` was the GM's raw text — so a player was shown
  `traitAtLeast:agility:2 AND hasDomain:Blade`, machine grammar in the one place they
  read what a Feat costs. `describeAtom` maps each atom onto a descriptor, and the two
  functions must never disagree about where an atom's value starts, which is why the
  splitter is shared rather than written twice. Most atoms deliberately **reuse an
  existing key** — `levelAtLeast:5` is `RDHF.requirement.level`, `categoryAtLeast:a:3`
  is one investment `part`, `classIs:` is a one-item `items` list — so the same
  requirement cannot read two ways depending on which control the GM typed it into;
  only spellcasting, domain, community, ancestry and tier needed new strings. An atom
  the grammar does not recognize returns `{ key: null }` and is printed as typed, which
  matches how `evaluateAtom` treats it: permissively and visibly. `traitAtLeast:` and
  `resourceAtLeast:` additionally fall back when the key is not in `TRAITS` /
  `RESOURCE_REQS`, because `game.i18n.localize` would otherwise print the literal
  `RDHF.trait.foo` at the player.
- **`apps/requirement-text.mjs` is the one place a descriptor becomes text**, because two apps now
  render the same requirements: the player catalog with met/unmet state, and the GM registry's
  Feats rows without it. `describeRequirements(feat, labels)` is the GM read — it calls
  `checkRequirements` with a snapshot holding nothing but the label maps, discards every `met` it
  computes, and drops the `level` clause (the row already wears a Level chip). Going through the
  real evaluator rather than walking `feat.requirements` by hand is the point: the GM sees the same
  clauses in the same order with the same wording the table will, and a future requirement kind
  appears in both views without being written twice.
- **The GM's Requires line is painted, never rendered by Handlebars.** The template emits an empty
  `.rdhf-reg-reqs` holding only its heading, and `_paintRequirementLine(host)` fills it — on render
  from the `FEAT_HOST` loop, and on every edit of a field in `REQUIREMENT_FIELDS`. That list
  includes `level` and `category`, which the line does not show, because both feed Rule Automation
  and can add or remove an investment clause with no requirement field moving. Unlike `_buildChips`
  — which duplicates its markup in the template and has to be kept in step by eye — there is one
  implementation here and it cannot drift from itself. It applies `applyAutoInvestment` first, as
  `listFeats` does for players, so the derived clause is part of the scan. Passed a Curation editor
  the `querySelector` misses and the call is a no-op, which is why it sits in the shared loop
  unguarded.
- **One setting, one editor.** `SETTINGS.SHOW_STATS` is the only `config: true` setting in the
  module. `POINT_FORMULA` was one too until v1.4.1, which put the same world value behind two
  surfaces with different rules — Foundry's sheet wrote on submit, the registry's Points tab is a
  working copy needing Save — so a GM had no way to tell which was authoritative. It is now
  `config: false` and the Points tab owns it, which is also the only surface that can show the
  live `Roll` preview and explain the `@`-paths. The `RDHF.settings.pointFormula.*` keys kept
  their names; the Points tab localizes them.
- **A withheld feat says which entry withholds it.** `hidden` on a Category or Type withholds a
  feat exactly as the per-feat flag does, but until v1.4.4 the registry row looked identical to a
  visible one — the Hidden chip only ever tracked `feat.hidden`, and a GM auditing by scrolling (the
  reason the Feats tab carries requirements at all) had no way to see it. The state is carried **per
  chip**, not as one row-level marker: on a feat with four Types a bare "withheld" badge starts a
  hunt for which one. `_buildChips` and the template mirror each other here as they already do for
  the rest of the row, and the Curation queue's Category chip is repainted the same way by
  `_refreshCurationRow` — the queue is a second host and gets forgotten by default.
  Both rails mark the entry too, and neither needs an `isGM` test: the player's list has already
  had hidden entries removed, so only a GM can reach a marked one.
- **One colour, one meaning: `--rdhf-unmet` is "withheld from players", wherever it is reported.**
  It was already the per-feat Hidden chip's tone; v1.4.4 gives it to the taxonomy-withheld chips,
  the rail markers and the Taxonomy tab's lit eye (which was gold until then — a third signal for a
  fact the module already had a colour for). The dashed edge is a second, orthogonal channel meaning
  "not stated on this feat", now named `.rdhf-chip--empty`; a chip withheld by its Category
  wears both, so it reads as withheld-but-not-by-this-feat and cannot be mistaken for either parent.
  **Gold is the neutral-informational tone**, worn by Level and Category chips — and, since v1.7.0,
  by a narrative requirement chip, whose whole meaning is "stated, but not checkable". It is not a
  verdict, which is precisely why it may not borrow met-green or unmet-red. The only other gold chip
  is NEW, which is the module's one FILLED chip; outline versus fill is what keeps the two apart.
- **`.rdhf-chip` is `white-space: nowrap`, and `.rdhf-chip--req` is the one exception.** Every other
  chip is a short label and must never wrap — that is what keeps a row header on one line. A
  requirement clause is a SENTENCE (an any-of list of five Feature names, an investment chain, a
  GM's prose), so nowrap made it overflow its flex line and clip mid-word. The override also
  restates `align-items: flex-start`, because `.rdhf-chip` centres and a two-line chip must put its
  icon beside the FIRST line.
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
- **Curation's File is the ONE surgical write, and since v1.7.0 it is also the PUBLICATION
  EVENT.** `saveFeatEntry` merges a single feat's entry into the *saved* registry and `#commitFeat`
  rebases only that key of `#baseline`; taxonomy, sources and the formula stay working copies and
  still need Save. Reusing `#commit()` would have pushed a half-renamed Category live as a side
  effect of filing a feat AND stopped the close prompt from firing, because everything would have
  been committed through a side door.
  `_onCurationFile` stamps `filedAt` (and `curatedAt`) into the working copy **before** the commit
  and rolls both back if it throws: the stamp IS the publication, so a working copy saying published
  while the world said nothing would drop the row out of the queue and be believed. `filedAt` uses
  `||=` because a re-file must not move the publication date; `curatedAt` is assigned outright
  because a re-file IS a re-announcement. The old "skip the write when unchanged" short-circuit is
  now unreachable on a first File, which is the point — it used to let File remove a row from the
  session queue having written nothing at all.
- **The Curation queue is derived from the WORLD, and holds no session state.** Membership is
  plain `NOT published`. Both `Set`s that used to live on the app instance — `_curationSeen` and
  `_curationFiled` — are gone, and they were the bug: a GM who curated four Feats and pressed Save
  published them and lost them from the queue in the same stroke, because `seen` died with the
  window while `uncurated` had already stopped being true. Publication is now the event that removes
  a row, so nothing has to be remembered and a half-curated Feat survives a reload.
  `outstanding` (no Category) and `ready` (waiting on File) split the queue, and `outstanding` is
  counted over the queue rather than the whole list — identical populations, since `uncurated`
  implies `!published` for every writer, and the queue says it more directly.
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
  its feat. `_paintBadges()` is **gone** as of v1.7.0: the badge counts unpublished feats, which is
  exactly the queue length, and nothing can move it without a full render — File, Reset and deleting
  a Category all call `render()`. Handlebars writes it from `unpublishedCount` and it is never
  repainted.
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
  out here. Any future reader of the investment chain owes it the same filter — and one had already
  forgotten it: `usesRequirement` in `logic/statistics.mjs` tested `.length > 0` until v1.4.3, so a
  feat carrying a row with no Category or a count of 0 was reported on the requirement-usage bar as
  authoring an investment requirement while `checkRequirements` emitted no clause for it and
  `authoredRows()` filtered it out — counted as authored and absorbed by the rule at the same time.
  Three readers, one filter; `usage-smoke.mjs` now asserts they agree.
- **The reachability audit is a LEAST FIXPOINT, and that is the whole design.**
  `buildInvestmentReach` (`logic/statistics.mjs`) asks whether a Feat can ever be acquired at all.
  It used to measure supply as "feats in the Category at or below this Level, minus one" — which
  counts feats that are themselves unreachable, so two Level 5 feats each demanding six from a
  Category holding five each counted the **other** as supply and the pair passed, though neither
  can be acquired first. Any Category more than one feat wide at its top Level hid its own
  shortfall that way. Nothing is supply now until it is known reachable: start from the feats that
  require nothing, grow until a whole pass adds none, and a feat is never its own prerequisite for
  free because it is only ever tested while outside the set. The cumulative `level → category →
  count` table is rebuilt once per **pass**, not once per feat — that is the difference between
  linear-ish and cubic on a few hundred feats.
- **It audits the EFFECTIVE chain, authored or derived**, via `applyAutoInvestment` — one
  expression settling the question, because that function already returns the derived row when the
  rule reaches a feat, the feat's own rows when it does not, and the feat untouched when the rule
  is off. So it runs with Rule Automation **off**, and `enabled` is gone from its return. Before
  v1.5.0 it audited only feats the rule reached, which meant a hand-authored row — the likelier
  place for the mistake — was never checked at all. General is audited when it authors a chain: the
  carve-out governs what the *rule derives*, not what is *checked*, which falls out of iterating
  feats rather than Categories.
- **`logic/statistics.mjs` now imports two siblings inside `logic/`** — `automation.mjs` and
  `requirements.mjs` (`evaluateInvestment`) — both taken deliberately over restating a rule where
  it would drift from the one the catalog evaluates. The evaluator matters most: the audit has to
  read an AND/OR chain exactly as `checkRequirements` does, so OR-of-ANDs precedence is stated once
  and cross-Category rows need no special case, being just another key in the `categoryCounts` map.
  `chainShortfall` groups the chain the same way, and reports the **cheapest** fix: the minimum
  over AND-groups of the summed deficits, which reduces to `required - supply` for a single row —
  the number the panel has always printed.
- **Supply is what a player can ACQUIRE, so all four withholds drop out**, not just `feat.hidden`.
  The app collapses them into a single `withheld` per record in `_buildStats`, because reading the
  taxonomy is the app's job and not `logic/`'s; **unpublished** is folded in there too, which is why
  the audit carries no separate branch for it — and it subsumes the old uncurated test, since File
  requires a Category. A curated-but-unfiled feat is therefore not supply, which is right: nobody
  can acquire it. Exempt feats and feats with authored rows are still supply.
  The Statistics **heat grid** needs the same test for a different reason: its Category-row predicate
  is `isPublished(feat) && feat.category === rowId`, and without that guard a curated-but-unfiled
  feat counts in BOTH its Category row and the not-published pen, the column totals exceed the feat
  count, and the pen stops being a pen. The consequence to accept is that a Category whose feats are
  all unfiled reads as an empty Category in Coverage gaps — correct under the new model, and one
  click from being fixed. `secret()` and `#neverReveals` moved to `isPublished` too: both mean
  "withheld ONLY by a reveal-mode entry", and an unfiled feat is withheld for a stronger reason.
- **Findings group by *(Category, Level, requirement)*** and are ordered **lowest Level first**
  inside a Category, Categories by their worst shortfall. Under a fixpoint a blockage cascades —
  unreachable Level 5 feats make the Level 6 ones unreachable too, with a bigger shortfall — so the
  old worst-shortfall-first sort would have put the symptom above the cause. The summary line
  counts blocked **feats**, not findings, because `checked` counts feats.
- Requirements other than investment on the supplying feats — Trait minimums, prerequisites, class
  — are still not modelled, so a pass means "not provably impossible", never "comfortable"; the
  panel says so. With the seeded curve a Category still needs 15 feats at or below Level 10 to
  support a single Level 10 feat (17 before the v1.4.2 retune; `reach-smoke.mjs` derives the figure
  rather than restating it).
- **"Newly added" is a property of the SET, and that is why nothing is stored per feat.**
  `curatedAt` on a registry entry is a timestamp, stamped by **Curation's File** for the moment a
  feat was ANNOUNCED to players (and cleared to 0 when it is unpublished) — but *membership* is
  decided by `newestCurated()` over the whole list, once per render, because a feat's standing
  changes when OTHER feats are published with nothing about it changing. So the flag reaching the
  row is `isNew`, derived, never persisted, and `matchesFilters` stays a per-row predicate reading
  `view.isNew` — which is what lets both windows filter from `data-*` attributes with no context
  object. The player catalog measures WHICH feats can occupy a slot over the list the PLAYER
  receives, so a withheld feat never takes one. **No migration**: `normalizeFeat`'s inline default
  reads an entry written before v1.5.0 as `curatedAt: 0`, and 0 is never new.
  **The STAMP moved in v1.7.0; the reader did not, and that is deliberate.** `_syncField`'s
  `category` case no longer stamps, because gaining a Category no longer makes a Feat visible — a
  Feat can now sit curated in the queue for a week before anyone sees it. Pointing the window at
  `filedAt` instead would have been the obvious move and is a trap: `_onMarkRecency` is a TOGGLE
  (`feat[field] = Number(feat[field]) > 0 ? 0 : Date.now()`), so clicking a lit "Mark as New" would
  write `filedAt = 0` and **unpublish the Feat** — turning a cosmetic control into the Unpublish
  action this design deliberately does not have. Moving the stamp costs one line and left
  `newestCurated`, `_onMarkRecency`, `_paintRecencyButtons` and `markedNew` untouched. The trap is
  unchanged by v1.7.1 making the window configurable: `_onMarkRecency` still toggles the stamp, so
  pointing any of this at `filedAt` would still unpublish a Feat.
- **Curating one feat repaints two rows.** `_recomputeNewFeats()` returns the uuids whose
  membership changed, and `_syncField` repaints each — the arrival gains the chip and whatever fell
  off the end loses it. Repainting only the edited row left the second wearing a stale chip until
  the next full render, the exact lag the rest of `_refreshRow` exists to prevent.
- **The exclude set is the ONE thing the Statistics tab persists**, and it is a `world` setting
  (v1.6.0). "This sheet is a test dummy, not real play data" is a fact about the world, true for
  whoever opens the tab — the opposite of `INVEST_LAYOUT`, which is a display preference on one
  person's window, and the reason the two are scoped differently. It is `config: false` and edited
  only by ticking a row, and it writes THROUGH rather than joining the four working copies: folding
  it into `#baseline` would make the close prompt offer to save a view preference beside a GM's
  feat edits, and the figures on screen have already moved, so a choice surviving the render but
  not the window would be the one visible state that lies. The catalog's broad `updateSetting` hook
  skips the key for the same reason it skips the layout — it changes nothing a player can see.
  `_statsAxis` and `_showAllGaps` are still session-local; they change which rows are SHOWN, and
  this changes what the figures ARE.
- **Dates are formatted by `formatDay`, never by `toLocaleDateString`.** The Recent acquisitions
  list followed whatever locale the browser was in, so one world showed two orders on two machines
  — and 01/02 against 02/01 leaves a reader no way to tell which they have. DD/MM/YYYY, built from
  the parts, stated once.
- **"Most played Categories" is summed inside `buildAdoptionStats`, from the same `counted` list**
  as every other figure there, so the exclude toggles move it too — counting it off the registry
  somewhere else would have produced a panel describing two different tables. It measures acquired
  **Feats**, not Feat Points and not a sum of Levels, which is the same measure `categoryCounts`
  uses for Investment requirements, so a player's standing and this panel cannot tell two stories.
  It returns Category **ids** and the app resolves labels against its working copy, exactly as the
  reachability findings do.
- **The Statistics ledger's exclude toggle re-renders, and the other two toggles do not.**
  `_onStatsAxis` and `_onToggleGaps` change which rows are *shown*; `_onToggleLedgerActor` changes
  what the figures *are* — Most taken, Recent and every counter — so there is no repaint short of
  rebuilding the panel, and rebuilding it by hand would duplicate markup the template declares.
  `buildAdoptionStats` keeps `characters` as the FULL list with an `excluded` flag per row and
  counts only the rest, and the app's `hasPlayData` reads `characters.length`, not
  `charactersWithFeats` — otherwise excluding every character would swap the table for the "nobody
  has taken a Feat" empty state and take away the only control that puts them back. The set is
  session-local on the app, like `_statsAxis` and `_showAllGaps`: this tab derives everything and
  stores nothing.
- **`logic/investment.mjs` is the Investment chain read from the PLAYER's end**, and it is a
  separate module rather than a function on `filters.mjs` because it answers a different question
  with the same data: not "does this character meet this Feat's requirement" but "what is the next
  mark in this Category worth". It imports `evaluateInvestment` for the same reason
  `statistics.mjs` does — the precedence rule gets stated once — which makes that evaluator the
  module's most-shared piece of logic, read by the catalog, the GM row painter, the reach audit and
  this.
- **General is never a card on My Investments** (v1.5.3), and the exclusion reads
  `GENERAL_CATEGORY_ID` directly rather than borrowing `ruleAppliesToCategory`. It is a Category
  that exists so a Feat can be *curated* without a filing system, which makes it a holding bucket
  rather than a track, and "General — 7 invested" reported filing rather than standing. Borrowing
  the rule's carve-out would have conflated two different questions: that one governs what the rule
  DERIVES, which is why the reach audit still checks General when a Feat authors a chain on it. The
  exclusion is about the CARD only — a chain naming General is still evaluated, so an Alchemy mark
  that pays off only alongside General is still correctly withheld. `forwardTiers` keeps its own
  `ruleAppliesToCategory` test, now unreachable for General and kept because it is the correct
  statement for that function read alone.
- **Tiers come from the FEATS, not from the curve.** With Rule Automation on the two lists are
  identical, because the curve is what put those numbers on the feats and `listFeats` has already
  applied it — but reading the feats also works with the rule off, and can never advertise a tier
  no feat actually gates. A candidate threshold earns a row only if raising *this* Category to it
  (holding every other Category where it stands) actually flips a blocked feat's chain, which is
  what stops an AND chain wanting a second Category from being shown as a promise this Category
  alone can keep. It is a **fifth** reader of the shared `r.category && Number(r.count)` filter.
  A tier's `levels` — which Levels the mark opens, added in v1.5.2 — is read off the feats it
  unblocks for the same reason, so it is right with the rule off and can never name a Level no
  feat occupies.
- **The FORWARD tier is the one deliberate exception, and it is marked as one.** A missing THEN
  meant only "no feat in this Category asks for more than NEXT" — which is almost always "nothing
  is filed at the higher Levels yet", not "you have unlocked everything", and the tab rendered the
  two identically. That the two are indistinguishable is provable rather than incidental:
  `evaluateInvestment` tests `count >= required`, so satisfaction is **monotone** in
  `categoryCounts` and `unlocks` is non-decreasing in `required` — once one tier is emitted every
  higher candidate is too, so a missing THEN can only ever mean no higher threshold was asked for.
  `forwardTiers` therefore appends the next curve marks past everything the feats ask for. It is
  the ONLY place the tab reads the curve; it exists only while the rule is **on**, because with the
  rule off the curve governs nothing and the number would be a threshold the catalog itself
  contradicts (the template says so in words there instead); it carries `unlocks: 0` by
  construction and `forward: true` so the row can say "nothing there yet"; and **General never gets
  one**, since the rule derives nothing for it.
- **The General carve-out is exported, not restated.** `eligibleForRule` is private and takes a
  *feat*; `forwardTiers` has only a Category id. `ruleAppliesToCategory(category)` in
  `logic/automation.mjs` holds the test and `eligibleForRule` calls it — one statement, two
  readers, instead of a copy in `investment.mjs` that drifts the next time General is revisited.
- **`SETTINGS.INVEST_LAYOUT` is the module's only `client` setting, and it is `config: false`.**
  It is a display preference on a *player's* window, so a world setting would let a GM impose it on
  people it does not affect them to change; and the toggle lives on the My Investments tab, where
  the change is visible as it is made, rather than in Foundry's settings sheet. Same "one setting,
  one editor" rule that moved `POINT_FORMULA` to the Points tab. `_onInvestLayout` writes the
  setting and toggles `is-grid` **in place** — the write is only so the choice survives closing the
  window — and the catalog's broad `updateSetting` hook (which re-renders every open catalog for
  any module setting) skips this key, so a cosmetic click cannot throw away scroll position and
  open rows to paint what is already on screen.
- **A sticky element is pinned by its MARGIN box, not its border box.** The catalog's tab strip
  scrolls inside `.rdhf-list-pane` and wears negative margins to reach the pane's padding edges. With
  `top: 0` the negative *top* margin therefore pushed the STUCK strip 8px down — the margin box is
  what meets the scrollport — opening a transparent band above it that Feat rows travelled through,
  and its 8px bottom margin was a second such band. That was the v1.5.3 report: a header that looked
  detached from the top of its pane. `top` now carries the same negative offset, cancelling it. The
  general shape: **a sticky element's spacing must be painted by the element, never left as margin**,
  so the gap below the strip is `padding-top` on `.rdhf-section` — content spacing that scrolls away
  under the strip rather than a window onto what passes beneath. It is the same class of bug as the
  `display: none` grid track one bullet down: both are cases where the box the browser reasons about
  is not the one the rule appears to be about.
- **A control that is correctly absent still owes its neighbours its width.** The fixed Category has
  no delete button, and the `flex: 1` label field simply swallowed the freed space, taking the icon
  field and the hide toggle out of line with every row beneath it. `.rdhf-taxonomy-spacer` is the
  real button's markup made inert and `visibility: hidden` — a real button rather than a hand-sized
  spacer, so it stays exactly as wide as the thing it stands in for however that button is later
  restyled, and `visibility` rather than `hidden`, which would occupy nothing at all.
- **My Investments is a summary, so the rail is hidden while it shows.** `_applyFilters` toggles
  `.rdhf-rail` **and `is-summary` on `.rdhf-catalog-body`** — hiding the rail alone was the v1.5.1
  bug: the body is a two-track grid (`230px minmax(0, 1fr)`) with the rail as item 1, and a grid
  does not reflow around a `display: none` item, it shifts the next one into the vacated track. The
  whole pane, tab bar included, was squeezed into the rail's 230px while the `1fr` track sat empty.
  Not a re-render, because tab switching in the catalog must never re-render (the
  rail would lose its state). Its rows are not `.rdhf-feat`, so the tab contributes 0 to the result
  count and its own empty state is rendered by Handlebars and skipped by the `[data-empty]` sweep.
  It lists only Categories the character has actually invested in: a Category at zero is the
  catalog's job to advertise, and this tab is about standing.
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
- Publication scope decisions worth not re-litigating (v1.7.0): **publish is a ONE-WAY LATCH** —
  File is the gate for FIRST publication only, and afterwards editing on the Feats tab goes live on
  Save exactly as before, which is what makes "no File button on the Feats tab" true; **there is no
  Unpublish action**, the routes back being Reset (destructive) and deleting the Category, both of
  which warn; **the two tabs PARTITION the registry**, Curation holding everything unpublished and
  Feats everything published, nothing in both and nothing in neither; and the Feats tab's Category
  `<select>` therefore has **no blank option**, because offering one would be an Unpublish control
  by the back door. The Curation tab's copy keeps it.
  Filing an uncurated feat used to be allowed and meant "done for now"; publishing one is
  meaningless, so the button is disabled and **Skip** carries that intent instead.
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
  third needs a feat × character eligibility pass, which is also what the Unreachable Feats audit
  would need before it could model the supplying feats’ non-investment requirements.
- The heat grid shades against **its own busiest cell**, not a figure shared between grids: a shared
  maximum flattens a catalog with one crowded Category into near-identical squares. The count is
  always printed on top of the shade, never conveyed by shade alone.
- **`MAX_GAP_ROWS` is a default view, not a ceiling.** The Coverage gaps list truncated at twelve and
  printed "30 more not listed", which told a GM that thirty combinations were missing and gave them
  no way to learn which — the one question the panel exists to answer. Since v1.5.0 every gap is
  rendered; rows past the cap carry `data-gap-overflow="true"` and start `hidden`, and
  `_onToggleGaps` unhides them **in place**. Re-rendering to show them would rerun the whole
  statistics pass, which reads every actor in the world, to reveal rows already in the DOM. The
  overflow can never be more markup than the heat grid directly above it, which already draws one
  cell per Category × Level. The flag also travels through the context (`gaps.showAll`, and a
  per-row `hidden`) because switching tabs rebuilds the pane: without it an expanded list came back
  collapsed under a button still reading "Show fewer" — the rail-renders-its-own-state trap, one
  panel down. Both button labels are in the markup with one hidden, so the handler toggles
  visibility and never writes a display string.
- **Withholding is ONE resolver, and it lives in `logic/visibility.mjs`.** `resolveVisibility`
  returns `visible | hidden | revealed` and holds the whole precedence, **strictest wins**: the
  per-feat `hidden` flag and **not published** withhold unconditionally; then any hidden taxonomy
  entry NOT in reveal mode; then, if every hidden entry on the feat IS in reveal mode, the
  prerequisite decides; otherwise visible. Step 1 returns BEFORE the taxonomy is read, which is what
  stops a reveal-mode Category resurrecting an unfiled Feat: publication is strictly stronger than
  any reveal. The argument's DEFAULT flipped with it — `uncurated = false` defaulted a forgetful
  caller to permissive, `published = false` defaults to withholding, so an omission now fails loudly
  with an empty catalog rather than leaking quietly. `isPublished` lives in this file rather than
  beside `isUncurated` in `data/registry.mjs` because `logic/statistics.mjs` needs it and cannot
  import from `data/`; `isUncurated` stays there and now answers a different question, "can this be
  filed?". It sits in `logic/` rather than inside `listFeats`, its only caller,
  because it is the whole contract and worth exercising directly — `reveal-smoke.mjs` does, and
  could not if it needed Foundry to run. Reading the taxonomy stays the CALLER's job: the resolver
  is handed id → reveal-mode maps, exactly as `logic/statistics.mjs` is handed a collapsed
  `withheld` rather than the entries themselves.
- **The per-feat `hidden` flag is ABSOLUTE, and that is what makes it useful.** Secret Feats
  automate *discovery* — a character-state question a rule can answer. They deliberately do NOT
  automate *campaign pacing*, which is a story-clock question no rule over Traits, Levels and
  investment can express, because the fact is not on the character sheet. `hidden` is the pacing
  tool, unticked by hand when the story arrives; nothing a character does can undo it. One mechanism
  serving both would have served both badly.
- **A reveal keys on the PREREQUISITE, not the whole requirement set.** `PREREQUISITE_KINDS` is
  `feature` / `class` / `subclass` — the things a character HOLDS, as against Level, Traits,
  resources and investment, which they grow into. So a Feat appears the moment its prerequisite is
  acquired even when it is still years above the character's Level: revealed, and visibly not yet
  takeable. `prerequisiteState` derives this from `checkRequirements` rather than walking
  `requirements` by hand, so a future prerequisite kind joins the rule by being named in one array,
  and the reveal can never disagree with the requirement line the player is shown.
- **The expression escape hatch is deliberately NOT a prerequisite.** An atom cannot be classified
  as held-versus-grown without partially evaluating a free-text grammar, and a rule that sometimes
  read one would mean two things depending on which control the GM typed into. A feat whose only
  prerequisite lives there reports `has: false` and can never reveal — which is why
  `#neverReveals` puts a warning chip on the row rather than letting it be found by its silence.
- **Secret Feats needed a NEW HOOK, and without it the feature does not work.** `updateActor`
  re-renders open catalogs only for this module's flags and `system.levelData`, and
  `onFeatureDocumentChanged` returns `false` for an embedded item by design — so gaining a Feature
  ON a character, the central case, refreshed nothing and the Feats appeared only on the next
  reopen. The `createItem`/`deleteItem` branch re-renders **that one actor's** catalog and leaves
  the pack caches alone: an embedded item is a copy, never a source Feature.
- **A Feat cannot be stamped UPDATED until its curation has been COMMITTED, and that is an event,
  not a window.** `category` and `level` are in `REQUIREMENT_FIELDS` because they feed Rule
  Automation, so *curating* a Feat necessarily edits the very fields that later count as changes —
  pick a Category, set a Level, author a requirement, and a Feat no player has ever seen would
  announce itself as changed. **Authoring is not changing.** The boundary is the one the app already
  keeps: `#curationCommitted` asks `#baseline`, the saved world as of the last `#commit` (Save) or
  `#commitFeat` (Curation's File). Before it nothing stamps however many fields are touched; after
  it every mechanically relevant edit does. This is why UPDATED can win the row outright: where both
  chips apply the Feat really was published once and changed afterwards.
  **It reads `filedAt` as of v1.7.0, not `curatedAt`.** The old test was a proxy that was exact only
  while a saved Category WAS publication; once File is the gate, a footer Save would push the stamp
  into the baseline and arm UPDATED for a Feat nobody has seen. `filedAt` is the fact itself, so
  "authoring is not changing" finally has a real publication event as its boundary. Unpublishing
  moves the WORKING copy while this reads the BASELINE, so edits keep stamping until the next Save,
  after which the Feat is authored again — exactly how un-curating behaved, same expression, no
  special case.
- **`REQUIREMENT_FIELDS` gained a third reader rather than a second list.** It already excluded
  `summary`, `hidden` and `type` deliberately, which is exactly "mechanically relevant, not the
  description". `new-smoke.mjs` reads the literal out of the source file rather than restating it,
  so adding a field there without deciding whether it counts as a change fails a test — the same
  discipline the `r.category && r.count` filter got in v1.4.3.
- **The recency chips are two windows, not one, and since v1.7.1 two RULES.** `newestCurated` and
  `newestUpdated` are the same function over different timestamps (`recencyWindow`), and two SETS
  rather than one so a busy week of publishing cannot push every changed Feat out of slots they
  would share — which is now also why they take separate rules: "recently added" and "recently
  changed" rarely move at the same pace. Both are still a property of the SET, recomputed per
  render, never persisted — `#recompute` is the one implementation and `_recomputeNewFeats` /
  `_recomputeUpdatedFeats` are its two callers, each returning the uuids whose membership moved so
  exactly those rows repaint.
- **The window moved to `logic/recency.mjs`, and it owns a stored rule.** `NEW_FEATS_LIMIT = 10` was
  one policy imposed on every world: a table filing two Feats a month wants a DURATION, a table
  dropping a sixty-Feat pack wants a cap, and ten is right for neither. `SETTINGS.RECENCY` holds one
  rule per chip — `mode` of `amount` / `time` / `combined`, with the amount either a `count` or a
  `percent`. It is a separate module rather than more functions on `filters.mjs` for the reason
  `logic/investment.mjs` is: a different question over the same data, and it owns a normalizer, which
  is the shape `logic/automation.mjs` already has. **No migration** — the default IS the old fixed
  ten, so no world moves until its GM moves it.
  Three details are load-bearing. **`combined` is the INTERSECTION**, which is the same statement as
  "whichever expires first wins". **A `days` of 0 is stated, not derived**: every other zero falls
  out of the arithmetic as an empty slice, but a cutoff of `now` would still admit a Feat published
  in that millisecond, and the pane promises 0 hides the chip. And the fields a mode ignores are
  **kept, never cleared**, so switching modes to look and switching back finds the numbers where the
  GM left them.
- **The percentage denominator is PUBLICATION, not the reader's list, and that is a deliberate
  departure.** Which feats may occupy a slot is still measured over the list each window is handed;
  how MANY slots exist is not. `publishedUuids()` (`data/registry.mjs`) states the predicate once and
  both windows resolve against its length, so a GM setting 10% gets the same slot count as every
  player however much is hidden from them — a player whose Category is hidden simply fills fewer of
  those slots. Had it been the reader's list, one setting would have meant a different window per
  person. The registry app caches the uuids **once per render** (`this._publishedUuids`) because
  publication cannot move without a render — File, Reset and deleting a Category all call `render()`
  — while `#recompute` runs on every keystroke that stamps a Feat; the STAMPS are still read live off
  the working copy, because `_syncField` mutates `updatedAt` between renders.
- **The chip tooltips are formatted once per render, in `apps/recency-text.mjs`.** They were a
  hard-coded "one of the ten" in SIX places — two Handlebars sites in the catalog partial, two in the
  registry template, and two `localize` calls in `_buildChips` — which the moment the window became
  configurable were all wrong, and under `time` describe the wrong KIND of window entirely. The mode
  picks the key (`RDHF.catalog.newTooltip.<mode>`) and `resolveRecency` supplies the number, so the
  sentence and the window read the same resolution and a tooltip cannot promise 20 while 19 are
  drawn. It is a second leaf inside `apps/` beside `requirement-text.mjs`, for the same reason: two
  apps render the same thing and the wording belongs in one place.
- **The manual mark exists because the hook that would replace it cannot safely write.** Editing a
  Feature's actions changes what a Feat DOES and reaches no registry field. An `updateItem` hook
  could notice, but the registry is a world setting the GM edits through a working copy saved on
  Save, so a background stamp written while that window is open is lost at their next Save — which
  is the same reason the registry app is never re-rendered from document hooks. So the GM says so
  instead, in the expanded row body (Re-sync and Reset stay in the always-visible `<summary>`;
  these are one level deeper because they are an occasional correction). The button reflects the
  STORED stamp, not chip membership: a control that switched itself off because another Feat was
  stamped elsewhere and pushed this one out of the window would be reporting someone else's edit.
- **Secret Feats are not audit supply, and the audit says so.** `buildInvestmentReach` asks what a
  player can reach today, and a Feat waiting on a prerequisite cannot be counted on — so the
  `withheld` predicate is unchanged. But a Category that passes only because its secrets were
  excluded is a different kind of pass, so `secretsExcluded` is counted over the same records the
  audit was given and reported under the summary.
- **Four things are withheld from players, and `listFeats` applies all four**: **unpublished** feats
  (`filedAt === 0`), feats the GM flagged `hidden`, feats whose Category is flagged hidden, and feats
  carrying **any** hidden Type. Still four, not five: unpublished sits where uncurated used to and
  SUBSUMES it, because File requires a Category and so nothing published can lack one. A GM who
  registers a large pack and forgets to file will see an empty player catalog — the Curation tab
  badge counts them. All four are overridden by `keepUuids`, which the catalog fills with the
  character's own acquisitions, so a feat already owned never disappears from **My Feats** because
  the GM later hid it, unpublished it, or deleted the Category it was filed under. That last path is
  new and makes the override load-bearing rather than theoretical.
  The Type test is **any, not all**, and that is a decision, not an oversight: a feat tagged both
  Combat and Downtime is withheld the moment Downtime is hidden. The symmetric reading was chosen
  so a Type can withdraw a slice of the catalog outright — the alternative (a hidden Type only
  tidies the rail) makes Category and Type mean different things and leaves no way to pull a
  cross-cutting slice. A player-facing rail entry that can only ever match zero rows is worse than
  absent, so `feat-catalog._prepareContext` drops hidden entries from the rail for players and keeps
  every entry for a GM, who is also the person who has to find what they just withdrew.
- Rule Automation scope decisions worth not re-litigating: the investment number counts **acquired
  Feats**, not a sum of their Levels and not Feat Points (`categoryCounts` unchanged); **General is
  exempt** by explicit design, as is any uncurated feat; the opt-out is **one boolean covering every
  future rule**, not one per rule; and the Statistics requirement-usage bars keep counting
  **authored** rows only — the rule reaches nearly every feat, so folding it in would peg that bar
  at ~100% and destroy the signal the panel exists to give. That decision stands, but it read as a
  bug to the GM who reported it: 112 feats, the rule on, and an Investment bar saying 10, with
  nothing on screen to say the bar is about authorship. Since v1.4.3 the panel carries a hint, and a
  second sentence appears **only while the rule is enabled** (`autoInvestEnabled` in the context —
  *not* `automation`, which the stats pane has never been given) pointing at the reachability audit
  as the place the rule is actually reported.
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
