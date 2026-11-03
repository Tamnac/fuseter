import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fuseter } from "../src/index.mjs";
import { buildIndex } from "../src/index-build.mjs";
import { createAligner } from "../src/align.mjs";
import { createLocator, jsScanner, kmaxFor } from "../src/kernel-js.mjs";
import { textNormalizer } from "../src/text.mjs";
import { weightRule } from "../src/typing.mjs";
import { rng, randomDocs, randomQueries, stringsOf, minErrors } from "./helpers.mjs";

const BACKENDS = (process.env.BACKENDS ?? "simd,wasm,js").split(",");

describe("locator agrees with the scan kernels", () => {
  const r = rng(41), docs = randomDocs(r, 300);
  const queries = randomQueries(r, stringsOf(docs, ["title"]), 40).filter(q => q.trim() && q.length <= 32);
  const normalize = textNormalizer({});

  for (const [name, transposition, firstLetter] of [["plain", false, null], ["transposition", true, null], ["weighted", false, { weighted: true, midWord: 1 }],
    ["weighted midWord 2", false, { weighted: "first", midWord: 2 }], ["weighted, transposition", true, { weighted: true, midWord: 1 }]]) {
    test(name, () => {
      const corpus = buildIndex(docs, { keys: ["title"], starts: Boolean(firstLetter) }).corpus;
      const scanner = jsScanner(corpus, { transposition }), locator = createLocator(corpus, transposition), aligner = createAligner(corpus, transposition);
      for (const query of queries) for (const threshold of [0.1, 0.4, 0.8]) {
        const q = normalize(query), rule = firstLetter ? weightRule(q, firstLetter) : null, denom = rule?.denom ?? q.length;
        const kmax = kmaxFor(q.length, threshold, denom);
        scanner.prep(q);
        const scores = Array.from(scanner.scan(q.length, kmax, rule));
        locator.prep(q, kmax, rule); aligner.prep(q, kmax, rule);
        scores.forEach((score, s) => {
          const found = locator.find(s, 0), spans = aligner.find(s);
          assert.equal(spans ? spans[0].cost : null, found ? found.level : null, `aligner: string ${s} query=${JSON.stringify(q)} threshold=${threshold}`);
          assert.equal(found ? Math.max(found.level / denom, 0.001) : -1, score, `string ${s} query=${JSON.stringify(q)} threshold=${threshold}`);
          if (found) assert.ok(found.start >= 0 && found.start < corpus.offs[s + 1] - corpus.offs[s]);
        });
      }
    });
  }
});

describe("matches with typing heuristics", () => {
  const r = rng(42), docs = randomDocs(r, 200), keys = [{ name: "title", weight: 2 }, "author", "tags"];
  const queries = randomQueries(r, stringsOf(docs, ["title", "author"]), 30).filter(q => q.trim());

  for (const typing of [{ transposition: true }, { firstLetter: true }, { firstLetter: { weighted: "first", midWord: 2 }, transposition: true }]) {
    test(JSON.stringify(typing), async () => {
      const results = [];
      for (const backend of BACKENDS) {
        const ff = await Fuseter.create(docs, { keys, typing, includeMatches: true }, { backend, fallback: "throw" });
        results.push(queries.map(q => ff.search(q, { threshold: 0.4 })));
      }
      for (const other of results.slice(1)) assert.deepEqual(other, results[0]);
      let hitCount = 0;
      for (const hits of results[0]) for (const { matches } of hits) {
        assert.ok(matches.length > 0);
        hitCount++;
        for (const { indices, value } of matches) {
          assert.ok(indices.length > 0);
          indices.forEach(([from, to], i) => {
            assert.ok(from >= 0 && from <= to && to < value.length, JSON.stringify({ indices, value }));
            if (i) assert.ok(from > indices[i - 1][1] + 1);
          });
        }
      }
      assert.ok(hitCount > 20);
    });
  }

  test("a swapped query is highlighted where it was swapped", async () => {
    const docs = ["see the lord of the rings", "unrelated"], options = { includeMatches: true, threshold: 0.3 };
    const plain = await Fuseter.create(docs, options), swapped = await Fuseter.create(docs, { ...options, typing: { transposition: true } });
    assert.equal(plain.search("lrod").length, 0);
    assert.ok(swapped.search("lrod")[0].matches[0].indices.some(([from, to]) => from <= 8 && to >= 11));
  });
});

describe("highlighting (experimental)", () => {
  const create = (docs, highlighting, options = {}) => Fuseter.create(docs, { includeMatches: true, threshold: 0.4, highlighting, ...options });
  const marked = (ff, query) => ff.search(query).map(({ matches: [{ value, indices }] }) => indices.map(([from, to]) => value.slice(from, to + 1)));

  test("options are validated", async () => {
    await assert.rejects(Fuseter.create(["a"], { highlighting: { aligned: true } }), TypeError);
    await assert.rejects(Fuseter.create(["a"], { includeMatches: true, highlighting: { best: true } }), TypeError);
    await assert.rejects(Fuseter.create(["a"], { includeMatches: true, highlighting: true }), TypeError);
    await Fuseter.create(["a"], { includeMatches: true, highlighting: { aligned: false } });
  });

  test("aligned: the text the query was aligned with, not scattered letters", async () => {
    const docs = ["Sweet Savage Love Rosemary Rogers", "The Harry Potter"];
    assert.deepEqual(marked(await create(docs, null), "hary poter"), [["Harry Potter"], ["ary Ro", "er"]]);
    assert.deepEqual(marked(await create(docs, { aligned: true }), "hary poter"), [["Harry Potter"], ["mary Roger"]]);
  });

  test("allOccurrences: every place within the threshold", async () => {
    const docs = ["the lorrd of the lord and lard"];
    assert.deepEqual(marked(await create(docs, null), "lord"), [["lord"]]);
    assert.deepEqual(marked(await create(docs, { aligned: true }), "lord"), [["lord"]]);
    assert.deepEqual(marked(await create(docs, { aligned: true, allOccurrences: true }), "lord"), [["lorrd", "lord", "lard"]]);
    assert.deepEqual(marked(await create(docs, { allOccurrences: true }), "lord"), [["lorrd", "lord", "l", "rd"]]);
  });

  test("a transposed query is one error with the transposition heuristic", async () => {
    const ff = await create(["teh lrod"], { aligned: true }, { typing: { transposition: true }, threshold: 0.3 });
    assert.deepEqual(marked(ff, "lrod"), [["lrod"]]);
  });

  for (const [name, options, transposed] of [["plain", {}, false], ["transposition", { typing: { transposition: true } }, true]]) {
    test(`ranges agree with a reference alignment cost (${name})`, async () => {
      const r = rng(44), docs = randomDocs(r, 150), threshold = 0.4, normalize = textNormalizer({});
      const queries = randomQueries(r, stringsOf(docs, ["title", "author"]), 30).filter(q => q.trim() && q.length <= 32);
      const one = await create(docs, { aligned: true }, { keys: ["title", "author"], threshold, ...options });
      const all = await create(docs, { aligned: true, allOccurrences: true }, { keys: ["title", "author"], threshold, ...options });
      let checked = 0;
      for (const query of queries) {
        const q = normalize(query), kmax = kmaxFor(q.length, threshold);
        const single = one.search(query), several = all.search(query);
        assert.deepEqual(several.map(h => h.refIndex), single.map(h => h.refIndex));
        single.forEach((hit, n) => hit.matches.forEach((match, k) => {
          const text = normalize(match.value), best = minErrors(q, text, transposed);
          assert.equal(match.indices.length, 1, `one range for ${JSON.stringify(match)}`);
          const [[from, to]] = match.indices;
          assert.equal(minErrors(q, text.slice(from, to + 1), transposed), best, `${JSON.stringify(q)} in ${JSON.stringify(text)} at ${from}-${to}`);
          const ranges = several[n].matches[k].indices;
          assert.ok(ranges.some(([a, b]) => a <= from && b >= to), "the best range is among all");
          ranges.forEach(([a, b], i) => {
            assert.ok(minErrors(q, text.slice(a, b + 1), transposed) <= kmax, `range ${a}-${b} of ${JSON.stringify(text)} for ${JSON.stringify(q)}`);
            if (i) assert.ok(a > ranges[i - 1][1] + 1);
          });
          checked++;
        }));
      }
      assert.ok(checked > 50);
    });
  }

  test("every backend, every typing option, chunked queries and original indices run and agree", async () => {
    const r = rng(45), docs = randomDocs(r, 120), queries = randomQueries(r, stringsOf(docs, ["title"]), 20).filter(q => q.trim());
    const options = { keys: ["title", "tags"], indicesIn: "original", typing: { firstLetter: true, transposition: true }, ignoreDiacritics: true };
    const runs = [];
    for (const backend of BACKENDS) {
      const ff = await Fuseter.create(docs, { ...options, includeMatches: true, highlighting: { aligned: true, allOccurrences: true } }, { backend, fallback: "throw" });
      runs.push(queries.map(q => ff.search(q)));
    }
    for (const other of runs.slice(1)) assert.deepEqual(other, runs[0]);
  });
});

describe("indicesIn", () => {
  const search = async (docs, query, options = {}) => {
    const out = {};
    for (const indicesIn of ["normalized", "original"]) {
      const ff = await Fuseter.create(docs, { includeMatches: true, ignoreDiacritics: true, threshold: 0, indicesIn, ...options });
      out[indicesIn] = ff.search(query)[0].matches[0].indices;
    }
    return out;
  };

  test("ß becomes ss in the normalised text only", async () => {
    assert.deepEqual(await search(["Die Straße ist lang"], "strasse"), { normalized: [[4, 10]], original: [[4, 9]] });
  });

  test("a decomposed accent stays with its letter", async () => {
    assert.deepEqual(await search(["un cafe\u0301 au lait"], "cafe"), { normalized: [[3, 6]], original: [[3, 7]] });
    assert.deepEqual(await search(["cafe\u0301 au lait"], "au"), { normalized: [[5, 6]], original: [[6, 7]] });
  });

  test("astral characters and a length-changing lower-case", async () => {
    assert.deepEqual(await search(["😀 İstanbul rocks"], "rocks", { ignoreDiacritics: false }), { normalized: [[13, 17]], original: [[12, 16]] });
    assert.deepEqual(await search(["😀 ßx"], "ssx"), { normalized: [[3, 5]], original: [[3, 4]] });
  });

  test("identical to the normalised indices when normalising keeps the length", async () => {
    const r = rng(43), docs = JSON.parse(JSON.stringify(randomDocs(r, 150)).replaceAll("ß", "ss"));
    const create = indicesIn => Fuseter.create(docs, { keys: ["title", "author", "tags"], includeMatches: true, ignoreDiacritics: true, indicesIn });
    const [normalized, original] = [await create("normalized"), await create("original")];
    for (const q of ["harry", "the lord", "ñandu", "tolkin", "cafe naive", "strase"]) assert.deepEqual(original.search(q), normalized.search(q), q);
  });

  test("invalid values are rejected", async () => {
    await assert.rejects(Fuseter.create(["a"], { indicesIn: "raw" }), TypeError);
  });
});

describe("matches output", () => {
  test("shape: key, value, refIndex; not present without includeMatches, nor for a blank query", async () => {
    const docs = [{ title: "Old Man's War", tags: ["war", "space opera"], meta: { note: "war" } }];
    const ff = await Fuseter.create(docs, { keys: ["title", "tags", ["meta", "note"]], includeMatches: true, threshold: 0 });
    assert.deepEqual(ff.search("war")[0].matches, [
      { indices: [[10, 12]], value: "Old Man's War", key: "title" },
      { indices: [[0, 2]], value: "war", key: "tags", refIndex: 0 },
      { indices: [[0, 2]], value: "war", key: "meta.note" },
    ]);
    assert.equal(ff.search("  ")[0].matches, undefined);
    assert.equal((await Fuseter.create(docs, { keys: ["title"] })).search("war")[0].matches, undefined);
  });

  test("only the returned results are given matches, with a limit", async () => {
    const docs = Array.from({ length: 50 }, (_, i) => `item ${i} lord`);
    for (const backend of BACKENDS) {
      const ff = await Fuseter.create(docs, { includeMatches: true }, { backend });
      const hits = ff.search("lord", { limit: 3 });
      assert.equal(hits.length, 3);
      for (const hit of hits) assert.deepEqual(hit.matches.map(m => m.value), [hit.item]);
    }
  });
});
