/**
 * recency-text.mjs
 * The ONE place a recency rule becomes display text.
 *
 * A second leaf inside apps/ beside requirement-text.mjs, and for the same reason: two
 * apps draw the same chips — the player catalog and the GM registry — and the text under
 * each has to name the mode and the number the window actually uses. Written twice it
 * would drift the first time a mode was added. It reaches only logic/ and its sibling
 * leaf date-text.mjs, so the one-way import direction still holds and there is no cycle.
 *
 * The strings were a hard-coded "one of the ten" until v1.7.1, in six places. Now the
 * mode picks the key and resolveRecency supplies the number, which is the same
 * resolution the window itself runs — so the tooltip cannot promise a count of 20 while
 * 19 chips are drawn.
 *
 * Since v1.9.1 the NEW and UPDATED tooltips are MIRRORS, by construction: one builder,
 * one window line read from ONE key set for both chips, and a date on top — published
 * for NEW, changed for UPDATED — with only UPDATED adding the GM's note. A change to
 * one chip's tooltip is a change to both; see "The two recency tooltips mirror each
 * other" in CLAUDE.md before splitting them.
 */

import { resolveRecency } from '../logic/recency.mjs';
import { formatDay } from './date-text.mjs';

/**
 * The window line — "Recent: top 10" — under the rule currently in force. The same
 * keys serve both chips: the line says why the chip is still drawn, and the date above
 * it already says which event it counts from.
 *
 * @param {object} rule   one normalized chip rule
 * @param {number} total  the published Feat count, for a percentage window
 * @returns {string}
 */
export function windowLine(rule, total) {
  const { mode, limit, days } = resolveRecency(rule, total);
  return game.i18n.format(`RDHF.catalog.recencyTooltip.${mode}`, { count: limit, days });
}

/** The date line's key per chip: the event each window counts from. */
const DATE_KEYS = { new: 'RDHF.catalog.publishedOn', updated: 'RDHF.catalog.changedOn' };

/**
 * One chip's tooltip for ONE Feat: the date, the GM's note (UPDATED only), the window
 * line. HTML, so the chip carries it as `data-tooltip-html` (core runs it through
 * cleanHTML). The note is GM prose, so it is escaped HERE, the one place it becomes
 * markup.
 *
 * @param {'new'|'updated'} chip
 * @param {string} line  windowLine(…) for this chip's rule, formatted once per render
 * @param {{at?: number, note?: string, notePending?: boolean}} [event]
 *   `at` is curatedAt for NEW, updatedAt for UPDATED. `notePending` is the registry's
 *   unsaved UPDATED stamp: the note is asked for on Save, so the stored one belongs to
 *   the previous change and is not shown.
 * @returns {string}
 */
export function chipTooltip(chip, line, { at = 0, note = '', notePending = false } = {}) {
  const escape = foundry.utils.escapeHTML;
  const lines = [];
  if (Number(at) > 0) {
    lines.push(
      `<strong>${escape(game.i18n.format(DATE_KEYS[chip], { date: formatDay(at) }))}</strong>`
    );
  }
  if (notePending) {
    lines.push(
      `<span class="rdhf-tooltip-note is-pending">${escape(
        game.i18n.localize('RDHF.registry.updateNotePending')
      )}</span>`
    );
  } else if (note) {
    lines.push(`<span class="rdhf-tooltip-note">${escape(note)}</span>`);
  }
  lines.push(`<span>${escape(line)}</span>`);
  return `<div class="rdhf-tooltip-recency">${lines.join('')}</div>`;
}
