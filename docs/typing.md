# Typing heuristics (experimental)

Options that rank results closer to how people type and make typos.

They change the ranking, so results no longer match Fuse. The options are not stable yet. Without `typing`, results are identical to Fuse.

```js
Fuseter.create(models, { keys: ["name"], typing: { firstLetter: true, transposition: true } });
```

## firstLetter

The first letter of each query word counts double. A wrong or missing first letter costs 2 errors. This is based on research suggesting that the first letter is rarely wrong ([Pollock & Zamora, 1983](https://doi.org/10.1002/asi.4630340108); [abbreviation expansion for users with motor disabilities](https://www.researchgate.net/publication/336536172_A_Probabilistic_Flexible_Abbreviation_Expansion_System_for_Users_With_Motor_Disabilities)).

| Setting | Effect |
|---|---|
| `firstLetter: true` | Every query word's first letter counts double. |
| `{ weighted: "first" }` | Only the first letter of the whole query counts double. |
| `{ midWord: 2 }` | A correct first letter in the middle of a word costs as much as a wrong one (default 1). |

- Words start after spaces and punctuation, and at camelCase humps (`myValue`).
- Queries over 32 characters ignore the option.

## transposition

Swapping two adjacent letters costs 1 error instead of 2.

## Cost

Times below are for 10K books (`scripts/bench-typing.mjs`).

| Option | Slowdown |
|---|---|
| `transposition` | about 10% |
| `firstLetter`, threshold 0.3 | up to 40% (simd: 0.31 ms becomes 0.33 ms) |
| `firstLetter`, threshold 0.6 | 4-14x, most with long queries (simd: 0.44 ms becomes 3.6 ms, js: 1.6 ms becomes 22 ms) |

On the simd tier, each option set loads an extra wasm module the first time it is used: 4.4 KB (gzip) for `transposition`, 14-17 KB with `firstLetter`.

## Compatibility

- Works with `includeMatches`, token search and fuzzy terms of extended search.
- Not available with [location scoring](location.md).
