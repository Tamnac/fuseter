export type Backend = "simd" | "wasm" | "js";

export type KeyDefinition = string | string[] | { name: string | string[]; weight?: number; getFn?: (doc: any) => unknown };

/** The key as Fuse describes it to a `sortFn`; `weight` is the share of the total key weight. */
export interface SortKey { path: string[]; id: string; weight: number; src: string | string[]; getFn: ((doc: any) => unknown) | null }

export interface SortMatch {
  score: number;
  key?: SortKey;
  value: string;
  /** Position in the array `value` was found in. */
  idx?: number;
  norm: number;
  /** With `includeMatches`. */
  indices?: [number, number][];
}

export interface SortRecord {
  idx: number;
  item: any;
  score: number;
  matches: SortMatch[];
}

export interface FuseterOptions {
  keys?: KeyDefinition[];
  /** Default 0.6. Can be overridden per search. */
  threshold?: number;
  includeScore?: boolean;
  /** Adds `matches` to every result, in Fuse's format. */
  includeMatches?: boolean;
  /**
   * What the `indices` of a match refer to. "normalized" (default) is the lower-cased, diacritic-stripped text, which is what Fuse reports.
   * "original" maps them back to `value`, which differs when normalisation changes the length of the text (`ß`, combining marks with `ignoreDiacritics`).
   */
  indicesIn?: "normalized" | "original";
  isCaseSensitive?: boolean;
  ignoreDiacritics?: boolean;
  ignoreFieldNorm?: boolean;
  fieldNormWeight?: number;
  /** Experimental, needs `includeMatches`. Changes which ranges are reported, so they no longer match Fuse's, and may change in a minor release. */
  highlighting?: HighlightingOptions;
  /** Experimental, opt-in typing heuristics. They change the ranking, so results no longer match Fuse, and they may change in a minor release. */
  typing?: TypingOptions;
  /** Default true. With false the results are in document order (a `limit` keeps the first ones). */
  shouldSort?: boolean;
  /**
   * Custom order, called like Fuse's with its internal result records: `{ idx, item, score, matches: [{ score, key, value, idx?, norm, indices? }] }`.
   * `item` is Fuse's index record (`{ [key position]: { v, n } }`), not the document; use `idx` to get the document. Ties are broken by `idx`.
   * Runs on every hit before the limit is applied, and `includeMatches` then computes indices for every hit. Ignored with `shouldSort: false`.
   */
  sortFn?: (a: SortRecord, b: SortRecord) => number;
  /**
   * Default 1. A string only matches when some matched fragment (the ranges `includeMatches` reports) has this many characters, or the string equals the query.
   * Needs js to find the fragments of every candidate string, so searches get slower.
   */
  minMatchCharLength?: number;
  /**
   * Reads the value(s) of a key from a document: a string, or an array of strings and `{ v, i }` records (`i` is reported as refIndex).
   * Called with `(doc, path)`, and with `(doc)` for a key's own `getFn`; once per document and key when indexing. The default is `Fuseter.config.getFn`,
   * which can be wrapped. Ignored for collections of strings.
   */
  getFn?: (doc: any, path: string[]) => unknown;
  /**
   * Fuse's token search: the query is split into terms, each is searched on its own, and the scores of the terms that match are combined weighted by
   * their rarity in the collection (idf), so a rare term counts more than "the". Default false.
   */
  useTokenSearch?: boolean;
  /** Splits the query and the indexed strings into terms. A RegExp needs the global flag. Default: runs of letters, marks, digits and "_". */
  tokenize?: RegExp | ((text: string) => string[]);
  /** With "all" a document only matches when its strings together match every term. Default "any". */
  tokenMatch?: "any" | "all";
  /** Accepted, no effect while ignoreLocation is on. */
  findAllMatches?: boolean;
  /** Only `true` is supported (this is the default here, unlike Fuse). */
  ignoreLocation?: true;
  /** Accepted, no effect while ignoreLocation is on. */
  location?: number;
  distance?: number;
}

export interface HighlightingOptions {
  /**
   * A range is the text the query was aligned with (for "hary poter" in "Rosemary Rogers": "mary Roger"), computed with the same costs as the scan.
   * Fuse marks every character of the best window that occurs anywhere in the query, which gives scattered fragments for weak matches.
   */
  aligned?: boolean;
  /**
   * Every place where the query matches within the threshold is marked, best first when picking, not only the best one.
   * Fuse marks all error-free occurrences but only one approximate one.
   */
  allOccurrences?: boolean;
}

export interface TypingOptions {
  /**
   * The first character of every query word counts double: editing it costs 2 errors, it is free on a word-initial character,
   * and the score is errors / (query length + number of words). `weighted: "first"` weights only the first character of the query
   * (the score divides by query length + 1). Queries over 32 characters ignore it.
   * `midWord` (default 1) is the cost of an exact weighted character that is not on a word start; 2 prices it like a wrong one.
   * The simd tier loads a different wasm module (about 9.4 KB gzipped, 11.6 KB with `transposition`) the first time this is used.
   */
  firstLetter?: boolean | { weighted?: true | "first"; midWord?: 1 | 2 };
  /**
   * Swapping two adjacent characters counts as one error instead of two (optimal string alignment distance).
   * The simd tier loads a second wasm module (about 9 KB gzipped) the first time this is used.
   */
  transposition?: boolean;
}

/** Fuse's serialised index. The records are Fuse's: `{ v, i, n }` per string of a string collection, `{ i, $: { [key position]: { v, n } | [{ v, i, n }] } }` per document. */
export interface FuseterIndex {
  readonly keys: { path: string[]; id: string; weight: number; src: string | string[] }[];
  records: unknown[];
  size(): number;
  add(doc: unknown, docIndex: number): unknown;
  removeAt(index: number): void;
  removeAll(indices: number[]): void;
  toJSON(): { keys: FuseterIndex["keys"]; records: unknown[] };
}

/** What `parseIndex` takes and `create` accepts: a FuseterIndex, or a Fuse index (the object or its parsed JSON). */
export type IndexLike = Pick<FuseterIndex, "keys" | "records">;

export interface RuntimeOptions {
  /** An index made from these documents by createIndex, parseIndex or Fuse.createIndex; it saves extracting the strings. add and remove update it in place. */
  index?: IndexLike;
  /** Fastest tier to try. Default: the best tier of the entry point. */
  backend?: Backend;
  /** Lowest tier the library may degrade to when `backend` cannot run. Default "js"; "throw" disables degrading. */
  fallback?: "js" | "wasm" | "throw";
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
}

export interface FuseterMatch {
  /** Inclusive [start, end] ranges into `value`, sorted and not touching. */
  indices: [number, number][];
  /** The string that matched. */
  value: string;
  /** The key, as in Fuse: the name, or the path joined with "."; absent for collections of strings. */
  key?: string;
  /** Position in the array `value` was found in, when the key's value is an array. */
  refIndex?: number;
}

export interface FuseterResult<T> {
  item: T;
  refIndex: number;
  score?: number;
  /** With `includeMatches`. */
  matches?: FuseterMatch[];
}

export class Fuseter<T = unknown> {
  static create<T>(docs: readonly T[], options?: FuseterOptions, runtime?: RuntimeOptions): Promise<Fuseter<T>>;
  /** js backend only. */
  static createSync<T>(docs: readonly T[], options?: FuseterOptions, index?: IndexLike): Fuseter<T>;
  /** Fuse.createIndex: the index of the documents for these keys, to serialise with JSON.stringify and load again with parseIndex. */
  static createIndex(keys: readonly KeyDefinition[], docs: readonly unknown[], options?: Pick<FuseterOptions, "getFn" | "fieldNormWeight">): FuseterIndex;
  /** Fuse.parseIndex: the index from the parsed JSON of an index (made here or by Fuse). */
  static parseIndex(data: IndexLike): FuseterIndex;
  /** The defaults of new instances; changing them affects instances created afterwards. */
  static config: FuseterOptions;
  static readonly version: string;
  /** The backend that is actually running. */
  readonly backend: Backend;
  readonly requestedBackend: Backend;
  /** Why the requested backend was not used, or null. */
  readonly fallbackReason: Error | null;
  readonly size: number;
  /** Stage timings (ms) of the most recent search. */
  readonly timings: { scan: number; combine: number; format: number };
  search(query: string, options?: SearchOptions): FuseterResult<T>[];
  /** Replaces the documents; `index` (made from them) is optional. */
  setCollection(docs: readonly T[], index?: IndexLike): this;
  /**
   * Like Fuse: pushes onto the array passed in (null and undefined are ignored). The index is updated at once and flattened again by the next search,
   * so changing the collection between searches costs a rebuild per search.
   */
  add(doc: T): void;
  /** Removes the documents the predicate accepts and returns them; the array passed in is not changed (the instance keeps a filtered copy). */
  remove(predicate?: (doc: T, index: number) => boolean): T[];
  /** Removes (splicing the array passed in) and returns the document at `index`; throws a RangeError for an index outside the collection. */
  removeAt(index: number): T;
  /** The index in Fuse's format: the one the instance was given, or one made on first use. Kept up to date by add, remove and removeAt. */
  getIndex(): FuseterIndex;
}

export default Fuseter;
