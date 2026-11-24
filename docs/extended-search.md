# Extended search

`useExtendedSearch: true` reads the query in Fuse's extended syntax.

```js
const ff = await Fuseter.create(books, { keys: ["title", "author"], useExtendedSearch: true });
ff.search("^the lord | 'ring !hobbit$");
```

## Syntax

| Term | Matches strings that |
|---|---|
| `jscript` | fuzzy-match `jscript` |
| `=scheme` | equal `scheme` |
| `'python` | include `python` |
| `^java` | start with `java` |
| `.js$` | end with `.js` |
| `!ruby` | do not include `ruby` |
| `!^java` | do not start with `java` |
| `!.js$` | do not end with `.js` |

- Terms separated by spaces must **all** match (AND).
- Groups separated by `|` are alternatives (OR). `\|` is a literal bar.
- A term with spaces goes in double quotes, also behind an operator: `^"the lord"`.
- The first matching group decides the score, which is the mean of its terms' scores.

## Compatibility

- Results, scores and `includeMatches` are identical to Fuse's on every backend.
- Fuzzy terms follow `threshold`, `ignoreLocation: false` with `location` and `distance`, `minMatchCharLength`, and the case and diacritics options.
- As in Fuse, a document is dropped when an inverse term (`!`) matches in one key and the query does not match in another.
- Extended search takes precedence over `useTokenSearch`.
- The [typing heuristics](typing.md) apply to fuzzy terms, with the usual change in results.

## Performance

- Queries with an exact-style term (`=`, `'`, `^`, `$`) in every group are fastest, since only the strings matching that term are checked further.
- Fuzzy terms on every string cost about as much as a plain search.
- The extended search code adds about 2.3 KB (gzip) to every entry point, and 2.9 KB more of wasm on the simd tier.

Search time in ms (threshold 0.3, keys `title` and `author`, from `scripts/bench-extended.mjs`):

| Query | 10K books: Fuse | simd | wasm | js | 80K books: Fuse | simd |
|---|---|---|---|---|---|---|
| `'lord` | 3.0 | 0.09 | 0.34 | 0.34 | 23 | 0.84 |
| `'lord !rings` | 2.7 | 0.09 | 0.35 | 0.34 | 23 | 0.84 |
| `^the lord` | 5.4 | 0.19 | 0.26 | 0.25 | 39 | 1.6 |
| `^the !hobbit$ 'ring` | 2.5 | 0.09 | 0.51 | 0.50 | 22 | 0.79 |
| `hary poter` | 26 | 0.39 | 2.2 | 2.5 | 202 | 3.6 |
| `tolkein \| christie` | 70 | 0.46 | 2.2 | 2.5 | 581 | 4.2 |
