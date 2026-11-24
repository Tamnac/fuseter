// Largest number of errors a pattern of this length may have at this threshold (Fuse: error level i is tried while (i + 1) / patLen <= threshold).
// `denom` is what the error count is divided by to get the score (patLen, or patLen + 1 when the first character counts double).
export function kmaxFor(patLen, threshold, denom = patLen) {
  let k = 0;
  while (k + 1 < patLen && (k + 1) / denom <= threshold) k++;
  return k;
}

// Builds the per-query character table: bit (patLen - 1 - i) is set for the characters of pattern position i.
export function fillCharTable(table, pattern, previous) {
  for (const c of previous) table[c] = 0;
  previous.length = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charCodeAt(i);
    table[c] |= 1 << (pattern.length - i - 1);
    previous.push(c);
  }
}

// Per string, which of 32 character buckets (char code & 31) occur at least once, twice and three times. A match with k errors leaves at most k pattern
// characters unmatched, so a string that lacks more characters than that (counted per bucket up to three, see `missing`) cannot match.
export function bucketMasks(corpus) {
  if (corpus.buckets) return corpus.buckets;
  const { data, offs, n } = corpus;
  const once = new Int32Array(n), twice = new Int32Array(n), thrice = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    let a = 0, b = 0, c = 0;
    for (let p = offs[s], end = offs[s + 1]; p < end; p++) {
      const bit = 1 << (data[p] & 31);
      c |= b & bit; b |= a & bit; a |= bit;
    }
    once[s] = a; twice[s] = b; thrice[s] = c;
  }
  return corpus.buckets = { once, twice, thrice };
}

export function patternBuckets(pattern) {
  let once = 0, twice = 0, thrice = 0;
  for (let i = 0; i < pattern.length; i++) {
    const bit = 1 << (pattern.charCodeAt(i) & 31);
    thrice |= twice & bit; twice |= once & bit; once |= bit;
  }
  return { once, twice, thrice };
}

// popcount(a) + popcount(b) + popcount(c) with one multiplication (a byte of the sum is at most 24).
function missing(a, b, c) {
  a -= (a >>> 1) & 0x55555555; b -= (b >>> 1) & 0x55555555; c -= (c >>> 1) & 0x55555555;
  a = (a & 0x33333333) + ((a >>> 2) & 0x33333333) + (b & 0x33333333) + ((b >>> 2) & 0x33333333);
  c = (c & 0x33333333) + ((c >>> 2) & 0x33333333);
  a = (a & 0x0f0f0f0f) + ((a >>> 4) & 0x0f0f0f0f) + (c & 0x0f0f0f0f) + ((c >>> 4) & 0x0f0f0f0f);
  return Math.imul(a, 0x01010101) >>> 24;
}

// Myers' bit-vector algorithm: the lowest edit distance of the pattern to any substring of the text data[ts, end), or kmax + 1 when it exceeds kmax.
// pv and mv hold the +1 and -1 vertical differences of the pattern column; `errors` follows the last row.
// The distance drops by at most 1 per text character, so the scan stops once the remaining text cannot get below the best found.
function distance(data, ts, end, T, patLen, kmax) {
  const top = patLen - 1;
  let pv = -1, mv = 0, errors = patLen, best = kmax + 1, stop = ts - best;
  for (let p = end - 1; p >= stop + errors; p--) {
    const eq = T[data[p]];
    const xv = eq | mv, xh = (((eq & pv) + pv) ^ pv) | eq;
    let ph = mv | ~(xh | pv);
    const mh = pv & xh;
    errors += ((ph >>> top) & 1) - ((mh >>> top) & 1);
    ph <<= 1;
    pv = (mh << 1) | ~(xv | ph);
    mv = ph & xv;
    if (errors < best) {
      if ((best = errors) === 0) break;
      stop = ts - best;
    }
  }
  return best;
}

// Same with adjacent transpositions as one error (optimal string alignment distance, Hyyro's bit-parallel extension of Myers' algorithm).
// d0 marks the pattern positions where the last text character continues a match along the diagonal; `previous` is the table entry of the text character before it.
// A transposition at position i needs the characters at i-1 and i to match the last two text characters in swapped order, and no diagonal match at i-1 one step earlier.
function distanceTransposed(data, ts, end, T, patLen, kmax) {
  const top = patLen - 1;
  let pv = -1, mv = 0, d0 = 0, previous = 0, errors = patLen, best = kmax + 1, stop = ts - best;
  for (let p = end - 1; p >= stop + errors; p--) {
    const eq = T[data[p]];
    d0 = (((~d0 & eq) << 1) & previous) | (((eq & pv) + pv) ^ pv) | eq | mv;
    previous = eq;
    let ph = mv | ~(d0 | pv);
    const mh = pv & d0;
    errors += ((ph >>> top) & 1) - ((mh >>> top) & 1);
    ph <<= 1;
    pv = (mh << 1) | ~(d0 | ph);
    mv = ph & d0;
    if (errors < best) {
      if ((best = errors) === 0) break;
      stop = ts - best;
    }
  }
  return best;
}

// out[s] = lowest edit distance / patLen (clamped to >= 0.001), or -1 when it exceeds kmax, for the strings ids[0..count) (all of them without ids).
function scan(corpus, patLen, T, kmax, transposition, out, ids, count, buckets) {
  const { data, offs } = corpus;
  const { once, twice, thrice } = bucketMasks(corpus);
  const need = patLen - kmax, measure = transposition ? distanceTransposed : distance;
  for (let r = 0; r < count; r++) {
    const s = ids ? ids[r] : r;
    const ts = offs[s], end = offs[s + 1];
    if (end - ts < need || missing(~once[s] & buckets.once, ~twice[s] & buckets.twice, ~thrice[s] & buckets.thrice) > kmax) { out[s] = -1; continue; }
    const best = measure(data, ts, end, T, patLen, kmax);
    out[s] = best <= kmax ? Math.max(best / patLen, 0.001) : -1;
  }
}

// Weighted pattern positions (typing.firstLetter.weighted): editing a pattern character at a word start of the query (or only the first one) (rule.mask, one bit
// per position like the char table) costs 2 instead of 1, and it only matches for free on a word-initial text character. An exact match
// on any other text character costs rule.midWord (1 or 2). The score is errors / rule.denom (patLen + number of weighted positions).
// Weighted positions are reached through level i-2 instead of i-1 when they are not an exact free match, and a deletion run at the
// start of the match is priced per character (`init`). A transposition keeps its cost of 1, but one whose first character is a weighted
// position has to start on a word-initial text character.
// No operation costs less than in the unweighted scan, so a string whose unweighted distance exceeds kmax cannot match and is skipped before the slower scan.
const init = new Int32Array(64);
function scanWeighted(corpus, patLen, T, kmax, rule, transposition, out, S, S2, buckets) {
  const { data, offs, n, starts } = corpus;
  const { once, twice, thrice } = bucketMasks(corpus), measure = transposition ? distanceTransposed : distance;
  const { mask: W, midWord, denom } = rule, notW = ~W, top = 1 << (patLen - 1), need = patLen - kmax;
  init.fill(0, 0, kmax + 1);
  for (let b = 0, cost = 0; b < patLen && (cost += 1 + ((W >>> b) & 1)) <= kmax; b++) for (let i = cost; i <= kmax; i++) init[i] |= 1 << b;
  for (let s = 0; s < n; s++) {
    const ts = offs[s], textLen = offs[s + 1] - ts;
    if (textLen < need || missing(~once[s] & buckets.once, ~twice[s] & buckets.twice, ~thrice[s] & buckets.thrice) > kmax || measure(data, ts, ts + textLen, T, patLen, kmax) > kmax) { out[s] = -1; continue; }
    let K = kmax, best = -1, previous = 0;
    for (let i = 0; i <= K; i++) S[i] = S2[i] = init[i];
    outer: for (let j = textLen; j >= 1; j--) {
      const raw = T[data[ts + j - 1]], atWordStart = starts[ts + j - 1] === 1;
      const cm = atWordStart ? raw : raw & notW;
      const c1 = midWord === 1 ? notW | (raw & W) : notW;   // pattern bits that may be reached by a substitution or insertion from level i-1
      const swap = transposition ? previous & (raw << 1) & (atWordStart ? -1 : notW) : 0;
      previous = raw;
      let oldL = 0, newL = 0, older = 0, oldL2 = 0, newL2 = 0;
      for (let i = 0; i <= K; i++) {
        const oi = S[i], oi2 = S2[i];
        let nv = ((oi << 1) | 1) & cm;
        if (i !== 0) {
          nv |= ((oldL << 1) | 1) & c1 | (newL << 1) & notW | oldL | (((older << 2) | 2) & swap);
          if (i >= 2) nv |= (((oldL2 | newL2) << 1) | 1) & W;
        }
        S2[i] = oi; S[i] = nv;
        if (nv & top) { best = i; K = i - 1; if (K < 0) break outer; break; }
        older = oi2; oldL2 = oldL; newL2 = newL; oldL = oi; newL = nv;
      }
    }
    out[s] = best >= 0 ? Math.max(best / denom, 0.001) : -1;
  }
}

// `scan(patLen, kmax, rule)`: a rule ({ mask, midWord, denom }, see scanWeighted) switches to word-start scoring, which needs corpus.starts.
export function jsScanner(corpus, { transposition = false } = {}) {
  const T = new Int32Array(65536), S = new Int32Array(64), S2 = new Int32Array(64), out = new Float64Array(corpus.n), previous = [];
  let buckets;
  return {
    out,
    prep(pattern) { fillCharTable(T, pattern, previous); buckets = patternBuckets(pattern); },
    scan(patLen, kmax, rule = null) {
      if (rule) scanWeighted(corpus, patLen, T, kmax, rule, transposition, out, S, S2, buckets);
      else scan(corpus, patLen, T, kmax, transposition, out, null, corpus.n, buckets);
      return out;
    },
    // Only the first `count` strings of `ids` are scored (no rule); the other entries of the result are stale.
    scanSubset(patLen, kmax, ids, count) {
      scan(corpus, patLen, T, kmax, transposition, out, ids, count, buckets);
      return out;
    },
  };
}

// Where the matches of a pattern lie, for includeMatches. It runs the recurrences of scanWeighted (a plain or transposed scan is the weighted one with
// nothing weighted) without dropping levels, so it can report what Fuse reports: the start of a match at the best level, plus every start
// of an error-free match. `find(s, expected)` returns { level, start, exact } (a reused object; `exact` lists the error-free starts, last to first) or
// null when no level up to kmax matches. `table` is the char table of the prepared pattern.
// Fuse scans each level from the end of the text towards `expected` (the chunk's start in the pattern, 0 for patterns of up to 32 characters) and
// stops at the first match at or before it; after a match at a start p beyond it, only starts from 2 * expected - p on are still considered. `start` is
// the last match accepted that way, which is the lowest start only when expected is 0.
export function createLocator(corpus, transposition) {
  const { data, offs, starts } = corpus;
  const table = new Int32Array(65536), S = new Int32Array(64), S2 = new Int32Array(64), init = new Int32Array(64), lowest = new Int32Array(64), floor = new Int32Array(64);
  const previous = [], found = { level: -1, start: -1, exact: [] };
  let patLen = 0, kmax = 0, W = 0, midWord = 1;

  function prep(pattern, maxErrors, rule) {
    fillCharTable(table, pattern, previous);
    patLen = pattern.length; kmax = maxErrors; W = rule?.mask ?? 0; midWord = rule?.midWord ?? 1;
    init.fill(0, 0, kmax + 1);
    for (let b = 0, cost = 0; b < patLen && (cost += 1 + ((W >>> b) & 1)) <= kmax; b++) for (let i = cost; i <= kmax; i++) init[i] |= 1 << b;
  }

  function find(s, expected) {
    const ts = offs[s], textLen = offs[s + 1] - ts, notW = ~W, top = 1 << (patLen - 1);
    if (textLen < patLen - kmax) return null;
    lowest.fill(-1, 0, kmax + 1); floor.fill(1, 0, kmax + 1);
    found.exact.length = 0;
    for (let i = 0; i <= kmax; i++) S[i] = S2[i] = init[i];
    let last = 0;
    for (let j = textLen; j >= 1; j--) {
      const raw = table[data[ts + j - 1]], atWordStart = Boolean(starts) && starts[ts + j - 1] === 1;
      const cm = atWordStart ? raw : raw & notW;
      const c1 = midWord === 1 ? notW | (raw & W) : notW;
      const swap = transposition ? last & (raw << 1) & (atWordStart ? -1 : notW) : 0;
      last = raw;
      let oldL = 0, newL = 0, older = 0, oldL2 = 0, newL2 = 0;
      for (let i = 0; i <= kmax; i++) {
        const oi = S[i], oi2 = S2[i];
        let nv = ((oi << 1) | 1) & cm;
        if (i !== 0) {
          nv |= ((oldL << 1) | 1) & c1 | (newL << 1) & notW | oldL | (((older << 2) | 2) & swap);
          if (i >= 2) nv |= (((oldL2 | newL2) << 1) | 1) & W;
        }
        S2[i] = oi; S[i] = nv;
        if (nv & top) {
          if (i === 0) found.exact.push(j - 1);
          if (j >= floor[i]) { lowest[i] = j - 1; floor[i] = j - 1 <= expected ? textLen + 1 : Math.max(1, 2 * expected - j + 1); }
        }
        older = oi2; oldL2 = oldL; newL2 = newL; oldL = oi; newL = nv;
      }
    }
    for (let i = 0; i <= kmax; i++) if (lowest[i] >= 0) { found.level = i; found.start = lowest[i]; return found; }
    return null;
  }

  return { table, prep, find };
}
