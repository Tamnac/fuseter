# Match, parseQuery and plugins

Static helpers that mirror Fuse's, plus a plugin hook for custom search syntax.

## Fuseter.match

```js
Fuseter.match(pattern, text, options); // { isMatch, score, indices? }
```

Compares one pattern with one text. `indices` is present with `includeMatches`.

- `options` are those of a Fuseter on top of `Fuseter.config`, so `ignoreLocation` is on unless you pass `false`.
- Extended search works, but the result has no `hasInverse`.
- `useTokenSearch` throws, as in Fuse.
- A blank text never matches. Fuse matches it in `match`.
- Each call builds a one-text instance. This is fine for a few comparisons. To filter a collection, use `search`.

## Fuseter.parseQuery

```js
Fuseter.parseQuery(query, options, { auto });
```

Returns the tree of a logical query as Fuse does: `{ operator, children }` nodes and `{ keyId, pattern, searcher }` leaves. With `auto: false` leaves have no `searcher`. A leaf's `searcher.searchIn(text)` is `Fuseter.match` for its pattern, or the plugin that accepts it.

## Plugins

`Fuseter.use(...plugins)` registers search plugins for all instances.

A plugin is a class with:
- `static condition(pattern, options)`: returns true if the plugin handles this pattern.
- `searchIn(text)`: returns `{ isMatch, score, indices?, hasInverse? }`.

```js
class Prefix {
  static condition(pattern) { return pattern.startsWith("^^"); }
  constructor(pattern) { this.prefix = pattern.slice(2).toLowerCase(); }
  searchIn(text) {
    const isMatch = text.toLowerCase().startsWith(this.prefix);
    return { isMatch, score: isMatch ? 0.01 : 1, indices: [[0, this.prefix.length - 1]] };
  }
}
Fuseter.use(Prefix);
ff.search("^^the");
```

- The first plugin whose condition accepts a pattern replaces the built-in search for it. This applies to plain and logical queries, `match` and `parseQuery`.
- `useExtendedSearch` and `useTokenSearch` take precedence over plugins, as in Fuse.
- Scores, ordering, `limit`, `sortFn`, `includeMatches` and the rule that drops documents with an inverse match in one key and none in another follow Fuse.
- `searchIn` receives the original text, not the lower-cased one.
- Plugins run in js with one call per string, so they are slower than the built-in search.
- In a logical query every leaf is evaluated on all strings of its key before the tree is. A plugin may therefore be called on strings Fuse would skip when an `$and` fails early.
