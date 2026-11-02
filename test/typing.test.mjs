import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fuseter } from "../src/index.mjs";
import { kmaxFor } from "../src/kernel-js.mjs";
import { fieldNorm, textNormalizer } from "../src/text.mjs";
import { rng, randomText, randomQueries, stringsOf, compare, fuseFor, edit } from "./helpers.mjs";

const BACKENDS = (process.env.BACKENDS ?? "simd,wasm,js").split(",");
const THRESHOLDS = [0, 0.2, 0.4, 0.6, 1];
const alnum = ch => /^[\p{L}\p{N}]$/u.test(ch);

// Plain O(m*n) approximate substring match: fewest edits between the pattern and any substring of the text
// (with `prefix`: any prefix of the text). With `transposed`, swapping two adjacent characters is one edit (optimal string alignment distance).
function minErrors(pattern, text, transposed, prefix = false) {
  const m = pattern.length, rows = [Array.from({ length: m + 1 }, (_, i) => i)];
  let best = m;
  for (let j = 1; j <= text.length; j++) {
    const prev = rows[j - 1], row = [prefix ? j : 0];
    for (let i = 1; i <= m; i++) {
      row[i] = Math.min(prev[i - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1), prev[i] + 1, row[i - 1] + 1);
      if (transposed && i > 1 && j > 1 && pattern[i - 1] === text[j - 2] && pattern[i - 2] === text[j - 1]) row[i] = Math.min(row[i], rows[j - 2][i - 2] + 1);
    }
    best = Math.min(best, row[m]);
    rows.push(row);
  }
  return best;
}

// Word-start flags per character of the normalised text (one flag per UTF-16 unit, like the index).
function wordStartFlags(raw, normalize) {
  const flags = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i], before = raw[i - 1];
    const start = alnum(ch) && (before === undefined || !alnum(before) || (before !== before.toUpperCase() && ch !== ch.toLowerCase()));
    for (let k = 0; k < normalize(ch).length; k++) flags.push(start && k === 0);
  }
  return flags;
}

// Weighted positions of a normalised query: the first character of every word (weighted: true) or only the first character ('first').
function queryWeights(q, weighted) {
  return Array.from({ length: q.length }, (_, i) => alnum(q[i]) && (weighted === true ? i === 0 || !alnum(q[i - 1]) : i === 0));
}

// Fewest weighted errors of a substring match. Editing a weighted pattern character (W[i]) costs 2, an exact match of it is free on a
// word start and costs `midWord` elsewhere. A transposition costs 1, but one whose first character is weighted has to start on a word start.
function weightedErrors(pattern, text, flags, W, transposed, midWord) {
  const m = pattern.length, edit = i => W[i] ? 2 : 1;
  const first = [0];
  for (let i = 1; i <= m; i++) first.push(first[i - 1] + edit(i - 1));
  const rows = [first];
  let best = first[m];
  for (let j = 1; j <= text.length; j++) {
    const prev = rows[j - 1], row = [0];
    for (let i = 1; i <= m; i++) {
      const substitution = pattern[i - 1] === text[j - 1] ? (W[i - 1] && !flags[j - 1] ? midWord : 0) : edit(i - 1);
      row[i] = Math.min(prev[i - 1] + substitution, prev[i] + 1, row[i - 1] + edit(i - 1));
      if (transposed && i > 1 && j > 1 && pattern[i - 1] === text[j - 2] && pattern[i - 2] === text[j - 1] && (!W[i - 2] || flags[j - 2])) row[i] = Math.min(row[i], rows[j - 2][i - 2] + 1);
    }
    best = Math.min(best, row[m]);
    rows.push(row);
  }
  return best;
}

// Reference ranking for single-chunk queries: Fuse's scoring with the heuristics applied per string.
function reference(docs, keys, query, { threshold, weighted = false, midWord = 1, transposition = false, limit }) {
  const normalize = textNormalizer({}), norm = fieldNorm(), q = normalize(query);
  const keyed = typeof docs[0] !== "string";
  const defs = keyed ? keys : [{ name: null, weight: 1 }];
  const totalWeight = defs.reduce((sum, k) => sum + k.weight, 0);
  const W = weighted ? queryWeights(q, weighted) : [], count = W.filter(Boolean).length;
  const denom = q.length + count, kmax = kmaxFor(q.length, threshold, denom);
  const hits = [];
  docs.forEach((doc, refIndex) => {
    let total = 1, any = false;
    defs.forEach(({ name, weight }) => {
      const raw = keyed ? doc[name] : doc;
      if (typeof raw !== "string" || !raw.trim()) return;
      const text = normalize(raw), errors = count ? weightedErrors(q, text, wordStartFlags(raw, normalize), W, transposition, midWord) : minErrors(q, text, transposition);
      if (errors > kmax || text.length < q.length - kmax) return;
      const v = text === q ? 0 : Math.max(errors / denom, 0.001);
      any = true;
      total *= Math.pow(v === 0 ? (keyed ? Number.EPSILON : 0) : v, weight / totalWeight * norm(raw));
    });
    if (any) hits.push({ refIndex, score: total });
  });
  hits.sort((a, b) => a.score - b.score || a.refIndex - b.refIndex);
  return limit === undefined ? hits : hits.slice(0, limit);
}

const check = async (docs, keys, queries, typing, backends = BACKENDS) => {
  const options = { keys, includeScore: true, typing };
  const { firstLetter, transposition } = typing;
  const weighted = !firstLetter ? false : firstLetter === true ? true : firstLetter.weighted ?? true, midWord = firstLetter?.midWord ?? 1;
  for (const backend of backends) {
    const ff = await Fuseter.create(docs, options, { backend, fallback: "throw" });
    for (const threshold of THRESHOLDS) for (const query of queries) for (const limit of [undefined, 4]) {
      const want = reference(docs, keys, query, { threshold, weighted, midWord, transposition, limit });
      const got = ff.search(query, { threshold, limit }).map(r => ({ refIndex: r.refIndex, score: r.score }));
      assert.deepEqual(got, want, `${backend} threshold=${threshold} limit=${limit} query=${JSON.stringify(query)}`);
    }
  }
};

const shortQueries = (r, strings) => randomQueries(r, strings, 40).filter(q => q.trim() && q.length <= 32).concat(["-x", "(a", " lord", "gpt", "pt", "TERRA"]);

// Queries cut from the strings with one or two adjacent swaps (and sometimes another edit) applied.
function swappedQueries(r, strings, count, maxLen = 14) {
  const qs = ["ab", "ba", "abab", "aab", "teh", "desspeek", "hte lrod"];
  while (qs.length < count) {
    const s = r.pick(strings);
    if (!s.length) continue;
    const start = r.int(s.length), chars = [...s.substr(start, 2 + r.int(maxLen))];
    for (let swaps = 1 + r.int(2); swaps > 0 && chars.length > 1; swaps--) {
      const i = r.int(chars.length - 1);
      [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
    }
    qs.push(r.int(3) === 0 ? edit(r, chars.join("")) : chars.join(""));
  }
  return qs.filter(q => q.trim());
}

describe("transposition", () => {
  const r = rng(21);
  const docs = Array.from({ length: 200 }, () => ({ title: randomText(r, 1, 4), author: randomText(r, 1, 3) }));
  const keys = [{ name: "title", weight: 2 }, { name: "author", weight: 1 }];
  const queries = swappedQueries(rng(22), stringsOf(docs, ["title", "author"]), 40);

  test("matches a plain optimal-string-alignment reference on every backend", async () => {
    await check(docs, keys, queries, { transposition: true });
  });

  test("combined with first-letter weighting", async () => {
    await check(docs, keys, queries, { transposition: true, firstLetter: true });
  });

  test("string collection", async () => {
    const strings = Array.from({ length: 250 }, () => randomText(r, 1, 5));
    await check(strings, [], swappedQueries(rng(23), strings, 40), { transposition: true });
  });

  test("patterns of 17-32 characters (32-bit kernels)", async () => {
    const strings = Array.from({ length: 150 }, () => randomText(r, 4, 9));
    const long = swappedQueries(rng(24), strings, 120, 30).filter(q => q.length > 16 && q.length <= 32).slice(0, 12);
    assert.ok(long.length >= 6);
    await check(strings, [], long, { transposition: true });
  });

  test("a swapped pair costs one error", async () => {
    const names = ["deepseek", "deepseek v3", "other"];
    const plain = await Fuseter.create(names, { includeScore: true, ignoreFieldNorm: true });
    const swapped = await Fuseter.create(names, { includeScore: true, ignoreFieldNorm: true, typing: { transposition: true } });
    assert.equal(plain.search("depeseek")[0].score, 2 / 8);
    assert.equal(swapped.search("depeseek")[0].score, 1 / 8);
    assert.equal(swapped.search("dpeeseek")[0].score, 2 / 8);
  });

  test("identical to Fuse when disabled", async () => {
    const options = { keys, includeScore: true };
    const ff = await Fuseter.create(docs, { ...options, typing: { transposition: false } });
    for (const query of queries.slice(0, 15)) assert.equal(compare(ff.search(query), fuseFor(docs, options).search(query)), null, query);
  });
});

describe("weighted first letter only", () => {
  const r = rng(41);
  const docs = Array.from({ length: 200 }, () => ({ title: randomText(r), author: randomText(r, 1, 3) }));
  const keys = [{ name: "title", weight: 3 }, { name: "author", weight: 1 }];
  const queries = shortQueries(rng(42), stringsOf(docs, ["title", "author"]));
  const weighted = { firstLetter: { weighted: "first" } };

  test("keyed documents match a plain reference", async () => {
    await check(docs, keys, queries, weighted);
  });

  test("with transposition", async () => {
    await check(docs, keys, swappedQueries(rng(43), stringsOf(docs, ["title", "author"]), 40), { ...weighted, transposition: true });
  });

  test("string collection", async () => {
    const strings = Array.from({ length: 250 }, () => randomText(r, 1, 5));
    await check(strings, [], shortQueries(rng(44), strings), weighted);
  });

  test("midWord 2: an exact first character mid-word costs 2, like a wrong one", async () => {
    const strict = { firstLetter: { weighted: "first", midWord: 2 } };
    await check(docs, keys, queries, strict);
    const names = ["Perceptron", "GPT", "x (pt)", "tp link"];
    const ff = await Fuseter.create(names, { includeScore: true, ignoreFieldNorm: true, threshold: 0.7, typing: strict }, { backend: "js" });
    const hits = q => ff.search(q).map(x => [x.refIndex, +x.score.toFixed(3)]);
    assert.deepEqual(hits("pt"), [[2, 0.001], [0, 0.333]]);   // GPT would cost 2, more than a 2-character pattern may have
    assert.deepEqual(hits("gpt"), [[1, 0], [0, 0.5], [2, 0.5]]);   // dropping the g costs 2 errors / (3 + 1)
    assert.deepEqual(hits("tron").slice(0, 1), [[0, 0.4]]);   // mid-word t: 2 errors / (4 + 1)
  });

  test("by default an exact first character mid-word costs 1, a wrong one 2", async () => {
    const cheap = weighted;
    await check(docs, keys, queries, cheap);
    await check(docs, keys, swappedQueries(rng(45), stringsOf(docs, ["title", "author"]), 40), { ...cheap, transposition: true });
    const names = ["Prompt tuned", "x (pt)", "GPT", "Perceptron", "tp link"];
    const ff = await Fuseter.create(names, { includeScore: true, ignoreFieldNorm: true, threshold: 0.7, typing: cheap }, { backend: "js" });
    const hits = q => ff.search(q).map(x => [x.refIndex, +x.score.toFixed(3)]);
    assert.deepEqual(hits("pt"), [[1, 0.001], [0, 0.333], [2, 0.333], [3, 0.333]]);   // GPT now stays in: mid-word p costs 1, not 2
    await assert.rejects(Fuseter.create(names, { typing: { firstLetter: { weighted: "first", midWord: 3 } } }), /midWord/);
  });

  });

describe("weighted first letter of every word (the default)", () => {
  const r = rng(51);
  const docs = Array.from({ length: 200 }, () => ({ title: randomText(r, 2, 6), author: randomText(r, 1, 3) }));
  const keys = [{ name: "title", weight: 3 }, { name: "author", weight: 1 }];
  const strings = stringsOf(docs, ["title", "author"]);
  const queries = shortQueries(rng(52), strings).concat(["wen co", "the lord", "a b c", "x-ray (pt)", "lord  of"]);
  const words = { firstLetter: { weighted: true } };

  test("keyed documents match a plain reference", async () => {
    await check(docs, keys, queries, words);
  });

  test("with transposition and midWord 2", async () => {
    await check(docs, keys, swappedQueries(rng(53), strings, 40, 24).concat(["hte lrod", "wen co"]), { firstLetter: { weighted: true }, transposition: true });
    await check(docs, keys, queries, { firstLetter: { weighted: true, midWord: 2 } });
  });

  test("string collection", async () => {
    const list = Array.from({ length: 250 }, () => randomText(r, 1, 5));
    await check(list, [], shortQueries(rng(54), list).concat(["a b", "wen co"]), words);
  });

  test("every query word counts: a wrong letter at the start of a later word costs 2", async () => {
    const names = ["Cohere: Command A+", "Wen Coffee", "Open Command"];
    const make = async weighted => Fuseter.create(names, { includeScore: true, ignoreFieldNorm: true, threshold: 0.6, typing: { firstLetter: { weighted } } }, { backend: "js" });
    const hits = (ff, q) => ff.search(q).map(x => [x.refIndex, +x.score.toFixed(5)]);
    const first = await make("first"), every = await make(true);
    assert.deepEqual(hits(first, "wen co"), [[1, 0.001], [2, 0.28571], [0, 0.42857]]);   // w dropped: 2, plus n for : (1) in Cohere, over 6 + 1
    assert.deepEqual(hits(first, "open xomm").slice(0, 1), [[2, 0.1]]);                    // x for c is an ordinary substitution: 1 / (9 + 1)
    assert.deepEqual(hits(every, "open xomm").slice(0, 1), [[2, +(2 / 11).toFixed(5)]]);   // the x starts the second word and counts double: 2 / (9 + 2)
  });
});

describe("first letter option", () => {
  const r = rng(11);
  const docs = Array.from({ length: 200 }, () => ({ title: randomText(r), author: randomText(r, 1, 3) }));
  for (let i = 0; i < docs.length; i += 13) delete docs[i].author;
  const keys = [{ name: "title", weight: 3 }, { name: "author", weight: 1 }];
  const queries = shortQueries(rng(12), stringsOf(docs, ["title", "author"]));

  test("true means every query word counts", async () => {
    await check(docs, keys, queries, { firstLetter: true });
    const a = await Fuseter.create(docs, { keys, includeScore: true, typing: { firstLetter: true } });
    const b = await Fuseter.create(docs, { keys, includeScore: true, typing: { firstLetter: { weighted: true } } });
    for (const query of queries.slice(0, 15)) assert.equal(compare(a.search(query), b.search(query)), null, query);
  });

  test("patterns of 17-32 characters (32-bit kernels), with and without transposition", async () => {
    const strings = Array.from({ length: 150 }, () => randomText(r, 4, 9));
    const long = swappedQueries(rng(14), strings, 160, 30).filter(q => q.length > 16 && q.length <= 32).slice(0, 12);
    assert.ok(long.length >= 6);
    await check(strings, [], long, { firstLetter: true });
    await check(strings, [], long, { firstLetter: { weighted: "first" }, transposition: true });
  });

  test("patterns longer than 32 characters are scored in chunks on every backend", async () => {
    const strings = Array.from({ length: 120 }, () => randomText(r, 6, 12));
    const query = strings.find(s => s.length > 40).slice(0, 40).replace(/ $/, "x");
    const off = await Fuseter.create(strings, { includeScore: true }, { backend: "js" });
    for (const backend of ["simd", "wasm", "js"]) {
      const on = await Fuseter.create(strings, { includeScore: true, typing: { firstLetter: true } }, { backend, fallback: "throw" });
      assert.equal(compare(on.search(query), off.search(query)), null, backend);
    }
  });

  test("word starts: separators, parentheses and camelCase", async () => {
    const names = ["OpenAI: GPT-6.1 Terra Pro (batch)", "GPT4Terra", "ultraptable", "x (pt)", "Prompt tuned", "myPtValue"];
    const options = { includeScore: true, ignoreFieldNorm: true, threshold: 0.4 };
    for (const backend of ["simd", "wasm", "js"]) {
      const ff = await Fuseter.create(names, { ...options, typing: { firstLetter: true } }, { backend, fallback: "throw" });
      const hits = q => ff.search(q).map(x => [x.refIndex, +x.score.toFixed(3)]);
      assert.deepEqual(hits("pt"), [[3, 0.001], [5, 0.001], [0, 0.333], [1, 0.333], [2, 0.333], [4, 0.333]], backend);
      assert.deepEqual(hits("terra"), [[0, 0.001], [1, 0.167]], backend);
    }
  });

  test("off or disabled is identical to Fuse", async () => {
    const options = { keys, includeScore: true };
    for (const typing of [undefined, null, {}, { firstLetter: false }]) {
      const ff = await Fuseter.create(docs, { ...options, typing });
      for (const query of ["lord", "ptter", "-x"]) assert.equal(compare(ff.search(query), fuseFor(docs, options).search(query)), null, query);
    }
  });

  test("weighting only the first character leaves a query that starts with something else unweighted", async () => {
    const off = await Fuseter.create(docs, { keys, includeScore: true });
    for (const backend of ["simd", "wasm", "js"]) {
      const on = await Fuseter.create(docs, { keys, includeScore: true, typing: { firstLetter: { weighted: "first" } } }, { backend, fallback: "throw" });
      for (const query of ["-x", "(a", "  x"]) assert.equal(compare(on.search(query), off.search(query)), null, `${backend} ${query}`);
    }
  });

  test("invalid typing options are rejected", async () => {
    const bad = [{ nope: true }, "yes", { firstLetter: { penalty: 0.2 } }, { firstLetter: "yes" }, { firstLetter: { weighted: "words" } }, { firstLetter: { weighted: 1 } },
      { firstLetter: { weighted: false } }, { firstLetter: { midWord: 0 } }, { firstLetter: { midWord: 3 } }];
    for (const typing of bad) await assert.rejects(Fuseter.create(docs, { keys, typing }), /typing|penalty|weighted|midWord/, JSON.stringify(typing));
  });
});
