const DEFAULT_TOKEN = /[\p{L}\p{M}\p{N}_]+/gu;

export const TOKEN_MATCH = ["any", "all"];

// `tokenize` is a global RegExp (its matches are the tokens) or a function returning string[]; the default keeps runs of letters, marks, digits and `_`.
export function checkTokenize(tokenize) {
  if (tokenize == null || typeof tokenize === "function") return;
  if (!(tokenize instanceof RegExp)) throw new TypeError("fuseter: 'tokenize' must be a RegExp or a function");
  if (!tokenize.global) throw new TypeError("fuseter: the 'tokenize' RegExp must have the global flag");
}

// Fuse's token analyzer: the text is normalised like the indexed strings, then split into tokens.
export function createTokenizer(tokenize, normalize) {
  const split = typeof tokenize === "function" ? tokenize : text => text.match(tokenize ?? DEFAULT_TOKEN) || [];
  return text => {
    const tokens = split(normalize(text));
    if (!Array.isArray(tokens) || tokens.some(token => typeof token !== "string")) throw new TypeError("fuseter: 'tokenize' must return an array of strings");
    return tokens;
  };
}

// Document frequencies over the indexed strings (Fuse's inverted index): fieldCount is the number of strings with at least one token,
// df.get(term) the number of them that contain the term.
export function documentFrequencies({ nStr, present, values }, tokenize) {
  const df = new Map();
  let fieldCount = 0;
  for (let s = 0; s < nStr; s++) {
    if (!present[s]) continue;
    const tokens = tokenize(values[s]);
    if (!tokens.length) continue;
    fieldCount++;
    for (const term of new Set(tokens)) df.set(term, (df.get(term) || 0) + 1);
  }
  return { df, fieldCount };
}

export function idfOf({ df, fieldCount }, term) {
  const docFreq = df.get(term) || 0;
  return Math.log(1 + (fieldCount - docFreq + 0.5) / (docFreq + 0.5));
}

// Per-string token scores, accumulated term by term: add(scores, idf) for each term in query order, then finish(). The wasm backends have the same
// interface with the loops in zig/token_core.zig; the operations and their order are the same, so the scores are bit-identical.
// `scores` are the term's scores per string (-1: no match), as scanners produce them.
export function jsTokenAccumulator({ nStr, K, nDocs }) {
  const acc = new Float64Array(nStr), hit = new Uint8Array(nStr), covered = new Uint32Array(nDocs);
  return {
    begin() { acc.fill(0); hit.fill(0); covered.fill(0); },
    add(scores, idf) {
      for (let s = 0; s < nStr; s++) {
        const v = scores[s];
        if (v >= 0) { acc[s] += idf * (1 - v); hit[s] = 1; }
      }
    },
    // For tokenMatch "all": the documents with a string the term matched (add must have been called with the same scores).
    cover(scores) {
      for (let d = 0; d < nDocs; d++) {
        for (let k = 0; k < K; k++) if (scores[d * K + k] >= 0) { covered[d]++; break; }
      }
    },
    // max(0.001, 1 - sum(idf * (1 - score)) / sum(idf)) where a term matched, else -1; with `terms` > 0, documents that do not cover every term are dropped.
    finish(maxScore, terms) {
      for (let s = 0; s < nStr; s++) {
        const complete = terms === 0 || covered[Math.floor(s / K)] === terms;
        acc[s] = hit[s] && complete ? Math.max(0.001, maxScore > 0 ? 1 - acc[s] / maxScore : 0) : -1;
      }
      return acc;
    },
  };
}
