import { createIndex, indexFromBuilt, parseIndex, toIndex } from "./fuse-index.mjs";
import { buildIndex, defaultGetFn } from "./index-build.mjs";
import { leavesOf, parseLogical } from "./logical.mjs";
import { resolveHighlighting } from "./matches.mjs";
import { pluginFor, registerPlugins } from "./plugins.mjs";
import { createSearcher, defaultSortFn } from "./search.mjs";
import { textNormalizer } from "./text.mjs";
import { checkTokenize, TOKEN_MATCH } from "./tokens.mjs";
import { resolveTyping } from "./typing.mjs";
import { VERSION } from "./version.mjs";

const TIERS = ["simd", "wasm", "js"];   // fastest first
const FALLBACKS = ["js", "wasm", "throw"];
const INDICES_IN = ["normalized", "original"];
const MATCH_TOKEN_SEARCH_UNSUPPORTED = "Fuseter.match does not support useTokenSearch: token search needs statistics of the whole collection. Use search() instead.";

// The defaults of new instances (Fuseter.config). Unlike Fuse, ignoreLocation is on by default: location, distance and findAllMatches have no effect
// while it is on (Fuse only widens the window of text it scans, which is the whole text anyway).
const CONFIG = {
  keys: [], threshold: 0.6, includeScore: false, includeMatches: false, indicesIn: "normalized", highlighting: null, isCaseSensitive: false, ignoreDiacritics: false,
  ignoreFieldNorm: false, fieldNormWeight: 1, shouldSort: true, sortFn: defaultSortFn, minMatchCharLength: 1, getFn: defaultGetFn,
  location: 0, distance: 100, findAllMatches: false, ignoreLocation: true, useExtendedSearch: false, useTokenSearch: false, tokenize: undefined, tokenMatch: "any",
  typing: null,   // opt-in heuristics, not Fuse compatible (see typing.mjs)
};

// Token search keeps ignoreLocation on for its terms, as Fuse does; extended search, which takes precedence over it, uses it for its fuzzy terms.
const needsLocated = ({ ignoreLocation, useExtendedSearch, useTokenSearch }) => !ignoreLocation && (useExtendedSearch || !useTokenSearch);

function resolveOptions(options) {
  for (const name of Object.keys(options)) if (!(name in CONFIG)) throw new TypeError(`fuseter: unknown option '${name}'`);
  const resolved = { ...CONFIG, ...options };
  for (const name of ["sortFn", "getFn"]) if (resolved[name] != null && typeof resolved[name] !== "function") throw new TypeError(`fuseter: '${name}' must be a function`);
  if (typeof resolved.minMatchCharLength !== "number") throw new TypeError("fuseter: minMatchCharLength must be a number");
  checkTokenize(resolved.tokenize);
  if (!TOKEN_MATCH.includes(resolved.tokenMatch)) throw new TypeError(`fuseter: tokenMatch must be one of ${TOKEN_MATCH.join(", ")}`);
  if (!INDICES_IN.includes(resolved.indicesIn)) throw new TypeError(`fuseter: indicesIn must be one of ${INDICES_IN.join(", ")}`);
  if (resolveHighlighting(resolved.highlighting) && !resolved.includeMatches) throw new TypeError("fuseter: 'highlighting' needs includeMatches");
  if (!Number.isInteger(resolved.location) || !(resolved.distance >= 0)) throw new TypeError("fuseter: location must be an integer and distance a non-negative number");
  if (!resolved.ignoreLocation && (resolved.typing || resolved.highlighting)) throw new TypeError("fuseter: 'typing' and 'highlighting' need ignoreLocation: true");
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

  // Fuse's searcher for a pattern: the first plugin whose condition holds, otherwise one that compares the pattern with a single text (see match).
  function searcherFor(pattern, options) {
    const merged = { ...CONFIG, ...options }, Plugin = pluginFor(pattern, merged);
    return Plugin ? new Plugin(pattern, merged) : { searchIn: text => matchText(pattern, text, merged) };
  }

  function matchText(pattern, text, options) {
    const single = Fuseter.createSync([text], { ...options, keys: [], ignoreFieldNorm: true, includeScore: true });
    const [hit] = single._searchPattern(pattern, { builtin: true });
    if (!hit) return { isMatch: false, score: 1 };
    return options.includeMatches ? { isMatch: true, score: hit.score, indices: hit.matches?.[0]?.indices ?? [] } : { isMatch: true, score: hit.score };
  }

  class Fuseter {
    // Rank-equivalent drop-in for `new Fuse(docs, options).search(query, { limit })` (ignoreLocation defaults to true here, false in Fuse).
    // With `typing` or `highlighting` the results no longer match Fuse's.
    // runtime: { backend: 'simd' | 'wasm' | 'js', fallback: 'js' (default) | 'wasm' | 'throw', index: a prebuilt index (createIndex, parseIndex) }
    static async create(docs, options = {}, { backend = defaultBackend, fallback = "js", index } = {}) {
      const candidates = plan(backend, fallback), failures = [];
      const resolved = resolveOptions(options), { transposition, firstLetter } = resolveTyping(resolved.typing);
      for (const tier of candidates) {
        try { await backends[tier].load({ transposition, weighted: Boolean(firstLetter), extended: Boolean(resolved.useExtendedSearch) }); } catch (e) { failures.push([tier, e]); }
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

    // Fuse.match: compares one pattern with one text, giving { isMatch, score, indices? } (indices with includeMatches). The options are those of a Fuseter,
    // so unlike Fuse's ignoreLocation is on by default. Extended search is supported, but its result has no hasInverse, and token search is not (as in Fuse).
    static match(pattern, text, options) {
      const merged = { ...CONFIG, ...options };
      if (merged.useTokenSearch) throw new Error(MATCH_TOKEN_SEARCH_UNSUPPORTED);
      return searcherFor(pattern, merged).searchIn(text);
    }

    // Fuse.parseQuery: the tree of a logical query, { operator, children } for  and  and { keyId, pattern, searcher } for a leaf (keyId is null for a string).
    // With auto: false the leaves have no searcher; otherwise it has a searchIn(text) method that compares the leaf's pattern with a text.
    static parseQuery(query, options, { auto = true } = {}) {
      const tree = parseLogical(query);
      if (auto) for (const leaf of leavesOf(tree)) leaf.searcher = searcherFor(leaf.pattern, options);
      return tree;
    }

    // Fuse.use: registers search plugins for all instances, classes with static condition(pattern, options) and searchIn(text) (see SearcherPlugin in index.d.ts).
    // A plugin is used for the queries whose pattern its condition accepts, unless extended or token search is on.
    static use(...plugins) {
      registerPlugins(plugins);
    }

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
      const failures = [...this._failures], located = needsLocated(o) ? o : null;
      for (const tier of this._candidates) {
        if (failures.some(([t]) => t === tier)) continue;
        try {
          const scanner = backends[tier].create(index, { ignoreFieldNorm: o.ignoreFieldNorm, transposition: this._typing.transposition, useTokenSearch: o.useTokenSearch, useExtendedSearch: o.useExtendedSearch });
          const searcher = createSearcher(index, scanner, { ...o, options: o, located, highlighting: resolveHighlighting(o.highlighting), typing: this._typing, normalize: textNormalizer(o) });
          this._search = searcher.search;
          this._searchPattern = searcher.searchPattern;
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
  }
  return Fuseter;
}
