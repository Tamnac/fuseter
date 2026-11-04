import { createIndex, indexFromBuilt, parseIndex, toIndex } from "./fuse-index.mjs";
import { buildIndex, defaultGetFn } from "./index-build.mjs";
import { resolveHighlighting } from "./matches.mjs";
import { createSearcher, defaultSortFn } from "./search.mjs";
import { textNormalizer } from "./text.mjs";
import { checkTokenize, TOKEN_MATCH } from "./tokens.mjs";
import { resolveTyping } from "./typing.mjs";
import { VERSION } from "./version.mjs";

const TIERS = ["simd", "wasm", "js"];   // fastest first
const FALLBACKS = ["js", "wasm", "throw"];
const INDICES_IN = ["normalized", "original"];

// The defaults of new instances (Fuseter.config). Location, distance and findAllMatches are accepted for compatibility, they have no effect while
// ignoreLocation is on (Fuse only widens the window of text it scans, which is the whole text anyway).
const CONFIG = {
  keys: [], threshold: 0.6, includeScore: false, includeMatches: false, indicesIn: "normalized", highlighting: null, isCaseSensitive: false, ignoreDiacritics: false,
  ignoreFieldNorm: false, fieldNormWeight: 1, shouldSort: true, sortFn: defaultSortFn, minMatchCharLength: 1, getFn: defaultGetFn,
  location: 0, distance: 100, findAllMatches: false, ignoreLocation: true, useExtendedSearch: false, useTokenSearch: false, tokenize: undefined, tokenMatch: "any",
  typing: null,   // opt-in heuristics, not Fuse compatible (see typing.mjs)
};
const UNSUPPORTED = { useExtendedSearch: false, ignoreLocation: true };

function resolveOptions(options) {
  for (const name of Object.keys(options)) if (!(name in CONFIG)) throw new TypeError(`fuseter: unknown option '${name}'`);
  const resolved = { ...CONFIG, ...options };
  for (const [name, only] of Object.entries(UNSUPPORTED)) if (resolved[name] !== only) throw new TypeError(`fuseter: option '${name}' is not supported (only ${JSON.stringify(only)})`);
  for (const name of ["sortFn", "getFn"]) if (resolved[name] != null && typeof resolved[name] !== "function") throw new TypeError(`fuseter: '${name}' must be a function`);
  if (typeof resolved.minMatchCharLength !== "number") throw new TypeError("fuseter: minMatchCharLength must be a number");
  checkTokenize(resolved.tokenize);
  if (!TOKEN_MATCH.includes(resolved.tokenMatch)) throw new TypeError(`fuseter: tokenMatch must be one of ${TOKEN_MATCH.join(", ")}`);
  if (!INDICES_IN.includes(resolved.indicesIn)) throw new TypeError(`fuseter: indicesIn must be one of ${INDICES_IN.join(", ")}`);
  if (resolveHighlighting(resolved.highlighting) && !resolved.includeMatches) throw new TypeError("fuseter: 'highlighting' needs includeMatches");
  return resolved;
}

// Builds the Fuseter class for the given set of backends ({ simd?, wasm?, js }); each package entry point passes only what it ships.
export function defineFuseter(backends, defaultBackend) {
  function plan(backend, fallback) {
    if (!(backend in backends)) throw new TypeError(`fuseter: backend '${backend}' is not available in this entry point (has: ${Object.keys(backends).join(", ")})`);
    if (!FALLBACKS.includes(fallback)) throw new TypeError(`fuseter: fallback must be one of ${FALLBACKS.join(", ")}`);
    const floor = fallback === "throw" ? backend : fallback;
    return TIERS.slice(TIERS.indexOf(backend), TIERS.indexOf(floor) + 1).filter(t => t in backends);
  }

  return class Fuseter {
    // Rank-equivalent drop-in for `new Fuse(docs, { ...options, ignoreLocation: true }).search(query, { limit })`.
    // runtime: { backend: 'simd' | 'wasm' | 'js', fallback: 'js' (default) | 'wasm' | 'throw', index: a prebuilt index (createIndex, parseIndex) }
    static async create(docs, options = {}, { backend = defaultBackend, fallback = "js", index } = {}) {
      const candidates = plan(backend, fallback), failures = [];
      const { transposition, firstLetter } = resolveTyping(resolveOptions(options).typing);
      for (const tier of candidates) {
        try { await backends[tier].load({ transposition, weighted: Boolean(firstLetter) }); } catch (e) { failures.push([tier, e]); }
      }
      return new Fuseter(docs, options, { backend, candidates, failures }, index);
    }

    // Synchronous construction on the js backend (wasm needs async compilation).
    static createSync(docs, options = {}, index) {
      return new Fuseter(docs, options, { backend: "js", candidates: ["js"], failures: [] }, index);
    }

    static createIndex = createIndex;
    static parseIndex = parseIndex;
    static config = CONFIG;   // the defaults of new instances, like Fuse.config
    static version = VERSION;

    constructor(docs, options, { backend, candidates, failures }, index) {
      this.options = resolveOptions(options);
      this._typing = resolveTyping(this.options.typing);
      this.requestedBackend = backend;
      this._candidates = candidates;
      this._failures = failures;
      this.setCollection(docs, index);
    }

    get size() { return this._docs.length; }

    // Replaces the documents and their index (made from them, or null/undefined to extract it); costs about as much as constructing.
    setCollection(docs, index) {
      this._docs = docs;
      this._index = toIndex(index, this.options);
      return this._rebuild();
    }

    // Like Fuse, add pushes onto the array that was passed in and removeAt splices it, while remove leaves it alone and keeps a filtered copy.
    // The index is updated at once and flattened again by the next search, so a series of changes costs one rebuild.
    add(doc) {
      if (doc == null) return;
      const index = this._changedIndex();
      this._docs.push(doc);
      index.add(doc, this._docs.length - 1);
    }

    // Removes the documents for which predicate(doc, index) is true and returns them.
    remove(predicate = () => false) {
      const kept = [], removed = [], positions = [];
      this._docs.forEach((doc, i) => { if (predicate(doc, i)) { removed.push(doc); positions.push(i); } else kept.push(doc); });
      if (removed.length) { this._changedIndex().removeAll(positions); this._docs = kept; }
      return removed;
    }

    removeAt(idx) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= this._docs.length) throw new RangeError("fuseter: invalid doc index: must be a non-negative integer within the bounds of the collection");
      this._changedIndex().removeAt(idx);
      return this._docs.splice(idx, 1)[0];
    }

    // The index in Fuse's format ({ keys, records, size(), toJSON() }); the one the instance was given, otherwise made on first use. It is updated by add and remove.
    getIndex() { return this._index ??= indexFromBuilt(this._built, this.options); }

    // From the first change on, the records are the source of the flat index (the documents are not read again).
    _changedIndex() {
      this._stale = true;
      return this.getIndex();
    }

    _refresh() { if (this._stale) this._rebuild(); }

    _rebuild() {
      const o = this.options, docs = this._docs;
      const index = buildIndex(docs, { ...o, starts: Boolean(this._typing.firstLetter) }, this._index);
      const failures = [...this._failures];
      for (const tier of this._candidates) {
        if (failures.some(([t]) => t === tier)) continue;
        try {
          const scanner = backends[tier].create(index, { ignoreFieldNorm: o.ignoreFieldNorm, transposition: this._typing.transposition });
          const searcher = createSearcher(index, scanner, { ...o, highlighting: resolveHighlighting(o.highlighting), typing: this._typing, normalize: textNormalizer(o) });
          this._search = searcher.search;
          this.timings = searcher.timings;
          this.backend = tier;
          this.fallbackReason = failures.length ? failures[0][1] : null;
          this._built = index;
          this._stale = false;
          return this;
        } catch (e) { failures.push([tier, e]); }
      }
      const [tier, cause] = failures[0];
      throw new Error(`fuseter: backend '${tier}' failed and no fallback is allowed: ${cause.message}`, { cause });
    }

    // Returns [{ item, refIndex, score?, matches? }] ordered like Fuse; `threshold` here overrides the constructor option for this call.
    search(query, searchOptions) {
      this._refresh();
      return this._search(query, searchOptions);
    }
  };
}
