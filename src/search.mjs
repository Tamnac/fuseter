import { jsDenseState } from "./dense.mjs";
import { DRIVERS, createStringMatchers, isInverse, parseExtended } from "./extended.mjs";
import { jsScanner, kmaxFor } from "./kernel-js.mjs";
import { subRecord } from "./fuse-index.mjs";
import { locateInPlace } from "./located.mjs";
import { evaluateLogical, leavesOf, parseLogical } from "./logical.mjs";
import { createMatcher, createRangeFinder, createSlotReader, equalsPattern, groupByLength } from "./matches.mjs";
import { pluginFor } from "./plugins.mjs";
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

export function createSearcher(index, scanner, { options, threshold: defaultThreshold, ignoreFieldNorm, includeScore, includeMatches, indicesIn, highlighting, normalize, typing, shouldSort, sortFn: givenSortFn, minMatchCharLength: minLength, located, useExtendedSearch, useTokenSearch, tokenize, tokenMatch }) {
  const { docs, K, nDocs, nStr, weights, norms, present, keyless, keys, corpus } = index;
  const exactScore = keyless ? 0 : Number.EPSILON;
  const sortFn = shouldSort && givenSortFn !== defaultSortFn ? givenSortFn : null;
  const ranked = shouldSort && !sortFn && scanner.sortHits;   // the scanner sorts the hits by position
  const docScore = new Float64Array(nDocs), hitIds = ranked ? scanner.hitIds : new Int32Array(nDocs), hitScores = ranked ? scanner.hitScores : null;
  let merged = null, matched = null;   // chunked patterns only
  let byLength = null;
  let frequencies = null;   // token search only
  let extended = null;      // extended search only: the arrays of extendedScores, made on first use
  const tokenizer = useTokenSearch ? createTokenizer(tokenize, normalize) : null;
  const stringMatchers = useExtendedSearch ? createStringMatchers(corpus, scanner.extendedWasm) : null;
  const slotsOf = createSlotReader(index), transposition = typing.transposition;
  const locate = located && locateInPlace(corpus, located, scanner.out);
  const matcher = includeMatches ? createMatcher(index, { slotsOf, transposition, minLength, normalize, original: indicesIn === "original", highlighting, located }) : null;
  const finder = minLength > 1 && !located ? createRangeFinder(corpus, { transposition, minLength }) : null;
  const keyObjects = sortFn ? new Map(keys.map((def, position) => [def, { position, key: { path: def.path, id: def.id, weight: weights[def.base], src: def.src, getFn: def.getFn } }])) : null;
  const simpleRanking = shouldSort && !sortFn && !finder && !located;   // what the in-wasm combine step can do
  const timings = { scan: 0, combine: 0, format: 0 };

  // With minMatchCharLength, a string whose match is only in fragments shorter than that is no match (except when it equals the query, see settle).
  const fragmentsTooShort = (s, chunk, q) => !equalsPattern(corpus, s, q) && !finder.ranges(s, chunk.pattern.length, chunk.start)?.length;

  // Chunk scores are summed per string like Fuse does (a chunk without a match counts 1, one that is dropped for its fragments counts its score);
  // -1 marks strings no chunk matched.
  function scanChunks({ q, chunks, kmax, threshold }) {
    merged ??= new Float64Array(corpus.n); matched ??= new Uint8Array(corpus.n);
    merged.fill(0); matched.fill(0);
    for (const chunk of chunks) {
      scanner.prep(chunk.pattern);
      const out = scanner.scan(MAX_BITS, kmax);
      finder?.prep(chunk.pattern, kmax, null);
      if (located) {
        locate(chunk.pattern, threshold, chunk.start, true);   // a chunk that does not match counts the score of its best candidate, as a negative
        for (let s = 0; s < corpus.n; s++) if (out[s] > 0) { merged[s] += out[s]; matched[s] = 1; } else merged[s] -= out[s];
        continue;
      }
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
    return { q, chunks, rule, denom, threshold, kmax: kmaxFor(Math.min(q.length, MAX_BITS), threshold, denom) };
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
      if (equalsPattern(corpus, s, q)) scores[s] = q.length >= minLength ? 0 : -1;
    }
  }

  // The score of every string for one pattern (-1: no match); the array is reused by the next call.
  function patternScores(plan) {
    const { q, chunks, kmax, rule, threshold } = plan;
    let scores;
    if (chunks.length > 1) scores = scanChunks(plan);
    else {
      scanner.prep(q); scores = scanner.scan(q.length, kmax, rule);
      if (located) locate(q, threshold, 0, false);
      else if (finder) dropShortMatches(scores, q, q, kmax, rule);
    }
    settleExact(scores, q);
    return scores;
  }

  // Thins out the strings cand[0..count) of a sparse extended search by a fuzzy term, adding the scores of those that match to `sum`, and returns how many are left;
  // -1 when scanning them all is cheaper (or the pattern is not a plain one: more than one chunk, a typing rule, location scoring, minMatchCharLength).
  // The simd tier does this in wasm up to a number of strings it says (subsetMax), the others in js, always.
  let subsetScanner = null;
  function narrowByFuzzy({ q, chunks, kmax, rule }, count) {
    if (count > (scanner.subsetMax ?? Infinity) || chunks.length > 1 || rule || located || finder) return -1;
    subsetScanner ??= scanner.extendedWasm?.subset ?? (scanner.scanSubset ? scanner : jsScanner(corpus, { transposition: typing.transposition }));
    subsetScanner.prep(q);
    if (subsetScanner.narrowFuzzy) return subsetScanner.narrowFuzzy(q.length, kmax, count);
    const { cand, sum } = stringMatchers, found = subsetScanner.scanSubset(q.length, kmax, cand, count);
    let kept = 0;
    for (let i = 0; i < count; i++) {
      const s = cand[i];
      if (equalsPattern(corpus, s, q)) found[s] = 0;
      if (found[s] >= 0) { cand[kept++] = s; sum[s] += found[s]; }
    }
    return kept;
  }

  // One plan per term of the query, with the idf weight Fuse gives the term (rarer terms count more).
  function tokenPlans(query, threshold) {
    frequencies ??= documentFrequencies(index, tokenizer);
    return tokenizer(query).map(term => ({ ...planFor(normalize(term), threshold), idf: idfOf(frequencies, term) }));
  }

  // Fuse's token score of every string: the idf-weighted mean of the terms' scores, 1 - sum(idf * (1 - score)) / sum(idf), over the terms that match
  // (-1 when none does). With tokenMatch "all", the documents whose strings together miss a term are dropped (not in a logical query, as in Fuse).
  function tokenScores(plans, requireAll = tokenMatch === "all") {
    const { tokens } = scanner, lastUse = new Map(plans.map((plan, i) => [plan.q, i])), kept = new Map();
    const batch = finder ? null : scanner.scanMany?.(plans.filter(plan => plan.q.length && plan.chunks.length === 1 && !plan.rule));
    if (batch) for (const [q, scores] of batch) settleExact(scores, q);
    tokens.begin();
    let maxScore = 0;
    plans.forEach((plan, i) => {
      maxScore += plan.idf;
      if (!plan.q.length) return;
      // A repeated term is scanned once: its scores are kept for its later occurrences (the scanner reuses its array).
      const scores = batch?.get(plan.q) ?? kept.get(plan.q) ?? patternScores(plan);
      tokens.add(scores, plan.idf);
      if (requireAll) tokens.cover(scores);
      if (lastUse.get(plan.q) !== i && !kept.has(plan.q) && !batch?.has(plan.q)) kept.set(plan.q, scores.slice());
    });
    return tokens.finish(maxScore, requireAll ? plans.length : 0);
  }

  // The extended query as groups of terms { type, pattern }; a fuzzy term also has the plan of its pattern, and the number of its group.
  function extendedGroups(query, threshold) {
    return parseExtended(normalize(query)).map((terms, group) => terms.map(term => term.type === "fuzzy" ? { ...term, plan: { ...planFor(term.pattern, threshold), group } } : term));
  }

  // The scores of several patterns of an extended search scanned in a few passes (a Map from pattern to scores), when the scanner can and they are short; else null.
  function scanTogether(plans) {
    const batch = located || finder ? null : scanner.scanMany?.(plans.filter(plan => plan.chunks.length === 1 && !plan.rule));
    if (batch) for (const [q, scores] of batch) settleExact(scores, q);
    return batch;
  }

  // Fuse's extended score of every string: the first OR group whose terms all match decides, the score is the mean of their scores (-1: no group matches).
  // Also records which group matched (`extended.dense.group`) and whether one of its matching terms was an inverse operator (`extended.dense.inverse`).
  // A document with an inverse match in one key and no match in another is dropped (not in a logical query, as in Fuse).
  // When every group has a term that matches few strings (DRIVERS), only the strings of those lists are looked at; otherwise every string is.
  // `extended.docs` is then the ascending list of documents that can have a hit (null: all of them).
  function extendedScores(groups, dropInverse = true) {
    extended ??= {
      dense: scanner.extendedWasm?.dense ?? jsDenseState(nStr, present),
      touched: new Int32Array(nStr), touchedCount: -1, docList: new Int32Array(nDocs), docs: null, docCount: 0,
    };
    const sparse = groups.every(terms => !terms.length || terms.some(({ type }) => DRIVERS.has(type)));
    if (sparse) sparseScores(groups); else denseScores(groups);
    const { scores, group, inverse } = extended.dense;
    if (dropInverse && !keyless && groups.some(terms => terms.some(({ type }) => isInverse(type)))) {
      const { docs, docCount } = extended;
      for (let i = 0; i < docCount; i++) {
        const d = docs ? docs[i] : i;
        let hasInverse = false, keyFailed = false;
        for (const { base, width } of keys) {
          let first = base;
          while (first < base + width && group[d * K + first] < 0) first++;
          if (first === base + width) keyFailed = true; else if (inverse[d * K + first]) hasInverse = true;
        }
        if (hasInverse && keyFailed) scores.fill(-1, d * K, d * K + K);
      }
    }
    return scores;
  }

  // Every string is scored.
  function denseScores(groups) {
    const { dense } = extended;
    const batch = scanTogether(groups.flatMap(terms => terms.flatMap(term => term.plan ?? [])));
    let initial = true;
    groups.forEach((terms, g) => {
      if (!terms.length) return;
      const fuzzy = terms.some(term => term.plan);
      dense.begin(fuzzy);
      for (const { type, pattern, plan } of terms) {
        if (plan) dense.fuzzy(batch?.get(plan.q) ?? patternScores(plan));
        else dense.term(stringMatchers.mark(type, pattern), isInverse(type) ? 2 : 0);
      }
      dense.finish(g, terms.length, fuzzy, initial);
      initial = false;
    });
    extended.touchedCount = -1; extended.docs = null; extended.docCount = nDocs;
  }

  const DRIVER_BOUND = 200, SELECTIVE_INCLUDE = 3;
  function driverOf(matchers) {
    const drivers = matchers.filter(({ type }) => DRIVERS.has(type));
    let anchored = null, include = null, least = Infinity;
    for (const term of drivers) {
      if (term.type === "include") { if (!include || term.pattern.length > include.pattern.length) include = term; continue; }
      const bound = stringMatchers.bound(term.type, term.pattern);
      if (bound < least) { least = bound; anchored = term; }
    }
    return anchored && (least <= DRIVER_BOUND || !include || include.pattern.length < SELECTIVE_INCLUDE) ? anchored : include;
  }

  const scanCost = type => type === "include" || type === "inverse-exact" ? 1 : 0;   // the others only look at the ends of a string

  // The strings a group matches start as the list of its driver term (the cheapest one that matches few strings); its other terms thin the list out,
  // the exact-style ones first so that a fuzzy scan is skipped once nothing is left. `bits` is 1 for a string where an inverse term matched.
  function sparseScores(groups) {
    const { cand, bits, sum } = stringMatchers, { touched, docList } = extended, { scores, group, inverse } = extended.dense;
    if (extended.touchedCount < 0) { scores.fill(-1); group.fill(-1); inverse.fill(0); }
    else for (let i = 0; i < extended.touchedCount; i++) { const s = touched[i]; scores[s] = -1; group[s] = -1; inverse[s] = 0; }
    let count = 0, contributing = 0;
    groups.forEach((terms, g) => {
      if (!terms.length) return;
      const matchers = terms.filter(term => !term.plan), fuzzy = terms.filter(term => term.plan);
      const driver = driverOf(matchers);
      let m = stringMatchers.drive(driver.type, driver.pattern);
      stringMatchers.begin(m);
      for (const term of matchers.sort((a, b) => scanCost(a.type) - scanCost(b.type))) {
        if (term === driver || !m) continue;
        m = stringMatchers.narrow(term.type, term.pattern, m);
      }
      let batch = null;
      for (let k = 0; k < fuzzy.length && m; k++) {
        const { plan } = fuzzy[k], narrowed = narrowByFuzzy(plan, m);
        if (narrowed >= 0) { m = narrowed; continue; }
        batch ??= scanTogether(fuzzy.slice(k).map(term => term.plan));
        const found = batch?.get(plan.q) ?? patternScores(plan);
        let kept = 0;
        for (let i = 0; i < m; i++) { const s = cand[i]; if (found[s] >= 0) { cand[kept++] = s; sum[s] += found[s]; } }
        m = kept;
      }
      const before = count;
      for (let i = 0; i < m; i++) {
        const s = cand[i];
        if (group[s] >= 0) continue;
        scores[s] = fuzzy.length ? sum[s] / terms.length : 0; group[s] = g; inverse[s] = bits[s]; touched[count++] = s;
      }
      if (count > before) contributing++;
    });
    extended.touchedCount = count;
    if (contributing > 1) touched.subarray(0, count).sort();
    let nd = 0;
    for (let i = 0; i < count; i++) { const d = (touched[i] / K) | 0; if (nd === 0 || docList[nd - 1] !== d) docList[nd++] = d; }
    extended.docs = docList; extended.docCount = nd;
  }

  // What the matcher needs of an extended search: the plans of the matched group per string, and the ranges of the exact-style terms of that group.
  const extendedMatching = groups => ({
    applies: (s, plan) => extended.dense.group[s] === plan.group,
    ranges(s) {
      const g = extended.dense.group[s];
      return g < 0 ? [] : groups[g].flatMap(({ type, pattern, plan }) => plan ? [] : stringMatchers.ranges(type, pattern, s));
    },
  });

  // Scores every document that matched in at least one slot and returns the hit count; ids/scores land in hitIds/docScore.
  function combine(scores, list = null, count = nDocs) {
    let m = 0;
    for (let i = 0; i < count; i++) {
      const d = list ? list[i] : i;
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

  // With a sortFn, the hits ({ idx, score }) are sorted as Fuse's result records (the order of ties is by document), then cut to the limit.
  // `matchesOf(hit, slots)` lists the strings that matched as { s, score, inverse, indices }; `formatted` maps a document to the `matches` of its result (null: none).
  function sortCustom(hits, cap, matchesOf, formatted) {
    const results = hits.map(hit => {
      const slots = slotsOf(hit.idx), bySlot = new Map(slots.map(slot => [slot.s, slot]));
      const matches = matchesOf(hit, slots).map(({ s, score, inverse, indices }) => {
        const { keyDef, value, refIndex } = bySlot.get(s), match = { score };
        if (keyDef) match.key = keyObjects.get(keyDef).key;
        match.value = value;
        if (refIndex !== undefined) match.idx = refIndex;
        match.norm = norms[s]; match.indices = indices;
        if (keyDef) match.hasInverse = inverse;
        return match;
      });
      return { idx: hit.idx, item: indexRecord(hit.idx, slots), matches, score: hit.score };
    });
    results.sort((a, b) => sortFn(a, b) || a.idx - b.idx);
    return (cap > 0 ? results.slice(0, cap) : results).map(({ idx, score }) => {
      const out = result(idx, score);
      if (formatted) out.matches = formatted.get(idx);
      return out;
    });
  }

  // The cap on the results for a limit: -1 for none. Fuse takes the best `limit` of a plain query in a heap (so a fraction rounds up), the rest of a sorted list by slice.
  const capOf = (limit, plain) => typeof limit === "number" && limit > -1 ? (plain && shouldSort ? Math.ceil : Math.trunc)(limit) : -1;

  // Fuse's logical query ({ $and }, { $or }, { key: pattern }, { $path, $val }). Every leaf is scored like a query of its own in every string; a leaf matches in the
  // strings of its key (all keys for a string) that score, and a document matches when the tree is satisfied. Its score multiplies the matches of all leaves that
  // were part of the match, so a string matched by two leaves counts twice.
  function searchLogical(query, { limit, threshold }) {
    const tree = parseLogical(query);
    return keyless ? [] : searchTree(tree, capOf(limit, false), threshold, false);
  }

  function searchTree(tree, cap, threshold, plain) {
    if (cap === 0) return [];
    const leaves = leavesOf(tree), t0 = performance.now();
    for (const leaf of leaves) scoreLeaf(leaf, threshold, plain);
    const t1 = performance.now(), hits = [];
    for (let d = 0; d < nDocs; d++) {
      const entries = evaluateLogical(tree, leaf => leafMatches(leaf, d));
      if (!entries.length) continue;
      let total = 1;
      for (const { s, score } of entries) total *= Math.pow(score === 0 ? exactScore : score, weights[s - d * K] * (ignoreFieldNorm ? 1 : norms[s]));
      hits.push({ idx: d, entries, score: total });
    }
    timings.scan = t1 - t0; timings.combine = performance.now() - t1; timings.format = 0;
    const matchesOfHit = hit => hit.entries.filter(entry => entry.slot?.indices?.length).map(entry => fuseMatch(entry.slot));
    if (sortFn) {
      if (matcher) rangesOfLeaves(leaves, hits);
      const formatted = matcher && new Map(hits.map(hit => [hit.idx, matchesOfHit(hit)]));
      return sortCustom(hits, cap, hit => hit.entries.map(({ s, score, leaf, slot }) => ({ s, score, inverse: leaf.found ? slot.hasInverse : leaf.inverse?.[s] ? true : undefined, indices: slot?.indices })), formatted);
    }
    if (shouldSort) hits.sort(defaultSortFn);
    const kept = cap > -1 ? hits.slice(0, cap) : hits, res = kept.map(hit => result(hit.idx, hit.score));
    if (matcher) {
      rangesOfLeaves(leaves, kept);
      kept.forEach((hit, i) => { res[i].matches = matchesOfHit(hit); });
    }
    return res;
  }

  // Scores the strings for the pattern of a leaf, keeping what is needed later: the scores, the strings of its key ([first, end) slot of a document) and
  // `ranges()` for the highlighting, which makes the scan of an extended search current again (its state is shared by the leaves).
  function scoreLeaf(leaf, threshold, plain) {
    const def = leaf.keyId === null ? null : keys.find(({ id }) => id === leaf.keyId);
    leaf.first = def ? def.base : 0; leaf.end = leaf.keyId === null ? K : def ? def.base + def.width : 0;
    const searcher = leaf.searcher ?? pluginSearcher(leaf.pattern, threshold);
    if (searcher) scanPlugin(leaf, searcher, plain);
    else if (useExtendedSearch) {
      const groups = extendedGroups(leaf.pattern, threshold), scan = () => extendedScores(groups, false);
      leaf.plans = groups.flat().flatMap(term => term.plan ?? []);
      if (groups.some(terms => terms.length)) {
        leaf.scores = scan().slice();
        if (sortFn) leaf.inverse = extended.dense.inverse.slice();
      }
      leaf.refresh = () => { scan(); return extendedMatching(groups); };
    } else {
      leaf.plans = useTokenSearch ? tokenPlans(leaf.pattern, threshold) : [planFor(normalize(leaf.pattern), threshold)];
      if (leaf.plans.some(plan => plan.q.length)) leaf.scores = (useTokenSearch ? tokenScores(leaf.plans, false) : patternScores(leaf.plans[0])).slice();
    }
  }

  // An instance of the first registered plugin (Fuse.use) whose condition holds for the pattern; null for none, and always with extended or token search.
  function pluginSearcher(pattern, threshold) {
    const given = threshold === defaultThreshold ? options : { ...options, threshold }, Plugin = pluginFor(pattern, given);
    return Plugin ? new Plugin(pattern, given) : null;
  }

  // Fuse's way with a plugin: its searchIn gets the text of every string of the leaf's key, and what it returns is kept as it is, `indices` of the match included.
  // With `dropInverse` (a plain query), a document is dropped when an inverse match was reported for one of its keys and another key has no match, like Fuse does.
  function scanPlugin(leaf, searcher, dropInverse) {
    const { first, end } = leaf, scores = new Float64Array(nStr).fill(-1), found = new Map();
    for (let d = 0; d < nDocs; d++) {
      for (const slot of slotsOf(d)) {
        if (slot.s - d * K < first || slot.s - d * K >= end) continue;
        const { isMatch, score, indices, hasInverse } = searcher.searchIn(slot.value);
        if (!isMatch) continue;
        scores[slot.s] = score; found.set(slot.s, { ...slot, indices, hasInverse });
      }
      if (dropInverse && !keyless && droppedByInverse(d, scores, found)) scores.fill(-1, d * K, d * K + K);
    }
    leaf.scores = scores; leaf.found = found; leaf.plans = [];
  }

  function droppedByInverse(d, scores, found) {
    let hasInverse = false, keyFailed = false;
    for (const { base, width } of keys) {
      let first = base;
      while (first < base + width && scores[d * K + first] < 0) first++;
      if (first === base + width) keyFailed = true; else if (found.get(d * K + first).hasInverse) hasInverse = true;
    }
    return hasInverse && keyFailed;
  }

  function leafMatches(leaf, d) {
    const { scores, first, end, found: slots } = leaf, found = [];
    if (!scores) return found;
    for (let s = d * K + first; s < d * K + end; s++) if (present[s] && scores[s] >= 0) found.push({ s, score: scores[s], leaf, slot: slots?.get(s) });
    return found;
  }

  // Sets `slot` (the string with its `indices`) on the entries of the hits that have highlighted ranges, leaf by leaf.
  function rangesOfLeaves(leaves, hits) {
    for (const leaf of leaves) {
      if (leaf.found) continue;
      const mine = hits.filter(hit => hit.entries.some(entry => entry.leaf === leaf));
      if (!mine.length) continue;
      const found = matcher(mine.map(hit => hit.idx), leaf.plans, leaf.refresh?.());
      mine.forEach((hit, i) => {
        for (const slot of found[i]) {
          const entry = hit.entries.find(e => e.leaf === leaf && e.s === slot.s);
          if (entry) entry.slot = slot;
        }
      });
    }
  }

  // sortCustom for the hits of a plain, token or extended search, where one pattern scored every string.
  function sortHits(m, scores, cap, plans, matching) {
    const ids = Array.from(hitIds.subarray(0, m)), found = matcher?.(ids, plans, matching), foundOf = found && new Map(ids.map((d, i) => [d, found[i]]));
    const hits = ids.map(idx => ({ idx, score: docScore[idx] }));
    const matchesOf = ({ idx }, slots) => slots.filter(slot => scores[slot.s] >= 0).map(({ s }) => (
      { s, score: scores[s], inverse: extended?.dense.inverse[s] ? true : undefined, indices: foundOf?.get(idx).find(slot => slot.s === s)?.indices }));
    return sortCustom(hits, cap, matchesOf, foundOf && new Map(ids.map((d, i) => [d, found[i].map(fuseMatch)])));
  }

  function search(query, { limit, threshold = defaultThreshold } = {}) {
    if (typeof query !== "string") return searchLogical(query, { limit, threshold });
    if (!query.trim()) {
      const all = docs.map((item, refIndex) => ({ item, refIndex }));
      return typeof limit === "number" && limit > -1 ? all.slice(0, limit) : all;
    }
    return searchPattern(query, { limit, threshold });
  }

  // Searches for a string query, without the shortcut for a blank one (Fuseter.match searches for any pattern); `builtin` skips the plugins.
  function searchPattern(query, { limit, threshold = defaultThreshold, builtin = false } = {}) {
    const cap = typeof limit === "number" && limit > 0 ? Math.ceil(limit) : limit === 0 ? 0 : -1;
    if (cap === 0) return [];
    const searcher = builtin ? null : pluginSearcher(query, threshold);
    if (searcher) return searchTree({ keyId: null, pattern: query, searcher }, capOf(limit, true), threshold, true);
    const groups = useExtendedSearch ? extendedGroups(query, threshold) : null;
    const plans = groups ? groups.flat().flatMap(term => term.plan ?? []) : useTokenSearch ? tokenPlans(query, threshold) : [planFor(normalize(query), threshold)];
    if (groups ? !groups.some(terms => terms.length) : useTokenSearch ? !plans.length : !plans[0].q.length) return [];
    const plain = !groups && !useTokenSearch;
    const { q, chunks, kmax, rule, denom } = plain ? plans[0] : {};
    let t0 = performance.now(), t1, t2, res;

    let custom = false, matching = null;
    if (plain && chunks.length === 1 && scanner.combineSort && simpleRanking) {
      scanner.prep(q); scanner.scan(q.length, kmax, rule);
      t1 = performance.now();
      const { hits, ids, scores } = scanner.combineSort(q.length, denom, kmax, cap > 0 && cap < nDocs ? cap : 0);
      const count = cap > 0 && hits > cap ? cap : hits;
      t2 = performance.now();
      res = new Array(count);
      for (let i = 0; i < count; i++) res[i] = result(ids[i], scores[i]);
    } else {
      const scores = groups ? extendedScores(groups) : useTokenSearch ? tokenScores(plans) : patternScores(plans[0]);
      matching = groups && extendedMatching(groups);
      t1 = performance.now();
      const m = groups ? combine(scores, extended.docs, extended.docCount) : combine(scores);
      if (sortFn) { custom = true; res = sortHits(m, scores, cap, plans, matching); t2 = t1; }
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
      const matches = matcher(res.map(r => r.refIndex), plans, matching);
      for (let i = 0; i < res.length; i++) res[i].matches = matches[i].map(fuseMatch);
    }
    timings.scan = t1 - t0; timings.combine = t2 - t1; timings.format = performance.now() - t2;
    return res;
  }
  return { search, searchPattern, timings };
}
