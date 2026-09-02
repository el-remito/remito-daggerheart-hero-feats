/**
 * curation.mjs
 * The Curation queue's ordering and bookkeeping. PURE — plain records in, plain
 * values out, no `game.*` and no documents, so node can exercise it directly.
 *
 * The queue is DERIVED, never stored. Its whole state is two sets of uuids held on the
 * app for the life of the window, which is why closing the registry and reopening it
 * rebuilds the backlog from the registry itself: anything still without a Category is
 * simply back. No setting, no flag, no migration.
 */

/** Accepts a Set, an array, or nothing at all. */
function toSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

/** Alphabetical by displayed name, falling back to the uuid for an unresolved feat. */
function byName(a, b) {
  return String(a.name ?? a.uuid).localeCompare(String(b.name ?? b.uuid));
}

/**
 * The rows the Curation queue should show, and the counts its header prints.
 *
 * Membership is `(uncurated OR already seen) AND NOT filed`. The `seen` half is what
 * implements "stays until you hit File": the instant a GM picks a Category the feat
 * stops being uncurated, and a queue derived strictly from that would delete the row
 * out from under them before they could reach its dependencies, traits or investment.
 *
 * @param {object}   options
 * @param {Array}    options.feats  feat views carrying at least { uuid, name, uncurated }
 * @param {Set|Array} [options.seen]   uuids that have appeared in the queue before
 * @param {Set|Array} [options.filed]  uuids explicitly filed this session
 * @returns {{queue: Array, outstanding: number, ready: number, filed: number}}
 */
export function buildCurationQueue({ feats = [], seen = null, filed = null } = {}) {
  const seenSet = toSet(seen);
  const filedSet = toSet(filed);

  const queue = feats
    .filter(feat => (feat.uncurated || seenSet.has(feat.uuid)) && !filedSet.has(feat.uuid))
    .sort(byName);

  return {
    queue,
    // The real backlog: still uncurated anywhere in the catalog and not yet filed.
    // Counted across every feat rather than the queue, so a feat curated on the Feats
    // tab while Curation was closed is already discounted.
    outstanding: feats.filter(f => f.uncurated && !filedSet.has(f.uuid)).length,
    // Rows sitting in the queue that now have a Category and are waiting on File.
    ready: queue.filter(f => !f.uncurated).length,
    filed: filedSet.size
  };
}

/**
 * Which feat the queue should move to after acting on `uuid`.
 *
 * `wrap` distinguishes the two verbs. File REMOVES the row, so falling back to the
 * previous entry keeps the selection next to where the GM was working; wrapping there
 * would throw them to the top of the list every time they filed the last feat. Skip
 * removes nothing, so wrapping is the only way back to a feat skipped earlier.
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
