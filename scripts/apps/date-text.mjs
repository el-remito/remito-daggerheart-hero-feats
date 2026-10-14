/**
 * date-text.mjs
 * The ONE place a timestamp becomes a date a person reads.
 *
 * A leaf inside apps/, beside requirement-text.mjs and recency-text.mjs and for the same
 * reason: two apps now print dates — the registry's Recent activity ledger and, since
 * v1.9.0, the catalog's "changed on" line on an owned Feat — and the order has to be the
 * same in both.
 */

/**
 * A day, as DD/MM/YYYY.
 *
 * Built from the parts rather than through toLocaleDateString, which follows whatever
 * locale the browser happens to be in and so showed the same world two different orders
 * on two machines — with 01/02 and 02/01 indistinguishable, a reader cannot tell which
 * they are looking at. One order, stated.
 *
 * @param {number|null} at  epoch ms
 * @returns {string}
 */
export function formatDay(at) {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
