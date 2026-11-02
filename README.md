# fastfuse

Replacement for `Fuse.search` with `ignoreLocation: true`. Items, order and scores are identical to Fuse 7.5 (checked by `npm test` against the installed Fuse), 50-200x faster depending on the backend.

```js
import { FastFuse } from "fastfuse";          // or "fastfuse/js", "fastfuse/wasm", "fastfuse/simd"
const ff = await FastFuse.create(books, { keys: [{ name: "title", weight: 3 }, "author"], threshold: 0.3, includeScore: true });
ff.search("hary poter", { limit: 10 });        // [{ item, refIndex, score }]
ff.backend;                                    // the tier that is really running
```

## Backends

| tier | needs | extra size, gzip | 10K docs, threshold 0.3 |
|---|---|---|---|
| `simd` | WebAssembly SIMD | +3 KB glue, +10.5 KB embedded wasm (base64) | ~1 ms |
| `wasm` | WebAssembly | +0.8 KB wasm as base64 | ~5 ms |
| `js` | nothing | 6 KB for the whole js tier | ~13 ms |

Sizes are unminified sources gzipped (the wasm is 7.2 KB gzipped as binary, base64 inflates it). Fuse itself needs 150-250 ms for the same searches (numbers from a noisy machine, see NOTES.md for the careful ones).

Entry points: `fastfuse/js` ships no wasm bytes, `fastfuse/wasm` ships the scalar module, `fastfuse` and `fastfuse/simd` ship both. The developer chooses the tier: `create(docs, options, { backend })`. If that tier cannot run (no WebAssembly, no SIMD, blocked by CSP, memory limit) the library degrades down to `fallback` (`"js"` default, `"wasm"`, or `"throw"` to fail instead). `ff.backend`, `ff.requestedBackend` and `ff.fallbackReason` tell what happened. `FastFuse.createSync` builds a js instance synchronously (wasm compilation is async).

`setCollection(docs)` rebuilds everything (about 0.1 s per 10K documents x 3 keys on simd).

## Differences from Fuse

- `ignoreLocation` is always on (and is the default here). `location` and `distance` are accepted and ignored.
- Not supported, rejected with a `TypeError`: `useExtendedSearch`, `useTokenSearch`, `includeMatches`, `findAllMatches`, `minMatchCharLength > 1`, `shouldSort: false`, `sortFn`, `getFn` (also per key), unknown options, non-string queries.
- Supported: string collections, `keys` (names, dotted paths, path arrays, weights), array values (each element is a separate string like in Fuse, at most 64 strings per document), numbers and booleans as text, `threshold` (also per search), `limit`, `includeScore`, `isCaseSensitive`, `ignoreDiacritics`, `ignoreFieldNorm`, `fieldNormWeight`, blank queries (return every document, like Fuse), patterns longer than 32 characters (chunked like Fuse, slower: no in-wasm combine).
- `ignoreDiacritics` strips `\p{M}`, Fuse uses a fixed list of marks; 73 recently added code points differ.
- Objects inside array values are ignored (Fuse indexes `"[object Object]"`).

## Typing heuristics (opt-in, not Fuse compatible)

`typing: { firstLetter: true | { weighted, midWord }, transposition: true }`.
`firstLetter` makes the first character of every query word count double: editing it (substituting or dropping it) costs 2 errors, an exact one that is not on a word start costs 1 (`midWord`, default 1; 2 prices it like a wrong one), one on a word start is free, and the score is `errors / (query length + number of words)`. A word starts at a letter or digit that follows anything else (space, `-`, `:`, `(`, start of string) or at an upper-case letter that follows a lower-case one (`myPtValue` has the words `my` and `Pt`; a digit followed by an upper-case letter, as in `GPT4Terra`, is not a start). With `pt`, `x (pt)` scores 0.001, while `Prompt tuned`, `GPT` and `Perceptron` score 0.333 each (the exact mid-word `pt` and a word-start `Pr` both cost 1). `wen co` weights the `w` and the `c`: it scores `Cohere: Command A+` 3 / 8 = 0.375 (the `w` has no word start to match (2), the `n` against `:` costs 1). Matching is on the whole pattern as one string, as in Fuse, not word by word. A transposition still costs 1, but one that involves a weighted character has to start on a word start.
`firstLetter: { weighted: "first" }` weights only the first character of the whole query (`wen co` weights the `w`), and the score divides by `query length + 1`. The space in a multi-word query already forces the next letter onto a word start when it matches exactly, so the two modes differ when that letter has a typo. Queries over 32 characters ignore the option. Without `typing`, results are identical to Fuse.
Cost on 10K books (`node scripts/bench-typing.mjs`, threshold 0.3 / 0.6, `harry potter`): simd 0.32 -> 0.53 ms / 0.64 -> 0.91 ms, wasm 1.8 -> 3.3 ms / 3.6 -> 6.0 ms, js 3.2 -> 7.5 ms / 6.2 -> 11.8 ms. The default (every word) takes up to 2x as long as `"first"` on multi-word queries (29 ms against 25 ms for a 29-character query on js at 0.6) because the larger denominator allows more error levels.
`typing: { transposition: true }` counts swapping two adjacent characters as one error instead of two (optimal string alignment distance: `desspeek` is 2 errors from `deepseek`, not 3), so scores of strings found through a swap drop and more of them stay within the threshold. It runs in all three tiers; the kernels keep one more state per level, which costs about 20-25% search time on 10K books (simd 0.31 -> 0.37 ms at threshold 0.3, 1.8 -> 2.3 ms for a 29-character query at 0.6; `node scripts/bench-typing.mjs`). The scalar wasm module carries all variants (5.2 KB raw, 1.8 KB gzipped). The simd tier loads a different wasm module for each option set, through a dynamic `import()` the first time it is used, so users who do not enable the options pay nothing: transposition 33.7 KB raw / 9 KB gzipped (`src/wasm/simd-transposition.mjs`), `firstLetter` 36.6 KB / 9.4 KB (`simd-weighted.mjs`), both 41.8 KB / 11.6 KB (`simd-weighted-transposition.mjs`); the weighted modules contain no unweighted kernels. Both options can be combined. Other heuristics are planned (see NOTES.md).

## Development

- `npm test` runs the equivalence suite (random corpora, all tiers, thresholds 0-1, limits, every supported option, forced fallbacks) against Fuse. Needs `fuse.js` installed.
- `npm run build:wasm` rebuilds `wasm/*.wasm` and the embedded `src/wasm/*.mjs` from `zig/` (needs zig 0.17; the generated files are committed).
- `node scripts/bench.mjs [books.json] [--fuse]` prints a timing table; `node scripts/bench-typing.mjs [books.json]` compares the typing heuristics with the standard kernels.
- `npm run demo` serves a browser app at http://localhost:5173/: live search, side by side with Fuse (rows that differ are highlighted, identical/differs verdict), backend and option controls, stage timings, a benchmark button, your own data (put `.txt` files with one word per line, or `.json` arrays of strings/objects, in `demo/data/` and they appear in the data dropdown; the file picker takes the same formats), a "typing heuristics" row of checkboxes generated from `demo/heuristics.mjs` (one `{ id, label, title, options }` entry per heuristic; checked entries are merged into the FastFuse options only, so the comparison shows exactly which ranks move), and a free-form "extra options" JSON field. URL parameters `q`, `backend`, `threshold`, `limit` preset the form.

The zig sources in `zig/` are copies of `../zig/fast4.zig` and `../zig/simd7.zig`; the originals are kept until the old scratch scripts are removed.
