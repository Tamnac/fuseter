# Location scoring

By default Fuseter ignores where in the text a match is (`ignoreLocation: true`). Pass `ignoreLocation: false` to score like Fuse's default: matches far from the expected position score worse.

```js
const ff = await Fuseter.create(books, {
  keys: ["title"],
  ignoreLocation: false,
  location: 0,
  distance: 100,
});
```

## How a match is scored

score = errors / pattern length + distance from `location` / `distance`

Only the text within `distance` of `location` is searched.

| Option | Meaning |
|---|---|
| `location` | Where in the text the match is expected. Must be an integer. |
| `distance` | How far from `location` a match may be. A larger value penalises distant matches less. |
| `findAllMatches` | Widens the searched text, as in Fuse. |

- A pattern over 32 characters expects each chunk further along the text.
- Scores, order, `includeMatches` and `minMatchCharLength` are identical to Fuse's on every backend.

## Limits

- Not available with `typing` or `highlighting`.
- Token search ignores the location for its terms, like Fuse.

## Cost

Searches are slower the more strings pass the threshold. On 10K books with the simd tier:

| Threshold | Hits | Extra time |
|---|---|---|
| 0.3 | a few | 0.06-0.09 ms |
| 0.6 | 0.6-1.9K | 5-7 ms |

Location scoring adds about 1 KB (gzip) to every entry point. Run `scripts/bench-location.mjs` to measure on your data.
