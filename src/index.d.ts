export type Backend = "simd" | "wasm" | "js";

export type KeyDefinition = string | string[] | { name: string | string[]; weight?: number };

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

export interface RuntimeOptions {
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
  static createSync<T>(docs: readonly T[], options?: FuseterOptions): Fuseter<T>;
  /** The backend that is actually running. */
  readonly backend: Backend;
  readonly requestedBackend: Backend;
  /** Why the requested backend was not used, or null. */
  readonly fallbackReason: Error | null;
  readonly size: number;
  /** Stage timings (ms) of the most recent search. */
  readonly timings: { scan: number; combine: number; format: number };
  search(query: string, options?: SearchOptions): FuseterResult<T>[];
  setCollection(docs: readonly T[]): this;
}

export default Fuseter;
