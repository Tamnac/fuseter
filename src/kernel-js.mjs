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

// One-pass multi-level Bitap over every string: out[s] = best error level / patLen (clamped to >= 0.001), or -1 without a match.
function scan(corpus, patLen, T, kmax, out, S) {
  const { data, offs, n } = corpus;
  const mask = 1 << (patLen - 1), need = patLen - kmax;
  for (let s = 0; s < n; s++) {
    const ts = offs[s], textLen = offs[s + 1] - ts;
    if (textLen < need) { out[s] = -1; continue; }
    let K = kmax, best = -1;
    for (let i = 0; i <= K; i++) S[i] = (1 << i) - 1;
    outer: for (let j = textLen; j >= 1; j--) {
      const cm = T[data[ts + j - 1]];
      let oldL = 0, newL = 0;
      for (let i = 0; i <= K; i++) {
        const oi = S[i];
        let nv = ((oi << 1) | 1) & cm;
        if (i !== 0) nv |= ((oldL | newL) << 1) | 1 | oldL;
        S[i] = nv;
        if (nv & mask) { best = i; K = i - 1; if (K < 0) break outer; break; }
        oldL = oi; newL = nv;
      }
    }
    out[s] = best >= 0 ? Math.max(best / patLen, 0.001) : -1;
  }
}

// Same scan with adjacent transpositions as one error (optimal string alignment distance, Hyyro's bit-parallel extension).
// Pattern bit p is set in `swap` when the pattern characters at p-1 and p are the last two text characters read, in swapped order;
// level i then also takes level i-1 from two steps back, shifted by two (bit 1 is the empty prefix, which always matches).
function scanTransposed(corpus, patLen, T, kmax, out, S, S2) {
  const { data, offs, n } = corpus;
  const mask = 1 << (patLen - 1), need = patLen - kmax;
  for (let s = 0; s < n; s++) {
    const ts = offs[s], textLen = offs[s + 1] - ts;
    if (textLen < need) { out[s] = -1; continue; }
    let K = kmax, best = -1, previous = 0;
    for (let i = 0; i <= K; i++) S[i] = S2[i] = (1 << i) - 1;
    outer: for (let j = textLen; j >= 1; j--) {
      const cm = T[data[ts + j - 1]], swap = previous & (cm << 1);
      previous = cm;
      let oldL = 0, newL = 0, older = 0;
      for (let i = 0; i <= K; i++) {
        const oi = S[i], oi2 = S2[i];
        let nv = ((oi << 1) | 1) & cm;
        if (i !== 0) nv |= ((oldL | newL) << 1) | 1 | oldL | (((older << 2) | 2) & swap);
        S2[i] = oi; S[i] = nv;
        if (nv & mask) { best = i; K = i - 1; if (K < 0) break outer; break; }
        older = oi2; oldL = oi; newL = nv;
      }
    }
    out[s] = best >= 0 ? Math.max(best / patLen, 0.001) : -1;
  }
}

// Weighted pattern positions (typing.firstLetter.weighted): editing a pattern character at a word start of the query (or only the first one) (rule.mask, one bit
// per position like the char table) costs 2 instead of 1, and it only matches for free on a word-initial text character. An exact match
// on any other text character costs rule.midWord (1 or 2). The score is errors / rule.denom (patLen + number of weighted positions).
// Weighted positions are reached through level i-2 instead of i-1 when they are not an exact free match, and a deletion run at the
// start of the match is priced per character (`init`). A transposition keeps its cost of 1, but one whose first character is a weighted
// position has to start on a word-initial text character.
const init = new Int32Array(64);
function scanWeighted(corpus, patLen, T, kmax, rule, transposition, out, S, S2) {
  const { data, offs, n, starts } = corpus;
  const { mask: W, midWord, denom } = rule, notW = ~W, top = 1 << (patLen - 1), need = patLen - kmax;
  init.fill(0, 0, kmax + 1);
  for (let b = 0, cost = 0; b < patLen && (cost += 1 + ((W >>> b) & 1)) <= kmax; b++) for (let i = cost; i <= kmax; i++) init[i] |= 1 << b;
  for (let s = 0; s < n; s++) {
    const ts = offs[s], textLen = offs[s + 1] - ts;
    if (textLen < need) { out[s] = -1; continue; }
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
  return {
    out,
    prep(pattern) { fillCharTable(T, pattern, previous); },
    scan(patLen, kmax, rule = null) {
      if (rule) scanWeighted(corpus, patLen, T, kmax, rule, transposition, out, S, S2);
      else if (transposition) scanTransposed(corpus, patLen, T, kmax, out, S, S2); else scan(corpus, patLen, T, kmax, out, S);
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
