import { buildIndex } from "./index-build.mjs";
import { createSearcher } from "./search.mjs";
import { textNormalizer } from "./text.mjs";
import { resolveTyping } from "./typing.mjs";

const TIERS = ["simd", "wasm", "js"];   // fastest first
const FALLBACKS = ["js", "wasm", "throw"];

const OPTION_DEFAULTS = {
  keys: [], threshold: 0.6, includeScore: false, isCaseSensitive: false, ignoreDiacritics: false,
  ignoreFieldNorm: false, fieldNormWeight: 1,
  typing: null,   // opt-in heuristics, not Fuse compatible (see typing.mjs)
};
// Accepted for compatibility; they have no effect while ignoreLocation is on.
const IGNORED_OPTIONS = ["location", "distance"];
const UNSUPPORTED = {
  useExtendedSearch: false, useTokenSearch: false, includeMatches: false, findAllMatches: false, minMatchCharLength: 1,
  shouldSort: true, sortFn: undefined, getFn: undefined, ignoreLocation: true,
};

function resolveOptions(options) {
  for (const name of Object.keys(options)) {
    if (name in OPTION_DEFAULTS || IGNORED_OPTIONS.includes(name)) continue;
    if (!(name in UNSUPPORTED)) throw new TypeError(`fastfuse: unknown option '${name}'`);
    if (options[name] !== UNSUPPORTED[name]) throw new TypeError(`fastfuse: option '${name}' is not supported (only ${JSON.stringify(UNSUPPORTED[name])})`);
  }
  return { ...OPTION_DEFAULTS, ...options };
}

// Builds the FastFuse class for the given set of backends ({ simd?, wasm?, js }); each package entry point passes only what it ships.
export function defineFastFuse(backends, defaultBackend) {
  function plan(backend, fallback) {
    if (!(backend in backends)) throw new TypeError(`fastfuse: backend '${backend}' is not available in this entry point (has: ${Object.keys(backends).join(", ")})`);
    if (!FALLBACKS.includes(fallback)) throw new TypeError(`fastfuse: fallback must be one of ${FALLBACKS.join(", ")}`);
    const floor = fallback === "throw" ? backend : fallback;
    return TIERS.slice(TIERS.indexOf(backend), TIERS.indexOf(floor) + 1).filter(t => t in backends);
  }

  return class FastFuse {
    // Rank-equivalent drop-in for `new Fuse(docs, { ...options, ignoreLocation: true }).search(query, { limit })`.
    // runtime: { backend: 'simd' | 'wasm' | 'js', fallback: 'js' (default) | 'wasm' | 'throw' }
    static async create(docs, options = {}, { backend = defaultBackend, fallback = "js" } = {}) {
      const candidates = plan(backend, fallback), failures = [];
      const { transposition, firstLetter } = resolveTyping(resolveOptions(options).typing);
      for (const tier of candidates) {
        try { await backends[tier].load({ transposition, weighted: Boolean(firstLetter) }); } catch (e) { failures.push([tier, e]); }
      }
      return new FastFuse(docs, options, { backend, candidates, failures });
    }

    // Synchronous construction on the js backend (wasm needs async compilation).
    static createSync(docs, options = {}) {
      return new FastFuse(docs, options, { backend: "js", candidates: ["js"], failures: [] });
    }

    constructor(docs, options, { backend, candidates, failures }) {
      this.options = resolveOptions(options);
      this._typing = resolveTyping(this.options.typing);
      this.requestedBackend = backend;
      this._candidates = candidates;
      this._failures = failures;
      this.setCollection(docs);
    }

    // Rebuilds the index and the backend state; costs about as much as constructing.
    setCollection(docs) {
      const o = this.options;
      const index = buildIndex(docs, { ...o, starts: Boolean(this._typing.firstLetter) });
      const failures = [...this._failures];
      for (const tier of this._candidates) {
        if (failures.some(([t]) => t === tier)) continue;
        try {
          const scanner = backends[tier].create(index, { ignoreFieldNorm: o.ignoreFieldNorm, transposition: this._typing.transposition });
          const searcher = createSearcher(index, scanner, { ...o, typing: this._typing, normalize: textNormalizer(o) });
          this._search = searcher.search;
          this.timings = searcher.timings;
          this.backend = tier;
          this.fallbackReason = failures.length ? failures[0][1] : null;
          this.size = index.nDocs;
          return this;
        } catch (e) { failures.push([tier, e]); }
      }
      const [tier, cause] = failures[0];
      throw new Error(`fastfuse: backend '${tier}' failed and no fallback is allowed: ${cause.message}`, { cause });
    }

    // Returns [{ item, refIndex, score? }] ordered like Fuse; `threshold` here overrides the constructor option for this call.
    search(query, searchOptions) { return this._search(query, searchOptions); }
  };
}
