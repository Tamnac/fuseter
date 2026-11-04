import { fillCharTable } from "./kernel-js.mjs";

// Fuse's bitap search with `ignoreLocation: false` (src/search/bitap/search.ts): a score is errors / patLen + distance from the expected location / `distance`,
// and the text scanned per error level is a window around that location, narrowed by the best score so far. The kernels do not model this. They find the
// strings that match anywhere within the error limit, a superset of what this search can match (a window is a truncated text), and only those go through here.

// `search(s, chunkStart, wantRanges)` searches string `s` for the pattern given to `prep` (a chunk of a long pattern starts at `chunkStart` and is expected
// there too) and returns a reused { isMatch, score, ranges }. `score` is Fuse's even for a non-match: the last score computed for a candidate, or 1.
// minLength > 1 or `wantRanges` also compute Fuse's match mask; a string without a fragment of minLength characters is no match.
function createLocated(corpus, { location, distance, findAllMatches, minMatchCharLength: minLength }) {
  const { data, offs } = corpus, table = new Int32Array(65536), previous = [], found = { isMatch: false, score: 1, ranges: [] };
  let level = new Int32Array(0), lastLevel = level, mask = new Uint8Array(0), pattern, patLen, threshold, expected;

  const score = (errors, at) => {
    const accuracy = errors / patLen, proximity = Math.abs(expected - at);
    return distance ? accuracy + proximity / distance : proximity ? 1 : accuracy;
  };

  return {
    prep(chunk, limit) {
      fillCharTable(table, chunk, previous);
      pattern = chunk; patLen = chunk.length; threshold = limit;
    },

    search(s, chunkStart, wantRanges = false) {
      const ts = offs[s], textLen = offs[s + 1] - ts, computeMatches = minLength > 1 || wantRanges, top = 1 << (patLen - 1);
      expected = Math.max(0, Math.min(location + chunkStart, textLen));
      if (level.length < textLen + patLen + 2) { level = new Int32Array(textLen + patLen + 2); lastLevel = new Int32Array(level.length); }
      if (mask.length < textLen) mask = new Uint8Array(textLen);
      mask.fill(0, 0, textLen);
      let limit = threshold, bestLocation = expected, bestErrors = 0, finalScore = 1, binMax = patLen + textLen, index;
      for (; (index = findFrom(data, ts, textLen, pattern, bestLocation)) > -1; bestLocation = index + patLen) {
        limit = Math.min(score(0, index), limit);
        mask.fill(1, index, index + patLen);
      }
      bestLocation = -1;
      for (let i = 0; i < patLen; i++) {
        let binMin = 0, binMid = binMax;
        while (binMin < binMid) {
          if (score(i, expected + binMid) <= limit) binMin = binMid; else binMax = binMid;
          binMid = Math.floor((binMax - binMin) / 2 + binMin);
        }
        binMax = binMid;
        const first = Math.max(1, expected - binMid + 1), finish = findAllMatches ? textLen : Math.min(expected + binMid, textLen) + patLen;
        let start = first, low = finish + 1;
        level[low] = (1 << i) - 1;
        for (let j = finish; j >= start; j--) {
          const at = j - 1;
          let bits = ((level[j + 1] << 1) | 1) & (at < textLen ? table[data[ts + at]] : 0);
          if (i) bits |= ((lastLevel[j + 1] | lastLevel[j]) << 1) | 1 | lastLevel[j + 1];
          level[low = j] = bits;
          if (bits & top && (finalScore = score(i, at)) <= limit) {
            limit = finalScore; bestLocation = at; bestErrors = i;
            if (at <= expected) break;
            start = Math.max(1, 2 * expected - at);
          }
        }
        if (score(i + 1, expected) > limit) break;
        level.fill(0, first, low);   // positions below the ones computed read as 0 in the next level
        [level, lastLevel] = [lastLevel, level];
      }
      if (bestLocation >= 0) for (let k = bestLocation, end = Math.min(textLen - 1, bestLocation + patLen - 1 + bestErrors); k <= end; k++) if (table[data[ts + k]]) mask[k] = 1;
      found.isMatch = bestLocation >= 0;
      found.score = Math.max(0.001, finalScore);
      if (computeMatches) {
        found.ranges.length = 0;
        for (let i = 0, from = -1; i <= textLen; i++) {
          if (i < textLen && mask[i]) { if (from < 0) from = i; } else if (from >= 0) { if (i - from >= minLength) found.ranges.push([from, i - 1]); from = -1; }
        }
        if (!found.ranges.length) found.isMatch = false;
      }
      return found;
    },
  };
}

// The first position at or after `from` where `pattern` occurs in the text of a string, or -1.
function findFrom(data, ts, textLen, pattern, from) {
  for (let i = from; i + pattern.length <= textLen; i++) {
    let k = 0;
    while (k < pattern.length && data[ts + i + k] === pattern.charCodeAt(k)) k++;
    if (k === pattern.length) return i;
  }
  return -1;
}

// `locate(pattern, threshold, chunkStart, signed)`: replaces the scores in `out` (the scan's, -1 for no match) of the strings that matched with the located
// ones. A non-match becomes -1, or with `signed` minus the score Fuse reports for it (a chunk of a long pattern counts that score).
export function locateInPlace(corpus, config, out) {
  const searcher = createLocated(corpus, config);
  return (pattern, threshold, chunkStart, signed) => {
    searcher.prep(pattern, threshold);
    for (let s = 0; s < corpus.n; s++) {
      if (out[s] < 0) continue;
      const { isMatch, score } = searcher.search(s, chunkStart);
      out[s] = isMatch ? score : signed ? -score : -1;
    }
  };
}

// The range finder of createMatcher (see createRangeFinder in matches.mjs).
export function locatedRanges(corpus, config) {
  const searcher = createLocated(corpus, config);
  return {
    prep: (pattern, _kmax, _rule, threshold) => searcher.prep(pattern, threshold),
    ranges(s, _patLen, start) {
      const { isMatch, ranges } = searcher.search(s, start, true);
      return isMatch ? ranges.map(range => range.slice()) : null;
    },
  };
}
