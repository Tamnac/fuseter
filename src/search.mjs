import { kmaxFor } from "./kernel-js.mjs";
import { weightRule } from "./typing.mjs";

const MAX_BITS = 32;

// Fuse splits patterns longer than 32 characters into 32-character chunks; the last chunk overlaps the previous one.
function chunksOf(pattern) {
  if (pattern.length <= MAX_BITS) return [pattern];
  const chunks = [], remainder = pattern.length % MAX_BITS, end = pattern.length - remainder;
  for (let i = 0; i < end; i += MAX_BITS) chunks.push(pattern.substr(i, MAX_BITS));
  if (remainder) chunks.push(pattern.substr(pattern.length - MAX_BITS));
  return chunks;
}

export function createSearcher(index, scanner, { threshold: defaultThreshold, ignoreFieldNorm, includeScore, normalize, typing }) {
  const { docs, K, nDocs, weights, norms, present, keyless, corpus } = index, { data, offs } = corpus;
  const exactScore = keyless ? 0 : Number.EPSILON;
  const docScore = new Float64Array(nDocs), hitIds = new Int32Array(nDocs);
  let merged = null, matched = null;   // chunked patterns only
  const timings = { scan: 0, combine: 0, format: 0 };

  const equalsPattern = (s, q) => {
    for (let i = 0, p = offs[s]; i < q.length; i++, p++) if (data[p] !== q.charCodeAt(i)) return false;
    return true;
  };

  // Chunk scores are summed per string like Fuse does (a chunk without a match counts 1); -1 marks strings no chunk matched.
  function scanChunks(chunks, kmax) {
    merged ??= new Float64Array(corpus.n); matched ??= new Uint8Array(corpus.n);
    merged.fill(0); matched.fill(0);
    for (const chunk of chunks) {
      scanner.prep(chunk);
      const out = scanner.scan(MAX_BITS, kmax);
      for (let s = 0; s < corpus.n; s++) {
        const v = out[s];
        if (v < 0) merged[s] += 1; else { merged[s] += v; matched[s] = 1; }
      }
    }
    for (let s = 0; s < corpus.n; s++) merged[s] = matched[s] ? merged[s] / chunks.length : -1;
    return merged;
  }

  // Scores every document that matched in at least one slot and returns the hit count; ids/scores land in hitIds/docScore.
  function combine(scores, q) {
    const patLen = q.length;
    let m = 0;
    for (let d = 0; d < nDocs; d++) {
      let total = 1, any = false;
      for (let k = 0; k < K; k++) {
        const s = d * K + k;
        let v = scores[s];
        if (v < 0 || !present[s]) continue;
        if (offs[s + 1] - offs[s] === patLen && equalsPattern(s, q)) v = 0;
        any = true;
        total *= Math.pow(v === 0 ? exactScore : v, weights[k] * (ignoreFieldNorm ? 1 : norms[s]));
      }
      if (any) { docScore[d] = total; hitIds[m++] = d; }
    }
    return m;
  }

  // Ordered by (score, document index); with a cap only the best `cap` are kept, by insertion.
  function order(m, cap) {
    if (cap > 0 && m > cap) {
      const top = new Int32Array(cap); let cnt = 0;
      for (let i = 0; i < m; i++) {
        const d = hitIds[i], sd = docScore[d];
        if (cnt === cap) { if (!(sd < docScore[top[cnt - 1]])) continue; cnt--; }
        let j = cnt;
        while (j > 0 && docScore[top[j - 1]] > sd) { top[j] = top[j - 1]; j--; }
        top[j] = d; cnt++;
      }
      return top.subarray(0, cnt);
    }
    const all = hitIds.subarray(0, m);
    all.sort((a, b) => (docScore[a] - docScore[b]) || (a - b));
    return all;
  }

  const result = includeScore
    ? (d, score) => ({ item: docs[d], refIndex: d, score })
    : d => ({ item: docs[d], refIndex: d });

  function search(query, { limit, threshold = defaultThreshold } = {}) {
    if (typeof query !== "string") throw new TypeError("fuseter: the query must be a string");
    if (!query.trim()) {
      const all = docs.map((item, refIndex) => ({ item, refIndex }));
      return typeof limit === "number" && limit > -1 ? all.slice(0, limit) : all;
    }
    const cap = typeof limit === "number" && limit > 0 ? Math.ceil(limit) : limit === 0 ? 0 : -1;
    const q = normalize(query);
    if (cap === 0 || q.length === 0) return [];
    const chunks = chunksOf(q);
    // The weighted rule only applies to single-chunk patterns: chunks after the first have no first letter.
    const rule = typing.firstLetter && chunks.length === 1 ? weightRule(q, typing.firstLetter) : null;
    const denom = rule?.denom ?? Math.min(q.length, MAX_BITS);
    const kmax = kmaxFor(Math.min(q.length, MAX_BITS), threshold, denom);
    let t0 = performance.now(), t1, t2, res;

    if (chunks.length === 1 && scanner.combineSort) {
      scanner.prep(q); scanner.scan(q.length, kmax, rule);
      t1 = performance.now();
      const { hits, ids, scores } = scanner.combineSort(q.length, denom, kmax, cap > 0 && cap < nDocs ? cap : 0);
      const count = cap > 0 && hits > cap ? cap : hits;
      t2 = performance.now();
      res = new Array(count);
      for (let i = 0; i < count; i++) res[i] = result(ids[i], scores[i]);
    } else {
      let scores;
      if (chunks.length === 1) { scanner.prep(q); scores = scanner.scan(q.length, kmax, rule); }
      else scores = scanChunks(chunks, kmax);
      t1 = performance.now();
      const sorted = order(combine(scores, q), cap);
      t2 = performance.now();
      res = new Array(sorted.length);
      for (let i = 0; i < sorted.length; i++) res[i] = result(sorted[i], docScore[sorted[i]]);
    }
    timings.scan = t1 - t0; timings.combine = t2 - t1; timings.format = performance.now() - t2;
    return res;
  }
  return { search, timings };
}
