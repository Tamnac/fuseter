export type Backend = "simd" | "wasm" | "js";

export type KeyDefinition = string | string[] | { name: string | string[]; weight?: number };

export interface FastFuseOptions {
  keys?: KeyDefinition[];
  /** Default 0.6. Can be overridden per search. */
  threshold?: number;
  includeScore?: boolean;
  isCaseSensitive?: boolean;
  ignoreDiacritics?: boolean;
  ignoreFieldNorm?: boolean;
  fieldNormWeight?: number;
  /** Opt-in typing heuristics. They change the ranking, so results no longer match Fuse. */
  typing?: TypingOptions;
  /** Only `true` is supported (this is the default here, unlike Fuse). */
  ignoreLocation?: true;
  /** Accepted, no effect while ignoreLocation is on. */
  location?: number;
  distance?: number;
}

export interface TypingOptions {
  /**
   * The first character of every query word counts double: editing it costs 2 errors, it is free on a word-initial character,
   * and the score is errors / (query length + number of words). `weighted: "first"` weights only the first character of the query
   * (the score divides by query length + 1). Queries over 32 characters ignore it.
   * `midWord` (default 1) is the cost of an exact weighted character that is not on a word start; 2 prices it like a wrong one.
   * The simd tier loads a different wasm module (about 10.5 KB gzipped, 13 KB with `transposition`) the first time this is used.
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

export interface FastFuseResult<T> {
  item: T;
  refIndex: number;
  score?: number;
}

export class FastFuse<T = unknown> {
  static create<T>(docs: readonly T[], options?: FastFuseOptions, runtime?: RuntimeOptions): Promise<FastFuse<T>>;
  /** js backend only. */
  static createSync<T>(docs: readonly T[], options?: FastFuseOptions): FastFuse<T>;
  /** The backend that is actually running. */
  readonly backend: Backend;
  readonly requestedBackend: Backend;
  /** Why the requested backend was not used, or null. */
  readonly fallbackReason: Error | null;
  readonly size: number;
  /** Stage timings (ms) of the most recent search. */
  readonly timings: { scan: number; combine: number; format: number };
  search(query: string, options?: SearchOptions): FastFuseResult<T>[];
  setCollection(docs: readonly T[]): this;
}

export default FastFuse;
