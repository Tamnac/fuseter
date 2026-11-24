# Token search

`useTokenSearch: true` searches the words of the query separately, like Fuse 7.5. `"wen co"` becomes the patterns `wen` and `co`.

```js
const ff = await Fuseter.create(books, {
  keys: ["title"],
  useTokenSearch: true,
  tokenMatch: "all",
  threshold: 0.3,
});
ff.search("lord rings");
```

## Options

| Option | Meaning |
|---|---|
| `useTokenSearch` | Turn token search on. |
| `tokenMatch` | By default a string needs to match only one term. `"all"` requires every term to be matched by some string of the document. |
| `tokenize` | How text and query are split into terms. Default: runs of letters, marks, digits and `_`. Can be a global RegExp (its matches are the terms) or a function returning an array. |

A `tokenize` RegExp without the global flag is rejected. Fuse warns and uses only its first match.

## Scoring

A string scores `1 - sum(idf * (1 - score)) / sum(idf)` over the terms that match. A term's idf comes from how many indexed strings contain it, so rare terms count more. `add`, `remove` and `setCollection` keep these counts current.

Results, scores and `includeMatches` are identical to Fuse's on every backend. Extended search takes precedence over token search.

## Performance

Each distinct term is scanned like an ordinary query, so a search costs roughly one plain search per term. On 10K books at threshold 0.3, a token search of 1-7 terms takes:

| Tier | Token search | Plain search of the same text |
|---|---|---|
| simd | 0.4-1.1 ms | 0.27-0.39 ms |
| wasm | 1.1-5.0 ms | 0.6-1.1 ms |
| js | 1.3-5.9 ms | 0.7-1.2 ms |

Short terms are faster on simd, which scans terms together when their lengths add up to 16 characters or less. This does not apply with `minMatchCharLength` or any `typing` option. See `scripts/bench-tokens.mjs`.

The [typing heuristics](typing.md) apply to each term. Results then differ from Fuse's.
