# Match highlighting

`includeMatches: true` adds `matches` to every result, in Fuse's format and with Fuse's indices.

```js
const books = [{ title: "The Hobbit", tags: ["fantasy", "hobbit"] }];
const ff = await Fuseter.create(books, { keys: ["title", "tags"], includeMatches: true });
ff.search("hobit")[0].matches;
// [{ indices: [[4, 9]], value: "The Hobbit", key: "title" }, { indices: [[0, 5]], value: "hobbit", key: "tags", refIndex: 1 }]
```

| Field | Meaning |
|---|---|
| `indices` | Inclusive `[start, end]` ranges into `value`. |
| `value` | The matched string. |
| `key` | The key as written, with paths joined by `.`. Absent for collections of strings. |
| `refIndex` | Position in the array, when the key's value is an array. |

Like Fuse, the ranges mark every exact occurrence of the query. If there is none, they mark every character of the best approximate match that also occurs in the query.

Matches are computed only for the returned results, so they cost little with a `limit`. They work with the [typing heuristics](typing.md), which then decide where the best match is.

## indicesIn

`indicesIn: "original"` makes the ranges refer to `value` as it is written.

By default, as in Fuse, they refer to the text after lower-casing and, with `ignoreDiacritics`, stripping marks. That text has a different length for `ß` and for decomposed accents (`e` + a combining mark). For other text the two are the same.

## Experimental highlighting

```js
Fuseter.create(books, {
  keys: ["title"],
  includeMatches: true,
  highlighting: { aligned: true, allOccurrences: true },
});
```

Either option needs `includeMatches`. The ranges no longer match Fuse's. They are found by aligning the query with the text, using the same costs as the search (also with `typing`). Not available with [location scoring](location.md).

| Option | Effect |
|---|---|
| `aligned` | A range is the text the query was aligned with. For `hary poter` in `Sweet Savage Love Rosemary Rogers`, Fuse marks `ary Ro` and `er`, while aligned marks `mary Roger`. |
| `allOccurrences` | Every place where the query matches within the threshold is marked, not only the best one. `lord` also marks `lard` and `lorrd` at a threshold that allows one error. Without `aligned`, each place gets Fuse's character window. |
