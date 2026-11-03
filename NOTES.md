# Notes

## Match highlighting (`includeMatches`)

Implemented as Fuse does it by default (`src/matches.mjs`, `createLocator` in `src/kernel-js.mjs`), so that the output can be compared with Fuse directly (`test/equivalence.test.mjs`).
Fuse's indices are weak for highlighting. The `highlighting` option (`src/align.mjs`, experimental) tries the first two ideas below: `aligned` and `allOccurrences`. It runs a dynamic-programming alignment (free start and end in the text, the kernels' costs including transposition and the first-letter weights) per returned string and traces back from every end position that costs at most kmax. Overlapping alignments are reduced to the best (lowest cost, most characters matched, shortest). Open questions from trying it:

- `allOccurrences` takes every non-overlapping alignment within the threshold. At high thresholds that marks a lot of weak places. A tighter rule could be "cost at most best + 1" or a separate threshold for highlighting.
- With `aligned` the range includes substituted and inserted text characters but not skipped query characters. A substitution at the edge of the match extends the range ("mary" for "hary"), which seems right for words but not always.
- The alignment costs O(pattern x text) per string, in plain js, so unlimited result sets on long texts are slower than Fuse's mask.

The ideas as first written:

- **Mark the aligned text, not the pattern's alphabet.** For an approximate match Fuse marks every character of `[start, start + patLen - 1 + errors]` that occurs anywhere in the pattern. Searching `hobit` in `The Hobbit` marks scattered letters of the window, and with more errors the window runs past the match. Tracing back the alignment (which text characters were matched or substituted, which were skipped) gives the matched substring. The bit vectors would have to be kept per text position, which is cheap for the few returned results.
- **Highlight more than one approximate occurrence.** With errors, Fuse reports one window per string (and only the lowest start of the best level, which is arbitrary among equally good places). Every non-overlapping local optimum could be reported, or the best-scoring one rather than the first.
- **Chunked patterns.** For queries over 32 characters Fuse searches each chunk with the chunk's offset as expected location (`ignoreLocation` does not remove that). Chunk hits at or before the offset stop the scan, so the reported start depends on the chunk position. This is reproduced for parity; an alignment-based version would not need it.
- **Weighted costs.** With `typing.firstLetter` the window length uses the weighted cost as the number of errors, so it can be a little long. Counting the real edits would fix that.
- **Code point and grapheme boundaries.** Ranges are UTF-16 offsets and can split a surrogate pair or a letter and its combining mark when `indicesIn` is "normalized". With "original" the mapping keeps a code point and its trailing marks together, but ranges from the window rule can still cut through an emoji sequence or another multi-code-point grapheme.
- **`minMatchCharLength`.** Dropping short fragments is what makes Fuse's output readable in practice. It is supported as in Fuse (it also changes which strings match, so the scan is followed by a js pass that finds the fragments of every candidate string). With `highlighting` the ranges are only filtered by length afterwards; the matching itself still uses Fuse's ranges.
- **Cost.** `slotValues` walks the key paths of a returned document again. For very large unlimited result sets the per-document work (re-reading values, one scan per matched string) is about as slow as Fuse; storing the original strings per slot at index time would avoid the re-walk at the price of memory.
