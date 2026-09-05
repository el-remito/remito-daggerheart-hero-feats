/**
 * curation.mjs
 * The Curation queue's ordering and bookkeeping. PURE — plain records in, plain values
 * out, no `game.*` and no documents, so node can exercise it directly.
 *
 * The queue is DERIVED, and since v1.7.0 it is derived from the WORLD rather than from
 * session state: membership is simply "not published yet". Filing a Feat is what removes
 * it, so a Feat keeps its place across reloads until the GM actually publishes it.
 *
 * Before v1.7.0 this took two Sets held on the app for the life of the window — `seen`,
 * because choosing a Category used to remove the row out from under the GM, and `filed`,
 * because nothing persisted said otherwise. Both are gone: gaining a Category no longer
 * changes anything about membership, and publication does, so there is nothing left to
 * remember. That state was also the bug — a GM who curated four Feats and pressed Save
 * lost them from the queue and published them without ever pressing File.
 */

/** Alphabetical by displayed name, falling back to the uuid for an unresolved feat. */
function byName(a, b) {
  return String(a.name ?? a.uuid).localeCompare(String(b.name ?? b.uuid));
}

/**
 * The rows the Curation queue should show, and the counts its header prints.
 *
 * Membership is `NOT published`. The two counters split that population by the thing the
 * GM still has to do:
 *
 * - `outstanding` — no Category yet, so it cannot even be filed.
 * - `ready` — has a Category and is waiting on File.
 *
 * `outstanding` is counted over the queue rather than over every feat, and that is not a
 * behaviour change: `uncurated` implies `!published` for every writer in the module (File
 * requires a Category, clearing a Category clears the stamp, and a legacy entry with no
 * Category reads as unpublished), so the two populations are identical. Counting off the
 * queue simply says the true thing more directly.
 *
 * @param {object}   options
 * @param {Array}    options.feats  feat views carrying at least { uuid, name, published, uncurated }
 * @returns {{queue: Array, outstanding: number, ready: number}}
 */
export function buildCurationQueue({ feats = [] } = {}) {
  const queue = (Array.isArray(feats) ? feats : []).filter(feat => !feat?.published).sort(byName);

  return {
    queue,
    outstanding: queue.filter(f => f.uncurated).length,
    ready: queue.filter(f => !f.uncurated).length
  };
}

/**
 * Which feat the queue should move to after acting on `uuid`.
 *
 * `wrap` distinguishes the two verbs. File REMOVES the row — it publishes it — so falling
 * back to the previous entry keeps the selection next to where the GM was working;
 * wrapping there would throw them to the top of the list every time they filed the last
 * feat. Skip removes nothing, so wrapping is the only way back to a feat skipped earlier.
 *
 * @param {Array} queue  the queue as it stands BEFORE the action
 * @param {string} uuid
 * @param {{wrap?: boolean}} [options]
 * @returns {string|null}
 */
export function nextInQueue(queue, uuid, { wrap = false } = {}) {
  const index = queue.findIndex(f => f.uuid === uuid);
  if (index === -1) return queue[0]?.uuid ?? null;
  if (queue[index + 1]) return queue[index + 1].uuid;
  if (wrap) return queue[0]?.uuid ?? null;
  return queue[index - 1]?.uuid ?? null;
}
