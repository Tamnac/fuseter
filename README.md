# fuseter

Replacement for `Fuse.search` with `ignoreLocation: true`. Items, order and scores are identical to Fuse 7.5 (`npm test` compares them against Fuse 7.5.x on random corpora), 10-40x faster with the plain js tier and 100-300x with the simd tier. ESM only; `require()` works on Node 20.19+ and 22.12+.

```js
import { Fuseter } from "fuseter";          // or "fuseter/js", "fuseter/wasm", "fuseter/simd"
const ff = await Fuseter.create(books, { keys: [{ name: "title", weight: 3 }, "author"], threshold: 0.3, includeScore: true });
ff.search("hary poter", { limit: 10 });        // [{ item, refIndex, score }]
ff.backend;                                    // the tier that is really running
```

## Backends

Fuseter has three implementations of the same search. Faster ones need more from the runtime and add download size.

![Search time of Fuse and the three Fuseter tiers](https://raw.githubusercontent.com/Tamnac/fuseter/main/docs/benchmark.svg)

The same measurements without Fuse, with a scale that makes the tiers comparable:

![Search time of the three Fuseter tiers](https://raw.githubusercontent.com/Tamnac/fuseter/main/docs/benchmark-tiers.svg)

| tier | needs | download (gzip) | search, 10K docs, threshold 0.3 |
|---|---|---|---|
| `simd` | WebAssembly SIMD (all current browsers and Node) | 25 KB | 0.4-0.7 ms |
| `wasm` | WebAssembly | 12.7 KB | 2-3 ms |
| `js` | nothing | 8.7 KB | 4-5 ms |
| Fuse 7.5 | nothing | | 40-200 ms |

What to choose:

- **Nothing**: `import { Fuseter } from "fuseter"` uses simd and falls back to a slower tier if the runtime cannot run it (no WebAssembly, blocked by a Content-Security-Policy, out of memory).
- **Smallest bundle**: import from `fuseter/js` or `fuseter/wasm`. `fuseter/js` contains no wasm at all, `fuseter/wasm` only the small scalar module.
- **A specific tier**: `Fuseter.create(docs, options, { backend: "wasm" })`. `fallback` sets how far it may degrade: `"js"` (default), `"wasm"`, or `"throw"` to fail instead.
- **To see what happened**: `ff.backend` is the tier that is running, `ff.fallbackReason` says why it degraded.
- **Without await**: `Fuseter.createSync(docs, options)` returns a js instance immediately, because wasm compiles asynchronously.

`setCollection(docs)` replaces the documents and rebuilds the index (about 0.1 s per 10K documents with 3 keys on simd).

## Differences from Fuse

- `ignoreLocation` is always on (and is the default here). `location` and `distance` are accepted and ignored.
- Not supported, rejected with a `TypeError`: `useExtendedSearch`, `useTokenSearch`, `includeMatches`, `findAllMatches`, `minMatchCharLength > 1`, `shouldSort: false`, `sortFn`, `getFn` (also per key), unknown options, non-string queries.
- Supported: string collections, `keys` (names, dotted paths, path arrays, weights), array values (each element is a separate string like in Fuse, at most 64 strings per document), numbers and booleans as text, `threshold` (also per search), `limit`, `includeScore`, `isCaseSensitive`, `ignoreDiacritics`, `ignoreFieldNorm`, `fieldNormWeight`, blank queries (return every document, like Fuse), patterns longer than 32 characters (chunked like Fuse, slower: no in-wasm combine).
- `ignoreDiacritics` strips `\p{M}`, Fuse uses a fixed list of marks; 73 recently added code points differ.
- Objects inside array values are ignored (Fuse indexes `"[object Object]"`).

## Typing heuristics (experimental)

Opt-in options for search-as-you-type over short names and titles. They change the ranking, so results no longer match Fuse, and they may change in a minor release. Without `typing`, results are identical to Fuse.

```js
Fuseter.create(models, { keys: ["name"], typing: { firstLetter: true, transposition: true } });
```

- `firstLetter`: the first letter of each query word counts double. A wrong or missing first letter costs 2 errors, and a first letter that matches the start of a word in the text is free. With `pt`, `x (pt)` scores 0.001 and `GPT` 0.333.
  - `{ weighted: "first" }` weights only the first letter of the whole query instead of every word.
  - `{ midWord: 2 }` makes a correct first letter in the middle of a word cost as much as a wrong one (default 1).
  - Words start after spaces and punctuation, and at camelCase humps (`myValue`). Queries over 32 characters ignore the option.
- `transposition`: swapping two adjacent letters costs 1 error instead of 2, so `desspeek` still finds `deepseek`.

Cost on 10K books: `transposition` makes searches 20-25% slower, `firstLetter` roughly 2x slower (simd: 0.3 ms becomes 0.5 ms; see `scripts/bench-typing.mjs`). On the simd tier each option set loads an extra 9-12 KB (gzip) wasm module the first time it is used, so nothing is downloaded unless you enable them.

## Development

- `npm install`, then `npm test`: runs the equivalence suite (random corpora, all tiers, thresholds 0-1, limits, every supported option, forced fallbacks) against the Fuse 7.5 dev dependency. Takes about a minute.
- `npm run build:wasm` rebuilds `wasm/*.wasm` and the embedded `src/wasm/*.mjs` from `zig/` (needs zig 0.17; the generated `src/wasm/*.mjs` are committed and CI fails if a rebuild changes them).
- `node scripts/browser-check.mjs [chromium] [firefox] [webkit]` bundles the library with esbuild (code splitting) and runs the Fuse comparison, the typing options and the fallback logic in real browsers, once normally and once under a CSP that blocks wasm. Setup: `npm i --no-save playwright esbuild && npx playwright install chromium firefox`. Last run: Chromium 156 and Firefox 157 pass; Safari is untested.
- `node scripts/bench.mjs [books.json] [--fuse] [--json=file]` prints a timing table (`--json` saves it, `node scripts/chart.mjs` turns it into the charts in `docs/`); `node scripts/bench-typing.mjs [books.json]` compares the typing heuristics with the standard kernels.
