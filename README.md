# Remito Daggerheart Hero Feats

A Foundry VTT **v14** module for the **Daggerheart** system that adds **Feats** — abilities untied
to any Domain — as a parallel advancement track alongside Domain cards and level-ups.

The GM decides which Daggerheart **Feature** items count as Feats and gives each one a Category, a
Level, some Types and any Requirements. Player characters earn **Feat Points** as they level and
spend them from a filterable catalog reached by a badge next to Level on their sheet.

## For the GM

Open **Feat Registry** from the module settings (or the button under Game Settings):

| Tab | What it does |
|---|---|
| **Sources** | Register a compendium — every Feature inside becomes a Feat. Or drag a single Feature item anywhere onto the window. |
| **Feats** | The full list. Curate or revise any one of them: Level, Category, Types, Requirements. |
| **Curation** | A queue of everything still uncurated, one at a time, built for working through a freshly registered pack. |
| **Taxonomy** | Maintain the Category and Type lists. |
| **Points** | The Feat Point formula, with a live preview. |
| **Statistics** | How the catalog is distributed and what your table has actually taken. |

Nothing on any tab reaches your world until you press **Save** — the one exception is Curation's
**File** button, which is described below. Closing the window with unsaved changes asks first.

Feature items are **never modified** — all metadata lives in a world setting keyed by item UUID, so
locked compendia (including the Daggerheart SRD packs) work untouched.

A Feat stays **uncurated** until you give it a Category, and uncurated Feats are hidden from
players. The Feats tab shows a badge with how many are still waiting. Every world has a fixed
**General** Category for feats that need to be visible without belonging anywhere in particular —
it cannot be renamed or deleted, and it always sorts first.

A fully curated Feat can also be held back with **Hide from players**, for something that should
exist in the registry before the table is allowed to find it. Hidden Feats carry a red *Hidden*
chip in your view and never appear in a player's catalog — but a character who has already been
granted one keeps seeing it under **My Feats**.

The Feats tab uses the same layout the players get — the same filter rail, the same rows — so you
curate against the view your table actually sees.

Requirements can demand any combination of:

- a **Level** (the Feat's own Level is always a requirement)
- **investment in Categories**, combined with AND / OR — rows read left to right with AND binding
  tighter, so "Alchemy ×2 AND Arcana ×1 OR Swordmaster ×3" means either both of the first two, or
  the last one alone
- minimum **Hit Points, Stress, Hope or Evasion** — compared against the character's *maximum*, not
  their current value
- minimum **Traits**
- other **Feats or Features** the character must already have — search for one by name, or drag it
  onto the block. Each one becomes a named chip you can click to open it; the raw comma-separated
  list is still there under **Edit raw list** if you want to type a plain Feature name
- a **Class or Subclass** (multiclass counts)

There is also an optional advanced expression field combining atoms with `AND` / `OR`, for example
`classIs:Rogue AND tierAtLeast:2`.

### Curation

Registering a pack of two hundred Features leaves you with two hundred uncurated Feats and no
obvious place to start. The **Curation** tab is that place: a queue of everything still waiting,
alphabetical, with one Feat's editor beside it holding only the fields you actually set while
sorting a catalog — Level, Category, Types, the short and full descriptions, prerequisite Feats,
Trait minimums and Category investment. Anything rarer (Hide from players, resource minimums,
Class / Subclass, the raw expression) is one click away under **More fields**, so a Feat that needs
one does not cost you a trip to another tab.

The full description is shown next to the teaser box on purpose: reading the Feature is how the
teaser gets written.

- **File** saves *that one Feat* straight to your world and moves you on — so a long curation pass
  can never be lost, and you never curate the same Feat twice. It writes only that Feat: sources,
  taxonomy and the point formula are still working copies and still need **Save**.
- **Skip** moves on without saving, and wraps around, so a Feat you passed over is reachable again.
- Choosing a Category does **not** make a Feat vanish mid-edit. It stays in the queue, marked as no
  longer outstanding, until you File it.
- Filing a Feat that still has no Category is allowed and just means "not now" — it leaves the
  queue for this session and is back the next time you open the Registry. The pane says so before
  you press it.

The queue is worked out from the registry each time, so there is nothing to keep in sync and
nothing to reset.

### Feat Points

The formula gives a character's **lifetime total**, recomputed whenever their level changes.
Default is `@level * 2`. Available keys: `@level`, `@tier`, `@prof`, and any `@system.*` path.

You can also give one character a bonus or penalty with the `+` / `−` stepper on their catalog's
point bar.

### Changing a Feature after people own it

An acquired Feat is a **copy** on the character, which is what makes its actions and effects work
like any other Feature. So editing the source does not reach anyone who already bought it.

Edit the Feature, then use **Re-sync** — on a single Feat's row, or **Re-sync all** in the Feats
tab rail. It tells you how many copies it is about to rewrite before it does anything. Name, image,
description, actions and effects are all replaced, so any edits made to a character's own copy are
lost. Characters keep the Feat and the Feat Point they spent; nothing is revoked.

Editing a Feature also refreshes the catalog for anyone who has *not* bought it, with no reload.

### GM controls in the catalog

Opening a character's catalog as GM adds a **grant** button on every Feat (ignores requirements,
and asks whether to grant it for free or to charge a Feat Point) and a **revoke** button on
acquired ones (deletes the granted item and refunds the point). A free grant is chipped **Granted**
rather than **Acquired**, so it is clear at a glance which Feats were paid for.

### Statistics

The registry's fifth tab answers "is what I am building actually balanced?" — the question a list
of three hundred Feats cannot answer by scrolling.

- A **Category × Level grid**, shaded by how crowded each cell is, with a switch to show Types
  instead. Click any cell to jump to the Feats tab filtered to exactly it — including empty cells,
  which is usually the point.
- **Coverage gaps**: Categories and Levels you have not written for, and prerequisites pointing at
  a Feat that is no longer registered.
- **Trait demand** — how many Feats gate on each Trait. A catalog that leans hard on one Trait
  leaves characters built any other way with little to buy, and that is invisible when you are
  reading Feats one at a time.
- **Table adoption**: a point ledger per character, the most-taken Feats, and a log of recent
  acquisitions.

Everything on the tab is worked out on the spot from the registry and your characters' sheets —
nothing is stored, and the figures reflect edits you have not saved yet. It costs nothing while
you are not looking at it, and **Show the Statistics tab** in the module settings removes it
entirely if you would rather not have it.

## For players

A badge appears next to your Level. It glows while you have Feat Points to spend. Click it for the
catalog: filter on the left, browse on the right, click a row to read the full text, and press
**+** to acquire. Acquiring costs 1 Feat Point and cannot be undone without your GM.

The **My Feats** tab lists only what this character already has, so a long catalog never buries it.
The filter rail applies to whichever tab is open.

An acquired Feat is added to your character as an ordinary Feature, in the **Features** tab — its
actions, effects and resources all work exactly as they normally would.

## Installation

Manifest URL:

```
https://raw.githubusercontent.com/el-remito/remito-daggerheart-hero-feats/main/module.json
```

Requires Foundry VTT v14 and the Daggerheart system (2.5.0+, verified against 2.7.1).

## Changelog

### v1.3.0
- **Curation tab** — a queue of every uncurated Feat beside a single-feat editor holding only the fields you actually set while sorting a catalog: Level, Category, Types, both descriptions, prerequisite Feats, Trait minimums and Category investment. The rarer ones (Hide from players, resource minimums, Class / Subclass, the raw expression) are one click away under **More fields**. The full description is shown next to the teaser box on purpose — reading the Feature is how the teaser gets written
- **File saves immediately** — filing a Feat writes that one Feat straight to your world, so a long curation pass can never be lost and you never curate the same Feat twice. It writes *only* that Feat: sources, taxonomy and the point formula are still working copies and still need **Save**
- **Choosing a Category no longer makes a Feat vanish mid-edit** — it stays in the queue, marked as no longer outstanding, until you File it. **Skip** moves on without saving and wraps around, so a Feat you passed over is reachable again
- **Unsaved-changes prompt** — closing the Feat Registry with unsaved work now asks: Save, Discard, or Keep editing. Previously the window closed silently and the work was gone
- **Reset no longer unregisters a dropped Feature** — *Reset this feat's metadata* and *Unregister* were one action, which deleted the registry entry either way. Harmless for a Feat that came from a compendium, since it is rediscovered on the next render, but for a Feature dragged in individually the entry **is** the registration, so a reset removed it from the module. The two are now separate verbs, and both confirm by name
- **Filing a Feat no longer re-indexes every source pack** — the registry drops its pack cache only when the source list itself changed
- **Downtime's default icon** is now `fa-fire-burner`. Worlds still carrying the seeded `fa-campground` are updated automatically; an icon you changed yourself is left alone

### v1.2.0
- **Statistics tab** — three panels that derive everything from the registry and your characters and store nothing:
  - *Catalog shape* — a Category × Level heat grid with a Type toggle, plus curated / uncurated / hidden / standalone / unresolved counters. Clicking a cell opens the Feats tab filtered to exactly that cell
  - *Coverage gaps* — Categories and Levels with nothing written for them, which requirement kinds the catalog leans on, which Traits your requirements actually ask for, and prerequisites pointing at a Feat that is no longer registered
  - *Table adoption* — a per-character point ledger, most-taken Feats, and a recent-acquisitions log built from timestamps already stored
- **Statistics can be switched off** — a world setting hides the tab entirely, in which case nothing is computed at all
- **Fixed: "Other Feats or Features" showed raw UUIDs** — the named chips and the search are now the interface; the comma-separated list is still the source of truth but sits under a collapsed *Edit raw list*, and a dropped Feature now lands anywhere in the block rather than only on that hidden field
- **Fixed:** Classes / Subclasses clipped into the requirement block above it

### v1.1.1
- **Prerequisite search** — *Other Feats or Features* gains a type-ahead over every Feature the registry knows about, so a prerequisite can be named without pasting a UUID
- **Fixed:** the first *Investment in Category* row no longer reserves empty space for the connector it does not have; the count and remove controls now line up down the list
- **Fixed:** requirement chips in the registry rendered flush against each other

### v1.1.0
- **General is a Category, not a Type** — a Type could never lift a Feat out of uncurated, so tagging something *General* left it tagged and still invisible to players. General is now a fixed Category that cannot be renamed or deleted. Existing worlds are migrated: General-typed uncategorised Feats are filed under it and the Type is stripped everywhere
- **Re-sync** — per Feat or for the whole registry, rewrites each owner's copy from its source, keeping the item's identity and sheet position so nothing is revoked or reordered. Content *removed* from the source is genuinely removed rather than merged back in. Counts and confirms before writing
- **Edited Features no longer show stale text** — the enriched-description cache is dropped when a Feature changes, and open catalogs re-render
- **Investment in Category gains AND / OR** per row, with AND binding tighter — the same precedence as the expression grammar. A chain reports as one requirement, not one per row
- **Consistent ordering everywhere** — General first then alphabetical for Categories, alphabetical for Types, across both filter rails, the curation dropdowns and the Taxonomy tab
- **Requirement references render as named chips** that open their source item
- **Only the Sources drop zone registers a Feat** — dropping a Feature while curating no longer adds a source behind your back
- **Registry polish** — collapsible Category / Type rail sections, a persistent Sources search, a lazily loaded full-description panel beside the short-description field, and chips, classes and the tab badge repainting on edit instead of lagging a re-render behind
- Adds a versioned migration runner: a migration that fails leaves the version alone and is retried on the next load rather than half-applying and being forgotten

### v1.0.0
- Initial release — Feature items become **Feats**: GM-curated abilities untied to any Domain, bought with Feat Points from a filterable catalog opened by a badge next to Level on the character sheet
- **Feat Registry** — register a compendium, or drag in individual Features. Set Category, Level, Types, a short description, structured Requirements and a free-text expression escape hatch. Feature items are never modified, so locked compendia work untouched
- **Feat Points** from a world formula (`@level`, `@tier`, `@prof`) plus a per-character GM adjustment
- **Player catalog** with a filter rail, a *My Feats* tab, per-requirement pass/fail chips, and full descriptions loaded on demand
- **GM controls** — grant free or charged, revoke, a point stepper, and a *Hide from players* flag for Feats that exist before the table should find them
- An acquired Feat is embedded as an ordinary Feature and appears in the character sheet's **Features** tab, with its actions, effects and resources working normally

## License

MIT — see [LICENSE](LICENSE).
