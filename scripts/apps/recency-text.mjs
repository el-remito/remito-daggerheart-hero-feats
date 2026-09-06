/**
 * recency-text.mjs
 * The ONE place a recency rule becomes display text.
 *
 * A second leaf inside apps/ beside requirement-text.mjs, and for the same reason: two
 * apps draw the same chips — the player catalog and the GM registry — and the sentence
 * under each has to name the mode and the number the window actually uses. Written twice
 * it would drift the first time a mode was added. It reaches only logic/, so the
 * one-way import direction still holds and there is no cycle.
 *
 * The strings were a hard-coded "one of the ten" until v1.7.1, in six places. Now the
 * mode picks the key and resolveRecency supplies the number, which is the same
 * resolution the window itself runs — so the tooltip cannot promise a count of 20 while
 * 19 chips are drawn.
 */

import { resolveRecency } from '../logic/recency.mjs';

/**
 * The tooltip for one chip, under the rule currently in force.
 *
 * @param {'new'|'updated'} chip
 * @param {object} rule   one normalized chip rule
 * @param {number} total  the published Feat count, for a percentage window
 * @returns {string}
 */
export function chipTooltip(chip, rule, total) {
  const { mode, limit, days } = resolveRecency(rule, total);
  return game.i18n.format(`RDHF.catalog.${chip}Tooltip.${mode}`, { count: limit, days });
}
