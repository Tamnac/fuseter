import { buildIndex, defaultGetFn, parseKey, slotValues } from "./index-build.mjs";
import { fieldNorm } from "./text.mjs";

// The value of a key in a record: { v, n }, or [{ v, i, n }] for an array value (v the string, i its position in the array, n the field norm).
// `entries` are the [{ v, i, n }] of one key of one document.
export const subRecord = entries => entries.length === 1 && entries[0].i === undefined ? { v: entries[0].v, n: entries[0].n } : entries;

// An index in Fuse's serialised format, so that indexes made with Fuse.createIndex can be loaded and the other way round:
// { keys: [{ path, id, weight, src }], records } with a record { v, i, n } per non-blank string of a string collection, or { i, $ } per document, where
// $[key position] is the subRecord of the key. Like Fuse's, it is updated by add/removeAt/removeAll (the Fuseter instance calls them).
export class FuseterIndex {
  // `defs` are the parsed keys (see parseKey); `records` is used as it is, not copied. `norm` computes the field norm of a new string.
  constructor(defs, records, { getFn = defaultGetFn, norm } = {}) {
    this.defs = defs;
    this.records = records;
    this.getFn = getFn;
    this.norm = norm;
  }

  get keys() { return this.defs.map(({ path, id, weight, src }) => ({ path, id, weight, src })); }

  size() { return this.records.length; }

  toJSON() { return { keys: this.keys, records: this.records }; }

  // Appends the record of a document that has index `docIndex` in the collection (strings are indexed as a string collection, as in Fuse).
  add(doc, docIndex) {
    if (!Number.isInteger(docIndex) || docIndex < 0) throw new RangeError("fuseter: invalid doc index: must be a non-negative integer");
    let record;
    if (typeof doc === "string") {
      if (!doc.trim().length) return null;
      record = { v: doc, i: docIndex, n: this.norm(doc) };
    } else {
      record = { i: docIndex, $: {} };
      this.defs.forEach((def, k) => {
        const { texts, at } = slotValues(doc, def);
        if (texts.length) record.$[k] = subRecord(texts.map((v, j) => ({ v, i: at[j], n: this.norm(v) })));
      });
    }
    this.records.push(record);
    return record;
  }

  removeAt(idx) { this.removeAll([idx]); }

  // Removes the records of the documents with these indexes and renumbers the records after them.
  removeAll(indices) {
    const sorted = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
    if (!sorted.length) return;
    const { records } = this;
    let kept = 0;
    for (const record of records) {
      let below = 0, hi = sorted.length;
      while (below < hi) { const mid = (below + hi) >>> 1; if (sorted[mid] < record.i) below = mid + 1; else hi = mid; }
      if (sorted[below] === record.i) continue;
      record.i -= below;
      records[kept++] = record;
    }
    records.length = kept;
  }
}

const isIndexData = value => Array.isArray(value?.keys) && Array.isArray(value?.records);

// The FuseterIndex for an index argument: a FuseterIndex, or anything in the Fuse format (the records array is shared, not copied).
export function toIndex(index, options) {
  if (index == null) return null;
  if (index instanceof FuseterIndex) return index;
  if (!isIndexData(index)) throw new TypeError("fuseter: incorrect 'index' type (expected the result of createIndex or parseIndex)");
  const getFn = index.getFn ?? options?.getFn ?? defaultGetFn;   // a Fuse index brings its own getFn and norm
  const norm = typeof index.norm?.get === "function" ? text => index.norm.get(text) : fieldNorm(options?.fieldNormWeight);
  return new FuseterIndex(index.keys.map(({ src, path, weight, getFn: keyGetFn }) => parseKey({ name: src ?? path, weight, getFn: keyGetFn }, getFn)), index.records, { getFn, norm });
}

// The index of a built collection (see buildIndex), with the strings as they were written. `options`: { keys, getFn, fieldNormWeight } of the collection.
export function indexFromBuilt(built, options = {}) {
  const { nDocs, K, keyless, keys, present, values, refAt, norms } = built, records = [];
  for (let d = 0; d < nDocs; d++) {
    const entry = s => ({ v: values[s], i: refAt[s] < 0 ? undefined : refAt[s], n: norms[s] });
    if (keyless) { if (present[d * K]) records.push({ v: values[d * K], i: d, n: norms[d * K] }); continue; }
    const $ = {};
    keys.forEach((key, k) => {
      const entries = [];
      for (let s = d * K + key.base; s < d * K + key.base + key.width; s++) if (present[s]) entries.push(entry(s));
      if (entries.length) $[k] = subRecord(entries);
    });
    records.push({ i: d, $ });
  }
  const { getFn = defaultGetFn, fieldNormWeight } = options;
  return new FuseterIndex(keyless ? (options.keys ?? []).map(key => parseKey(key, getFn)) : keys, records, { getFn, norm: fieldNorm(fieldNormWeight) });
}

// Fuse.createIndex(keys, docs, { getFn, fieldNormWeight })
export function createIndex(keys, docs, { getFn, fieldNormWeight } = {}) {
  const options = { keys, getFn, fieldNormWeight };
  return indexFromBuilt(buildIndex(docs, options), options);
}

// Fuse.parseIndex(data, { getFn, fieldNormWeight }), data being what the toJSON of an index returned (parsed, not a string).
export function parseIndex(data, options) {
  if (!isIndexData(data)) throw new TypeError("fuseter: parseIndex expects { keys, records }");
  return toIndex(data, options);
}
