# Options and API

Fuseter follows Fuse's API. This page lists what is supported and how Fuseter differs. Unknown options are rejected with a `TypeError`.

## Creating an instance

```js
const ff = await Fuseter.create(docs, options, { backend, fallback, index });
const ff = Fuseter.createSync(docs, options); // js tier only
```

| Third argument | Meaning |
|---|---|
| `backend` | `"simd"`, `"wasm"` or `"js"`. Default: the fastest available. |
| `fallback` | How far it may degrade if the backend is unavailable: `"js"` (default), `"wasm"` or `"throw"`. |
| `index` | A prebuilt index, see [Indexes](#indexes). |

Check `ff.backend` and `ff.fallbackReason` to see what you got.

## Collections and keys

- Collections of documents or of strings.
- `keys`: names, dotted paths, path arrays, and `{ name, weight }` objects.
- `getFn`, also per key.
- Array values: each element is searched as a separate string, up to 64 strings per document. Objects inside arrays are ignored.
- Numbers and booleans are searched as text.

## Search options

These work as in Fuse. Where noted, they can also be passed per search: `ff.search(query, { limit, threshold })`.

| Option | Notes |
|---|---|
| `threshold` | Also per search. |
| `limit` | Per search. |
| `shouldSort`, `sortFn` | |
| `includeScore` | |
| `includeMatches` | See [Match highlighting](highlighting.md). |
| `minMatchCharLength` | |
| `isCaseSensitive` | |
| `ignoreDiacritics` | Strips all combining marks (`\p{M}`). |
| `ignoreFieldNorm`, `fieldNormWeight` | |
| `ignoreLocation`, `location`, `distance`, `findAllMatches` | See [Location scoring](location.md). `ignoreLocation` defaults to `true`. |
| `useExtendedSearch` | See [Extended search](extended-search.md). |
| `useTokenSearch`, `tokenize`, `tokenMatch` | See [Token search](token-search.md). |
| `typing` | Experimental, see [Typing heuristics](typing.md). |

A blank query returns every document, like Fuse. Patterns longer than 32 characters are split into chunks like in Fuse.

## Queries

- A string: fuzzy search in all keys.
- A logical object with `$and` / `$or`: see [Logical queries](logical-queries.md).
- `Fuseter.match`, `Fuseter.parseQuery` and `Fuseter.use` (custom search plugins): see [Match, parseQuery and plugins](plugins.md).

## Performance notes

- Searches are fastest with the default options. `sortFn`, `shouldSort: false`, `minMatchCharLength > 1` and patterns over 32 characters are slower.
- Use `limit` when you only show the first results.

## Changing the collection

`add(doc)`, `remove(predicate)`, `removeAt(index)` and `setCollection(docs, index?)` work like Fuse's, including which arrays are modified:

- `add` pushes onto the array you passed in.
- `removeAt` splices it.
- `remove` keeps a filtered copy.

Changes update the index at once. The next search then rebuilds the internal search data, which costs about as much as creating the instance. This is fine for a batch of changes, but slow if you add one document between every two searches.

## Indexes

Fuseter uses Fuse's index format in both directions. An index made by `Fuse.createIndex` (as an object or its parsed JSON) can be loaded here, and the other way round.

```js
const index = Fuseter.createIndex(["title", "author"], books);
const ff = await Fuseter.create(books, { keys: ["title", "author"] }, { index });
```

- `Fuseter.parseIndex(json)` loads a serialised index.
- `ff.getIndex()` returns the index, creating it on first use.
- A prebuilt index saves extracting the strings from the documents. Its strings and field norms are used as they are, including for `includeMatches` and `sortFn`. A `getFn` runs once per document and key.
- The documents must be the ones the index was made from.
- As in Fuse, `add` and `remove` update the index object you passed in.

## Defaults

- `Fuseter.config` holds the defaults of new instances. `Fuseter.config.getFn` is Fuse's default `getFn`, which a custom `getFn` can wrap.
- `Fuseter.version` is the package version.
