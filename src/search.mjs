import { kmaxFor } from "./kernel-js.mjs";
import { subRecord } from "./fuse-index.mjs";
import { createMatcher, createRangeFinder, createSlotReader, equalsPattern, groupByLength } from "./matches.mjs";
import { createTokenizer, documentFrequencies, idfOf } from "./tokens.mjs";
import { weightRule } from "./typing.mjs";

const MAX_BITS = 32;

// Fuse splits patterns longer than 32 characters into 32-character chunks; the last chunk overlaps the previous one.
// `start` is where the chunk begins in the pattern (Fuse searches a chunk with that expected location).
function chunksOf(pattern) {
  if (pattern.length <= MAX_BITS) return [{ pattern, start: 0 }];
  const chunks = [], remainder = pattern.length % MAX_BITS, end = pattern.length - remainder;
  for (let i = 0; i < end; i += MAX_BITS) chunks.push({ pattern: pattern.substr(i, MAX_BITS), start: i });
  if (remainder) chunks.push({ pattern: pattern.substr(pattern.length - MAX_BITS), start: pattern.length - MAX_BITS });
  return chunks;
}

// Fuse's default sortFn (the order of equal scores is by document).
export const defaultSortFn = (a, b) => a.score === b.score ? (a.idx < b.idx ? -1 : 1) : a.score < b.score ? -1 : 1;

const fuseMatch = ({ indices, value, keyDef, refIndex }) => {
  const match = { indices, value };
  if (keyDef) match.key = keyDef.id;
  if (refIndex !== undefined) match.refIndex = refIndex;
  return match;
};

export function createSearcher(index, scanner, { threshold: defaultThreshold, ignoreFieldNorm, includeScore, includeMatches, indicesIn, highlighting, normalize, typing, shouldSort, sortFn: givenSortFn, minMatchCharLength: minLength, useTokenSearch, tokenize, tokenMatch }) {
  const { docs, K, nDocs, weights, norms, present, keyless, keys, corpus } = index;
  const exactScore = keyless ? 0 : Number.EPSILON;
  const sortFn = shouldSort && givenSortFn !== defaultSortFn ? givenSortFn : null;
  const ranked = shouldSort && !sortFn && scanner.sortHits;   // the scanner sorts the hits by position
  const docScore = new Float64Array(nDocs), hitIds = ranked ? scanner.hitIds : new Int32Array(nDocs), hitScores = ranked ? scanner.hitScores : null;
  let merged = null, matched = null;   // chunked patterns only
  let byLength = null;
  let frequencies = null;   // token search only
  const tokenizer = useTokenSearch ? createTokenizer(tokenize, normalize) : null;
  const slotsOf = createSlotReader(index), transposition = typing.transposition;
  const matcher = includeMatches ? createMatcher(index, { slotsOf, transposition, minLength, normalize, original: indicesIn === "original", highlighting }) : null;
  const finder = minLength > 1 ? createRangeFinder(corpus, { transposition, minLength }) : null;
  const keyObjects = sortFn ? new Map(keys.map((def, position) => [def, { position, key: { path: def.path, id: def.id, weight: weights[def.base], src: def.src, getFn: def.getFn } }])) : null;
  const simpleRanking = shouldSort && !sortFn && !finder;   // what the in-wasm combine step can do
  const timings = { scan: 0, combine: 0, format: 0 };

  // With minMatchCharLength, a string whose match is only in fragments shorter than that is no match (except when it equals the query, see settle).
  const fragmentsTooShort = (s, chunk, q) => !equalsPattern(corpus, s, q) && !finder.ranges(s, chunk.pattern.length, chunk.start)?.length;

  // Chunk scores are summed per string like Fuse does (a chunk without a match counts 1, one that is dropped for its fragments counts its score);
  // -1 marks strings no chunk matched.
  function scanChunks(chunks, kmax, q) {
    merged ??= new Float64Array(corpus.n); matched ??= new Uint8Array(corpus.n);
    merged.fill(0); matched.fill(0);
    for (const chunk of chunks) {
      scanner.prep(chunk.pattern);
      const out = scanner.scan(MAX_BITS, kmax);
      finder?.prep(chunk.pattern, kmax, null);
      for (let s = 0; s < corpus.n; s++) {
        const v = out[s];
        if (v < 0) merged[s] += 1; else { merged[s] += v; if (!finder || !fragmentsTooShort(s, chunk, q)) matched[s] = 1; }
      }
    }
    for (let s = 0; s < corpus.n; s++) merged[s] = matched[s] ? merged[s] / chunks.length : -1;
    return merged;
  }

  // The pattern as it is searched: its chunks, the typing rule and the largest error level that stays within the threshold.
  function planFor(q, threshold) {
    const chunks = chunksOf(q);
    // The weighted rule only applies to single-chunk patterns: chunks after the first have no first letter.
    const rule = typing.firstLetter && chunks.length === 1 ? weightRule(q, typing.firstLetter) : null;
    const denom = rule?.denom ?? Math.min(q.length, MAX_BITS);
    return { q, chunks, rule, denom, kmax: kmaxFor(Math.min(q.length, MAX_BITS), threshold, denom) };
  }

  // Applies minMatchCharLength to the scores of a single pattern (chunked ones are handled in scanChunks).
  function dropShortMatches(scores, pattern, q, kmax, rule) {
    finder.prep(pattern, kmax, rule);
    const chunk = { pattern, start: 0 };
    for (let s = 0; s < corpus.n; s++) if (scores[s] >= 0 && fragmentsTooShort(s, chunk, q)) scores[s] = -1;
  }

  // A string equal to the query scores 0 (and matches whatever its length, unless it is shorter than minMatchCharLength).
  function settleExact(scores, q) {
    byLength ??= groupByLength(corpus);
    if (q.length >= byLength.start.length - 1) return;
    const { start, order } = byLength;
    for (let i = start[q.length]; i < start[q.length + 1]; i++) {
      const s = order[i];
      if (scores[s] >= 0 && equalsPattern(corpus, s, q)) scores[s] = q.length >= minLength ? 0 : -1;
    }
  }

  // The score of every string for one pattern (-1: no match); the array is reused by the next call.
  function patternScores({ q, chunks, kmax, rule }) {
    let scores;
    if (chunks.length > 1) scores = scanChunks(chunks, kmax, q);
    else {
      scanner.prep(q); scores = scanner.scan(q.length, kmax, rule);
      if (finder) dropShortMatches(scores, q, q, kmax, rule);
    }
    settleExact(scores, q);
    return scores;
  }

  // One plan per term of the query, with the idf weight Fuse gives the term (rarer terms count more).
  function tokenPlans(query, threshold) {
    frequencies ??= documentFrequencies(index, tokenizer);
    return tokenizer(query).map(term => ({ ...planFor(normalize(term), threshold), idf: idfOf(frequencies, term) }));
  }

  // Fuse's token score of every string: the idf-weighted mean of the terms' scores, 1 - sum(idf * (1 - score)) / sum(idf), over the terms that match
  // (-1 when none does). With tokenMatch "all", the documents whose strings together miss a term are dropped.
  function tokenScores(plans) {
    const requireAll = tokenMatch === "all", { tokens } = scanner;
    tokens.begin();
    let maxScore = 0;
    for (const plan of plans) {
      maxScore += plan.idf;
      if (!plan.q.length) continue;
      const scores = patternScores(plan);
      if (scores !== scanner.out) scanner.out.set(scores);
      tokens.add(scanner.out, plan.idf);
      if (requireAll) tokens.cover(scanner.out);
    }
    return tokens.finish(maxScore, requireAll ? plans.length : 0);
  }

  // Scores every document that matched in at least one slot and returns the hit count; ids/scores land in hitIds/docScore.
  function combine(scores) {
    let m = 0;
    for (let d = 0; d < nDocs; d++) {
      let total = 1, any = false;
      for (let k = 0; k < K; k++) {
        const s = d * K + k;
        const v = scores[s];
        if (v < 0 || !present[s]) continue;
        any = true;
        total *= Math.pow(v === 0 ? exactScore : v, weights[k] * (ignoreFieldNorm ? 1 : norms[s]));
      }
      if (any) { docScore[d] = total; if (hitScores) hitScores[m] = total; hitIds[m++] = d; }
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

  // Fuse's index record of a document, which is what its sortFn gets as `item`: { [key position]: { v, n } or, for array values, [{ v, i, n }] }.
  function indexRecord(d, slots) {
    if (keyless) return slots[0].value;
    const entries = new Map(), record = {};
    for (const { s, keyDef, value, refIndex } of slots) {
      const k = keyObjects.get(keyDef).position;
      if (!entries.has(k)) entries.set(k, []);
      entries.get(k).push({ v: value, i: refIndex, n: norms[s] });
    }
    for (const [k, list] of entries) record[k] = subRecord(list);
    return record;
  }

  // With a sortFn, the hits are sorted as Fuse's result records (the order of ties is by document), then cut to the limit.
  function sortCustom(m, scores, cap, plans) {
    const ids = Array.from(hitIds.subarray(0, m)), found = matcher?.(ids, plans);
    const results = ids.map((d, i) => {
      const slots = slotsOf(d);
      const matches = slots.filter(slot => scores[slot.s] >= 0).map(({ s, keyDef, value, refIndex }) => {
        const match = { score: scores[s] };
        if (keyDef) match.key = keyObjects.get(keyDef).key;
        match.value = value;
        if (refIndex !== undefined) match.idx = refIndex;
        match.norm = norms[s]; match.indices = found?.[i].find(slot => slot.s === s)?.indices;
        if (keyDef) match.hasInverse = undefined;
        return match;
      });
      return { idx: d, item: indexRecord(d, slots), matches, score: docScore[d] };
    });
    const matchesOf = found && new Map(ids.map((d, i) => [d, found[i].map(fuseMatch)]));
    results.sort((a, b) => sortFn(a, b) || a.idx - b.idx);
    return (cap > 0 ? results.slice(0, cap) : results).map(({ idx, score }) => {
      const out = result(idx, score);
      if (matchesOf) out.matches = matchesOf.get(idx);
      return out;
    });
  }

  function search(query, { limit, threshold = defaultThreshold } = {}) {
    if (typeof query !== "string") throw new TypeError("fuseter: the query must be a string");
    if (!query.trim()) {
      const all = docs.map((item, refIndex) => ({ item, refIndex }));
      return typeof limit === "number" && limit > -1 ? all.slice(0, limit) : all;
    }
    const cap = typeof limit === "number" && limit > 0 ? Math.ceil(limit) : limit === 0 ? 0 : -1;
    if (cap === 0) return [];
    const plans = useTokenSearch ? tokenPlans(query, threshold) : [planFor(normalize(query), threshold)];
    if (useTokenSearch ? !plans.length : !plans[0].q.length) return [];
    const [{ q, chunks, kmax, rule, denom }] = plans;
    let t0 = performance.now(), t1, t2, res;

    let custom = false;
    if (!useTokenSearch && chunks.length === 1 && scanner.combineSort && simpleRanking) {
      scanner.prep(q); scanner.scan(q.length, kmax, rule);
      t1 = performance.now();
      const { hits, ids, scores } = scanner.combineSort(q.length, denom, kmax, cap > 0 && cap < nDocs ? cap : 0);
      const count = cap > 0 && hits > cap ? cap : hits;
      t2 = performance.now();
      res = new Array(count);
      for (let i = 0; i < count; i++) res[i] = result(ids[i], scores[i]);
    } else {
      const scores = useTokenSearch ? tokenScores(plans) : patternScores(plans[0]);
      t1 = performance.now();
      const m = combine(scores);
      if (sortFn) { custom = true; res = sortCustom(m, scores, cap, plans); t2 = t1; }
      else if (ranked) {
        const { ids, scores: keys } = scanner.sortHits(m, cap > 0 && cap < nDocs ? cap : 0);
        const count = cap > 0 && m > cap ? cap : m;
        t2 = performance.now();
        res = new Array(count);
        for (let i = 0; i < count; i++) res[i] = result(ids[i], keys[i]);
      } else {
        const ids = shouldSort ? order(m, cap) : hitIds.subarray(0, typeof limit === "number" && limit > -1 ? Math.min(m, Math.trunc(limit)) : m);
        t2 = performance.now();
        res = new Array(ids.length);
        for (let i = 0; i < ids.length; i++) res[i] = result(ids[i], docScore[ids[i]]);
      }
    }
    if (matcher && !custom) {
      const matches = matcher(res.map(r => r.refIndex), plans);
      for (let i = 0; i < res.length; i++) res[i].matches = matches[i].map(fuseMatch);
    }
    timings.scan = t1 - t0; timings.combine = t2 - t1; timings.format = performance.now() - t2;
    return res;
  }
  return { search, timings };
}
