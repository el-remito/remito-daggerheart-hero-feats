# Remito Daggerheart Hero Feats

A Foundry VTT **v14** module for the **Daggerheart** system that adds **Feats** — abilities untied
to any Domain — as a parallel advancement track alongside Domain cards and level-ups.

The GM decides which Daggerheart **Feature** items count as Feats and gives each one a Category, a
Level, some Types and any Requirements. Player characters earn **Feat Points** as they level and
spend them from a filterable catalog reached by a badge next to Level on their sheet.

## For the GM

Open **Feat Registry** from the module settings (or the button under Game Settings). Four tabs:

| Tab | What it does |
|---|---|
| **Sources** | Register a compendium — every Feature inside becomes a Feat. Or drag a single Feature item anywhere onto the window. |
| **Feats** | Curate each one: Level, Category, Types, Requirements. |
| **Taxonomy** | Maintain the Category and Type lists. |
| **Points** | The Feat Point formula, with a live preview. |

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
- other **Feats or Features** the character must already have
- a **Class or Subclass** (multiclass counts)
- **Investment in a Category** — "at least 2 Alchemy feats"

There is also an optional advanced expression field combining atoms with `AND` / `OR`, for example
`classIs:Rogue AND tierAtLeast:2`.

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

## License

MIT — see [LICENSE](LICENSE).
