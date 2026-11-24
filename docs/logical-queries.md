# Logical queries

`search` also takes Fuse's logical query objects: `$and` and `$or` of leaves.

```js
ff.search({ $and: [{ author: "tolkein" }, { $or: [{ title: "lord" }, "hobit"] }] });
```

## Leaves

| Leaf | Searches |
|---|---|
| `"pattern"` | every key |
| `{ key: "pattern" }` | one key |
| `{ $path: "key", $val: "pattern" }` | one key. `$path` may be an array. |

- An object with several keys is the AND of its entries.
- As in Fuse, `{ $path, $val }` must be inside `$and` or `$or`, not the whole query.
- Collections of strings never match.

## Compatibility

- Results, scores and `includeMatches` are identical to Fuse's, with all options (extended search, `sortFn`, location scoring and so on).
- As in Fuse, the score multiplies the matches of every leaf that took part, so a string matched by two leaves counts twice.
- Fuse 7.5 throws on logical queries with `useTokenSearch`. Here each leaf is a token search, and `tokenMatch: "all"` has no effect.

## Performance

Each leaf scans every string like a query of its own, so a logical query costs about as much as its leaves together.
