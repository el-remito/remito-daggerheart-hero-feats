/**
 * requirement-text.mjs
 * The app layer's one place for turning requirement DESCRIPTORS into display text.
 *
 * logic/requirements.mjs deliberately emits { kind, key, data, met } and never a
 * sentence, so every string that needs a language lives here. Two apps now render the
 * same requirements — the player catalog with met/unmet state, the GM registry's Feats
 * rows without it — and a second copy of this would be a second place for a connector
 * word to go missing. It is a leaf: it imports logic/ and constants only, never another
 * app, so the one-way apps/ -> data/ -> logic/ direction still holds.
 */

import { checkRequirements } from '../logic/requirements.mjs';

/**
 * Turns a requirement descriptor into display text.
 *
 * Two descriptor shapes carry a LIST rather than a finished string, and both are joined
 * here because the connector is a word:
 *
 * - `data.items` — the any-of clauses (Features, Classes, Subclasses). These are ORed
 *   by checkRequirements, so a bare comma actively misinforms: "Has Expert: Heavy
 *   Armor, Expert: Light Armor" reads as needing both when either will do.
 * - `data.parts` — the Investment in Category chain, which carries its own per-row
 *   connector because it mixes AND and OR.
 *
 * A third, `data.branches`, is the parsed free-text expression: an OR of ANDs whose
 * atoms are themselves descriptors, so this function recurses one level into them. The
 * recursion terminates because an atom never carries branches of its own.
 *
 * @param {{kind: string, key: string, data: object, met: boolean}} check
 * @returns {object} the same descriptor with a `label`
 */
export function localizeCheck(check) {
  const data = { ...check.data };
  if (data.traitKey) data.trait = game.i18n.localize(data.traitKey);

  if (Array.isArray(data.items)) {
    const or = game.i18n.localize('RDHF.requirement.joinOr');
    data.value = data.items.join(` ${or} `);
  }

  // The expression escape hatch. Before this the chip printed the GM's grammar at the
  // player — "traitAtLeast:agility:2 AND hasDomain:Blade" — in the one place a player
  // reads what a Feat will cost them. An atom the grammar did not recognize has no key
  // and is shown as typed, which is the same permissiveness evaluateAtom applies.
  if (Array.isArray(data.branches)) {
    const and = game.i18n.localize('RDHF.requirement.joinAnd');
    const or = game.i18n.localize('RDHF.requirement.joinOr');
    data.value = data.branches
      .map(branch => branch.map(atom => (atom.key ? localizeCheck(atom).label : atom.raw)).join(` ${and} `))
      .join(` ${or} `);
  }

  if (Array.isArray(data.parts)) {
    data.value = data.parts
      .map((part, index) => {
        const row = game.i18n.format('RDHF.requirement.investmentRow', {
          category: part.category,
          value: part.count
        });
        if (!index) return row;
        const join = game.i18n.localize(
          part.join === 'or' ? 'RDHF.requirement.joinOr' : 'RDHF.requirement.joinAnd'
        );
        return `${join} ${row}`;
      })
      .join(' ');
  }

  return { ...check, label: game.i18n.format(check.key, data) };
}

/**
 * The requirement labels for one feat, with no character to measure them against.
 *
 * This is the GM's read: checkRequirements is given a snapshot holding nothing but the
 * label maps, so every `met` it computes is meaningless and is discarded. Going through
 * the real evaluator anyway — rather than walking feat.requirements by hand — is the
 * point: the GM sees the same clauses, in the same order, worded the same way as the
 * table will, and a future requirement kind shows up here without being added twice.
 *
 * The feat's own Level is dropped. It is a requirement, but the row already carries a
 * Level chip and repeating it in the same line is noise.
 *
 * @param {object} feat  normalized feat record
 * @param {{categoryLabels?: object, featLabels?: object}} labels
 * @returns {string[]}
 */
export function describeRequirements(feat, { categoryLabels = {}, featLabels = {} } = {}) {
  return checkRequirements(feat, { categoryLabels, featLabels })
    .filter(check => check.kind !== 'level')
    .map(check => localizeCheck(check).label);
}
