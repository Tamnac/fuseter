import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Fuseter } from "../src/index.mjs";
import { rng, randomDocs, randomQueries, stringsOf, compare, fuseFor, randomText, edit } from "./helpers.mjs";

const BACKENDS = ["simd", "wasm", "js"];
const THRESHOLDS = [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1];

// Every query/threshold/limit must produce exactly Fuse's items, order and scores.
async function check(docs, options, queries, { thresholds = THRESHOLDS, limits = [undefined, 3] } = {}) {
  const instances = [];
  for (const backend of BACKENDS) {
    const ff = await Fuseter.create(docs, { ...options, includeScore: true }, { backend, fallback: "throw" });
    assert.equal(ff.backend, backend);
    instances.push(ff);
  }
  // Fuse is slow on chunked (> 32 chars) patterns, so those run at every other threshold; a limit is a prefix of the full ranking.
  for (const [t, threshold] of thresholds.entries()) {
    const fuse = fuseFor(docs, { ...options, threshold });
    for (const query of queries) {
      if (query.length > 32 && t % 2) continue;
      const full = fuse.search(query);
      for (const limit of limits) {
        const want = limit === undefined ? full : full.slice(0, Math.ceil(limit));
        for (const ff of instances) {
          const diff = compare(ff.search(query, { threshold, limit }), want);
          assert.equal(diff, null, `${ff.backend} threshold=${threshold} limit=${limit} query=${JSON.stringify(query)}: ${diff}`);
        }
      }
    }
  }
}

const KEYS = [{ name: "title", weight: 3 }, { name: "author", weight: 2 }, "meta.note"];

describe("matches Fuse (ignoreLocation: true)", () => {
  for (const seed of [1, 2, 3]) {
    test(`object docs, weighted keys, seed ${seed}`, async () => {
      const r = rng(seed), docs = randomDocs(r, 250);
      await check(docs, { keys: KEYS }, randomQueries(r, stringsOf(docs, ["title", "author"]), 40));
    });
  }

  test("array values and nested paths", async () => {
    const r = rng(11), docs = randomDocs(r, 250);
    await check(docs, { keys: ["title", "tags", ["meta", "note"]] }, randomQueries(r, stringsOf(docs, ["title", "author"]), 30));
  });

  test("string collection", async () => {
    const r = rng(12), docs = Array.from({ length: 300 }, () => randomText(r, 0, 5));
    await check(docs, {}, randomQueries(r, docs, 40));
  });

  test("single key, no field norm", async () => {
    const r = rng(13), docs = randomDocs(r, 250);
    await check(docs, { keys: ["title"], ignoreFieldNorm: true }, randomQueries(r, stringsOf(docs, ["title"]), 30));
  });

  for (const fieldNormWeight of [0, 0.5, 2]) {
    test(`fieldNormWeight ${fieldNormWeight}`, async () => {
      const r = rng(14), docs = randomDocs(r, 200);
      await check(docs, { keys: KEYS, fieldNormWeight }, randomQueries(r, stringsOf(docs, ["title"]), 20), { thresholds: [0.3, 0.7] });
    });
  }

  test("isCaseSensitive", async () => {
    const r = rng(15), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, isCaseSensitive: true }, randomQueries(r, stringsOf(docs, ["title", "author"]), 30), { thresholds: [0.2, 0.5] });
  });

  test("ignoreDiacritics", async () => {
    const r = rng(16), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ignoreDiacritics: true }, ["naivé", "Cafe", "ORSTED", "strasse", "lodz", "ñandu", ...randomQueries(r, stringsOf(docs, ["title"]), 25)], { thresholds: [0.2, 0.5] });
  });

  test("more than 255 distinct field norms (simd combines in js)", async () => {
    const r = rng(17), docs = Array.from({ length: 300 }, (_, i) => ({ body: Array.from({ length: 1 + i }, () => r.pick(["lorem", "ipsum", "dolor", "sit"])).join(" ") }));
    await check(docs, { keys: ["body"] }, ["lorem ipsum", "dolor sit amet", "ipsm"], { thresholds: [0.3, 0.6] });
  });

  test("empty and tiny collections", async () => {
    await check([], { keys: ["a"] }, ["x", "abc"], { thresholds: [0.6] });
    await check([{ a: "x" }], { keys: ["a"] }, ["x", "abc"], { thresholds: [0.6] });
    await check(["only"], {}, ["only", "onl"], { thresholds: [0.6] });
  });

  const booksPath = new URL("../../books_raw.json", import.meta.url);
  test("real book titles", { skip: !existsSync(booksPath) }, async () => {
    const books = JSON.parse(readFileSync(booksPath, "utf8")).slice(0, 3000);
    await check(books, { keys: [{ name: "title", weight: 3 }, "author"] }, ["Harry Potter", "pride and prej", "the hobitt", "Stephn King", "Tolkein", "the lord of the rings the fe", "war & peace"], { thresholds: [0.1, 0.3, 0.6] });
  });
});

describe("includeMatches matches Fuse", () => {
  const MATCHES = { includeMatches: true };

  test("object docs, weighted keys", async () => {
    const r = rng(31), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...MATCHES }, randomQueries(r, stringsOf(docs, ["title", "author"]), 40));
  });

  test("array values and nested paths (refIndex)", async () => {
    const r = rng(32), docs = randomDocs(r, 250);
    await check(docs, { keys: ["title", "tags", ["meta", "note"], "meta.n"], ...MATCHES }, randomQueries(r, stringsOf(docs, ["title", "author"]), 30));
  });

  test("arrays of objects", async () => {
    const r = rng(33), docs = Array.from({ length: 150 }, () => ({ people: Array.from({ length: r.int(4) }, () => ({ name: randomText(r, 1, 2), aliases: [randomText(r, 1, 2), null, randomText(r, 1, 1)] })) }));
    await check(docs, { keys: ["people.name", "people.aliases"], ...MATCHES }, randomQueries(r, docs.flatMap(d => d.people.map(p => p.name)), 30), { thresholds: [0.2, 0.5] });
  });

  test("string collection", async () => {
    const r = rng(34), docs = Array.from({ length: 300 }, () => randomText(r, 0, 5));
    await check(docs, MATCHES, randomQueries(r, docs, 40));
  });

  test("isCaseSensitive", async () => {
    const r = rng(35), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, isCaseSensitive: true, ...MATCHES }, randomQueries(r, stringsOf(docs, ["title", "author"]), 30), { thresholds: [0.2, 0.5] });
  });

  test("ignoreDiacritics (indices into the normalised text)", async () => {
    const r = rng(36), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ignoreDiacritics: true, ...MATCHES }, ["naivé", "Cafe", "ORSTED", "strasse", "lodz", ...randomQueries(r, stringsOf(docs, ["title"]), 25)], { thresholds: [0.2, 0.5] });
  });

  test("no field norm, long patterns", async () => {
    const r = rng(37), docs = randomDocs(r, 200);
    await check(docs, { keys: ["title", "meta.note"], ignoreFieldNorm: true, ...MATCHES }, randomQueries(r, stringsOf(docs, ["title"]), 20), { thresholds: [0.3, 0.7] });
  });
});

describe("ignoreLocation: false matches Fuse", () => {
  const LOCATED = { ignoreLocation: false };
  const queries = (r, docs, count) => randomQueries(r, stringsOf(docs, ["title", "author"]), count);

  test("defaults (location 0, distance 100)", async () => {
    const r = rng(71), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...LOCATED }, queries(r, docs, 40));
  });

  for (const [location, distance] of [[0, 10], [5, 30], [20, 1000], [100, 100], [3, 0], [-4, 50]]) {
    test(`location ${location}, distance ${distance}`, async () => {
      const r = rng(72 + location + distance), docs = randomDocs(r, 200);
      await check(docs, { keys: ["title", "tags", ["meta", "note"]], ...LOCATED, location, distance }, queries(r, docs, 30), { thresholds: [0.1, 0.3, 0.6, 1] });
    });
  }

  test("findAllMatches", async () => {
    const r = rng(73), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...LOCATED, findAllMatches: true, distance: 20 }, queries(r, docs, 30), { thresholds: [0.2, 0.5, 0.8] });
  });

  test("string collection, long texts", async () => {
    const r = rng(74), docs = Array.from({ length: 200 }, () => randomText(r, 0, 25));
    await check(docs, { ...LOCATED, distance: 60 }, randomQueries(r, docs, 40), { thresholds: [0.2, 0.5, 0.9] });
  });

  test("no field norm, isCaseSensitive, ignoreDiacritics", async () => {
    const r = rng(75), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...LOCATED, ignoreFieldNorm: true, isCaseSensitive: true, location: 4 }, queries(r, docs, 25), { thresholds: [0.2, 0.5] });
    await check(docs, { keys: KEYS, ...LOCATED, ignoreDiacritics: true }, ["naivé", "Cafe", "ORSTED", "lodz", ...queries(r, docs, 25)], { thresholds: [0.2, 0.5] });
  });

  test("includeMatches", async () => {
    const r = rng(76), docs = randomDocs(r, 250);
    await check(docs, { keys: ["title", "tags", ["meta", "note"]], ...LOCATED, includeMatches: true, location: 6, distance: 40 }, queries(r, docs, 35), { thresholds: [0.2, 0.5, 0.8] });
    const strings = Array.from({ length: 250 }, () => randomText(r, 0, 12));
    await check(strings, { ...LOCATED, includeMatches: true }, randomQueries(r, strings, 35), { thresholds: [0.3, 0.7] });
  });

  for (const minMatchCharLength of [2, 4]) {
    test(`minMatchCharLength ${minMatchCharLength}`, async () => {
      const r = rng(77 + minMatchCharLength), docs = randomDocs(r, 250);
      await check(docs, { keys: KEYS, ...LOCATED, minMatchCharLength }, queries(r, docs, 35), { thresholds: [0.1, 0.3, 0.6] });
      await check(docs, { keys: ["title", "tags"], ...LOCATED, minMatchCharLength, includeMatches: true, location: 2 }, queries(r, docs, 35), { thresholds: [0.1, 0.3, 0.6] });
    });
  }

  test("sortFn, shouldSort: false", async () => {
    const r = rng(79), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...LOCATED, sortFn: (a, b) => b.score - a.score, includeMatches: true }, queries(r, docs, 20), { thresholds: [0.3, 0.7] });
    await check(docs, { keys: KEYS, ...LOCATED, shouldSort: false }, queries(r, docs, 20), { thresholds: [0.3, 0.7], limits: [undefined, 3] });
  });

  test("token search keeps ignoreLocation on for its terms", async () => {
    const r = rng(80), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...LOCATED, useTokenSearch: true, location: 10 }, [...queries(r, docs, 20), "lord rings", "wen co"], { thresholds: [0.3, 0.6] });
  });
});

describe("limit and query handling", () => {
  test("limit follows Fuse", async () => {
    const docs = randomDocs(rng(21), 100), fuse = fuseFor(docs, { keys: ["title"] });
    const ff = await Fuseter.create(docs, { keys: ["title"], includeScore: true });
    for (const limit of [0, 1, 2.7, 1000, -1, Infinity, undefined]) {
      assert.equal(compare(ff.search("a", { limit }), fuse.search("a", { limit })), null, `limit ${limit}`);
    }
  });

  test("blank query returns every document, like Fuse", async () => {
    const docs = [{ a: "abc" }, { a: "xyz" }, {}], ff = await Fuseter.create(docs, { keys: ["a"], includeScore: true });
    assert.deepEqual(ff.search(" "), [{ item: docs[0], refIndex: 0 }, { item: docs[1], refIndex: 1 }, { item: docs[2], refIndex: 2 }]);
    assert.deepEqual(ff.search("", { limit: 1 }), [{ item: docs[0], refIndex: 0 }]);
  });

  test("queries that are neither strings nor logical queries are rejected", async () => {
    const ff = await Fuseter.create([{ a: "abc" }], { keys: ["a"] });
    for (const query of [null, 5, undefined, true]) assert.throws(() => ff.search(query), TypeError);
    assert.throws(() => ff.search({ a: 5 }), TypeError);
    assert.throws(() => ff.search({ $and: [{ a: {} }] }), TypeError);
  });

  test("score is omitted unless includeScore", async () => {
    const ff = await Fuseter.create([{ a: "abc" }], { keys: ["a"] });
    assert.deepEqual(Object.keys(ff.search("abc")[0]).sort(), ["item", "refIndex"]);
  });
});


describe("ordering and matching options match Fuse", () => {
  const queries = (r, docs, count) => randomQueries(r, stringsOf(docs, ["title", "author"]), count);

  test("shouldSort: false", async () => {
    const r = rng(41), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, shouldSort: false }, queries(r, docs, 30), { limits: [undefined, 3, 0] });
    const strings = Array.from({ length: 200 }, () => randomText(r, 0, 5));
    await check(strings, { shouldSort: false, includeMatches: true }, randomQueries(r, strings, 20), { thresholds: [0.3, 0.7] });
  });

  test("sortFn", async () => {
    const r = rng(42), docs = randomDocs(r, 250);
    const byLength = (a, b) => b.matches[0].value.length - a.matches[0].value.length || b.score - a.score;
    const byShape = (a, b) => JSON.stringify(a.matches).localeCompare(JSON.stringify(b.matches));   // fails unless the records are Fuse's
    for (const sortFn of [byLength, byShape, (a, b) => b.score - a.score, (a, b) => String(b.item[0]?.v).localeCompare(String(a.item[0]?.v))]) {
      await check(docs, { keys: KEYS, sortFn }, queries(r, docs, 20), { thresholds: [0.3, 0.7], limits: [undefined, 3] });
      await check(docs, { keys: ["title", "tags"], sortFn, includeMatches: true }, queries(r, docs, 20), { thresholds: [0.3, 0.7], limits: [undefined, 5] });
    }
    const strings = Array.from({ length: 200 }, () => randomText(r, 0, 5));
    await check(strings, { sortFn: byShape }, randomQueries(r, strings, 20), { thresholds: [0.3, 0.7] });
  });

  test("limit with shouldSort: false and sortFn follows Fuse", async () => {
    const docs = randomDocs(rng(53), 100);
    for (const extra of [{ shouldSort: false }, { sortFn: (a, b) => b.score - a.score }]) {
      const options = { keys: ["title"], ...extra }, fuse = fuseFor(docs, options), ff = await Fuseter.create(docs, { ...options, includeScore: true });
      for (const limit of [0, 1, 2.7, 1000, -1, Infinity, undefined]) assert.equal(compare(ff.search("a", { limit }), fuse.search("a", { limit })), null, `${Object.keys(extra)} limit ${limit}`);
    }
  });

  for (const minMatchCharLength of [2, 3, 5]) {
    test(`minMatchCharLength ${minMatchCharLength}`, async () => {
      const r = rng(43 + minMatchCharLength), docs = randomDocs(r, 250);
      await check(docs, { keys: KEYS, minMatchCharLength }, queries(r, docs, 40), { thresholds: [0.1, 0.3, 0.6] });
      await check(docs, { keys: ["title", "tags"], minMatchCharLength, includeMatches: true }, queries(r, docs, 40), { thresholds: [0.1, 0.3, 0.6] });
    });
  }

  test("minMatchCharLength on a string collection, with shouldSort: false", async () => {
    const r = rng(50), docs = Array.from({ length: 300 }, () => randomText(r, 0, 5));
    await check(docs, { minMatchCharLength: 3, shouldSort: false, includeMatches: true }, ["a", "x", "ab", "abc", ...randomQueries(r, docs, 40)], { thresholds: [0.2, 0.6] });
  });

  test("findAllMatches has no effect with ignoreLocation", async () => {
    const r = rng(51), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, findAllMatches: true, includeMatches: true }, queries(r, docs, 40), { thresholds: [0.2, 0.5, 0.8] });
  });

  test("getFn and per-key getFn", async () => {
    const r = rng(52), docs = randomDocs(r, 250);
    const upper = doc => doc?.title == null ? undefined : String(doc.title).toUpperCase() + " x";
    const spread = doc => [doc.author, null, { v: doc.title, i: 7 }, { v: 42 }, 17, ["nested"], doc.tags?.[0]];
    const keys = [{ name: "title", getFn: upper, weight: 2 }, { name: "author", getFn: spread }, { name: ["meta", "note"] }, "tags"];
    const getFn = (doc, path) => { const v = path.reduce((o, p) => o?.[p], doc); return typeof v === "string" ? v.split(" ").reverse().join(" ") : Array.isArray(v) ? v.map(String) : v; };
    await check(docs, { keys, includeMatches: true }, queries(r, docs, 30), { thresholds: [0.2, 0.5] });
    await check(docs, { keys, getFn, includeMatches: true }, queries(r, docs, 30), { thresholds: [0.2, 0.5] });
  });
});

describe("token search matches Fuse", () => {
  const TOKENS = { useTokenSearch: true };
  const queries = (r, strings, count) => [...randomQueries(r, strings, count), "lord rings", "the the", "wen co", "r2 d2 1984", "!!!", "x  b a", "straße café", "dust-jacket worn_spine"];
  const objectStrings = docs => stringsOf(docs, ["title", "author"]);
  const thresholds = [0.1, 0.3, 0.6, 1];

  for (const tokenMatch of ["any", "all"]) {
    test(`object docs, weighted keys, tokenMatch ${tokenMatch}`, async () => {
      const r = rng(61), docs = randomDocs(r, 250);
      await check(docs, { keys: KEYS, ...TOKENS, tokenMatch }, queries(r, objectStrings(docs), 30), { thresholds });
    });

    test(`array values, matches, tokenMatch ${tokenMatch}`, async () => {
      const r = rng(62), docs = randomDocs(r, 250);
      await check(docs, { keys: ["title", "tags", ["meta", "note"]], includeMatches: true, ...TOKENS, tokenMatch }, queries(r, objectStrings(docs), 25), { thresholds: [0.2, 0.5] });
    });

    test(`string collection, tokenMatch ${tokenMatch}`, async () => {
      const r = rng(63), docs = Array.from({ length: 300 }, () => randomText(r, 0, 5));
      await check(docs, { includeMatches: true, ...TOKENS, tokenMatch }, queries(r, docs, 30), { thresholds });
    });
  }

  test("normalisation options and no field norm", async () => {
    const r = rng(64), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...TOKENS, isCaseSensitive: true, ignoreFieldNorm: true }, queries(r, objectStrings(docs), 20), { thresholds: [0.2, 0.5] });
    await check(docs, { keys: KEYS, ...TOKENS, ignoreDiacritics: true, includeMatches: true }, [...queries(r, objectStrings(docs), 20), "naivé cafe", "ORSTED lodz"], { thresholds: [0.2, 0.5] });
  });

  test("minMatchCharLength, sortFn, shouldSort: false", async () => {
    const r = rng(65), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...TOKENS, minMatchCharLength: 3, includeMatches: true }, queries(r, objectStrings(docs), 25), { thresholds: [0.2, 0.6] });
    await check(docs, { keys: KEYS, ...TOKENS, sortFn: (a, b) => b.score - a.score, includeMatches: true }, queries(r, objectStrings(docs), 20), { thresholds: [0.3, 0.7] });
    await check(docs, { keys: KEYS, ...TOKENS, shouldSort: false }, queries(r, objectStrings(docs), 20), { thresholds: [0.3, 0.7], limits: [undefined, 3] });
  });

  test("repeated terms", async () => {
    const r = rng(67), docs = randomDocs(r, 250), long = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnop";
    const base = objectStrings(docs), repeated = randomQueries(r, base, 15).map(q => { const [w = "lord"] = q.split(" "); return `${w} lord ${w} rings ${w}`; });
    for (const tokenMatch of ["any", "all"]) await check(docs, { keys: KEYS, ...TOKENS, tokenMatch }, [...repeated, `${long} lord ${long} ${long}`, "a b a c a"], { thresholds: [0.3, 0.6] });
  });

  test("custom tokenizers, terms over 32 characters", async () => {
    const r = rng(66), docs = randomDocs(r, 250);
    const long = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnop";
    for (const tokenize of [/[^s-]+/g, text => text.split(/s+/).filter(Boolean), text => [...text.matchAll(/[a-z]{2,}/g)].map(m => m[0].toUpperCase())]) {
      await check(docs, { keys: KEYS, ...TOKENS, tokenize, tokenMatch: "all" }, [...queries(r, objectStrings(docs), 15), `lord ${long}`], { thresholds: [0.3, 0.6] });
    }
  });

  test("collection changes keep the document frequencies current", async () => {
    const r = rng(67), docs = randomDocs(r, 120), options = { keys: KEYS, ...TOKENS };
    const ff = await Fuseter.create(docs, { ...options, includeScore: true }), fuse = fuseFor([...docs], options);   // add pushes onto the array it was given
    for (const [change, args] of [["add", [{ title: "the lord of the rings", author: "Tolkien" }]], ["removeAt", [3]], ["remove", [(d, i) => i % 5 === 0]]]) {
      ff[change](...args); fuse[change](...args);
      for (const q of ["lord rings", "tolkien", "harry potter"]) assert.equal(compare(ff.search(q), fuse.search(q)), null, `${change} ${q}`);
    }
  });
});

describe("extended search matches Fuse", () => {
  const EXTENDED = { useExtendedSearch: true };
  const FIXED = ["lord | harry", "'lord !rings", "^the lord$", "=the | =hobbit", "!^the", "!hobbit$", "'\"the lord\" | ^\"dust jacket\"$", "\"worn-spine\"", "lord\\|rings", "|", "' !", "=", "^", "$ !x", "stephen !king | agatha !christie", "!a", "!\"dust jacket\" lord"];
  // Operators applied to fragments of the documents' own text, so that most queries have hits.
  const queries = (r, strings, count) => {
    const ops = ["", "'", "^", "=", "!", "!^"], tails = ["", "", "$", "$", "$"], out = [...FIXED];
    const piece = () => { const s = r.pick(strings); const word = s.split(/s+/)[0] ?? ""; return r.int(3) ? edit(r, word) : s.slice(0, 1 + r.int(8)); };
    while (out.length < count) {
      const group = () => Array.from({ length: 1 + r.int(3) }, () => { const text = piece(); return text ? r.pick(ops) + (text.includes(" ") ? `"${text}"` : text) + r.pick(tails) : "a"; }).join(" ");
      out.push(Array.from({ length: 1 + r.int(3) }, group).join(r.int(2) ? " | " : "|"));
    }
    return out;
  };
  const objectStrings = docs => stringsOf(docs, ["title", "author"]);
  const thresholds = [0, 0.2, 0.4, 0.7];

  test("object docs, weighted keys", async () => {
    const r = rng(91), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...EXTENDED }, queries(r, objectStrings(docs), 80), { thresholds });
  });

  test("array values with matches", async () => {
    const r = rng(92), docs = randomDocs(r, 250);
    await check(docs, { keys: ["title", "tags", ["meta", "note"]], includeMatches: true, ...EXTENDED }, queries(r, objectStrings(docs), 60), { thresholds: [0.2, 0.5] });
  });

  test("string collection with matches", async () => {
    const r = rng(93), docs = Array.from({ length: 300 }, () => randomText(r, 0, 5));
    await check(docs, { includeMatches: true, ...EXTENDED }, queries(r, docs, 60), { thresholds });
  });

  test("normalisation options and no field norm", async () => {
    const r = rng(94), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...EXTENDED, isCaseSensitive: true, ignoreFieldNorm: true }, queries(r, objectStrings(docs), 40), { thresholds: [0.2, 0.5] });
    await check(docs, { keys: KEYS, ...EXTENDED, ignoreDiacritics: true, includeMatches: true }, [...queries(r, objectStrings(docs), 40), "=cafe | 'naivé", "^orsted !lodz$"], { thresholds: [0.2, 0.5] });
  });

  test("minMatchCharLength, sortFn, shouldSort: false, chunked patterns", async () => {
    const r = rng(95), docs = randomDocs(r, 250), long = "the lord of the rings the fellowship of the ring and more";
    await check(docs, { keys: KEYS, ...EXTENDED, minMatchCharLength: 3, includeMatches: true }, queries(r, objectStrings(docs), 40), { thresholds: [0.2, 0.6] });
    await check(docs, { keys: KEYS, ...EXTENDED, sortFn: (a, b) => b.score - a.score, includeMatches: true }, queries(r, objectStrings(docs), 30), { thresholds: [0.3, 0.7] });
    await check(docs, { keys: KEYS, ...EXTENDED, shouldSort: false }, queries(r, objectStrings(docs), 30), { thresholds: [0.3, 0.7] });
    await check(docs, { keys: KEYS, ...EXTENDED, includeMatches: true }, [`${long} | 'lord`, `'lord "${long}"`], { thresholds: [0.3, 0.6] });
  });

  test("location scoring", async () => {
    const r = rng(96), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...EXTENDED, ignoreLocation: false, includeMatches: true, location: 3, distance: 40 }, queries(r, objectStrings(docs), 40), { thresholds: [0.3, 0.6] });
  });

  test("substrings across string boundaries, at the ends, and longer than the wasm search takes", async () => {
    const docs = ["ab", "cd", "", "abcd", "a", "b", "xabcdabcd", "dc", "ñandú", "abababab", "a".repeat(1500), "b".repeat(9), "ab".repeat(40)];
    await check(docs, { includeMatches: true, ...EXTENDED }, ["'bc", "'a", "'d", "'abcd", "'cdab", "'ñ", "'ú", "!'a", "'bb !a", "'aba", "'ab 'ba", `'${"a".repeat(1100)}`, `!${"a".repeat(1100)}`, `'${"ab".repeat(40)}`], { thresholds: [0, 0.4] });
  });

  test("large candidate lists (driver choice, scans of a few strings)", async () => {
    const r = rng(99), docs = Array.from({ length: 1500 }, (_, i) => `${i % 5 === 0 ? "zebra" : "the"} ${randomText(r, 1, 4)}`);
    await check(docs, { includeMatches: true, ...EXTENDED }, ["^the ring", "^zebra 'ring", "^zebra 'ring !hobbit$", "^the lord", "^zebra hary", "'the hary !x", "^the 'lord !hobbit", "the$ 'harry", "^the 'a | 'zzz", "'x ^the | ^zebra potter", "'hobbit zebra", "^the lord hary", "^the ring hobbit !x", "^zebra lord potter", "hary poter | ^the lrod ring"], { thresholds: [0.2, 0.5] });
  });

  test("takes precedence over token search", async () => {
    const r = rng(97), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS, ...EXTENDED, useTokenSearch: true }, [...queries(r, objectStrings(docs), 30), "lord rings"], { thresholds: [0.3] });
  });

  test("collection changes", async () => {
    const r = rng(98), docs = randomDocs(r, 120), options = { keys: KEYS, ...EXTENDED };
    const ff = await Fuseter.create(docs, { ...options, includeScore: true }), fuse = fuseFor([...docs], options);
    for (const [change, args] of [["add", [{ title: "the lord of the rings", author: "Tolkien" }]], ["removeAt", [3]], ["remove", [(d, i) => i % 5 === 0]]]) {
      ff[change](...args); fuse[change](...args);
      for (const q of ["'lord !rings", "^tolkien | =harry", "!the"]) assert.equal(compare(ff.search(q), fuse.search(q)), null, `${change} ${q}`);
    }
  });
});

describe("logical queries match Fuse", () => {
  // Leaves cut from the documents' own text, combined at random into $and / $or trees and plain key objects.
  const queries = (r, strings, count, keys) => {
    const piece = () => { const s = r.pick(strings); return r.int(3) ? edit(r, s.split(/s+/)[0] ?? "") || "a" : s.slice(0, 1 + r.int(8)) || "a"; };
    const leaf = () => {
      const roll = r.int(6);
      if (roll === 0) return piece();
      if (roll === 1) return { $path: r.pick(keys), $val: piece() };
      if (roll === 2) return { $path: r.pick(keys).split("."), $val: piece() };
      return { [r.pick(keys)]: piece() };
    };
    const node = depth => {
      const roll = r.int(depth > 2 ? 1 : 3);
      if (roll === 0) return leaf();
      return { [r.int(2) ? "$and" : "$or"]: Array.from({ length: r.int(4) }, () => node(depth + 1)) };
    };
    const out = [{ title: "lord", author: "tolkien" }, { $and: [{ title: "lord" }, { $or: [{ author: "tolkien" }, "ring"] }] }, { $or: [] }, { $and: [] }, {}, "lord",
      { $or: [{ title: "lord" }, { title: "lord" }] }, { $and: [{ title: "the" }, { title: "the" }] }, { nothere: "lord" }, { title: "" }, { $or: [{ title: "x" }], $and: [{ author: "a" }] }];
    while (out.length < count) out.push({ [r.int(2) ? "$and" : "$or"]: Array.from({ length: 1 + r.int(3) }, () => node(1)) });
    return out;
  };
  const KEYS = [{ name: "title", weight: 3 }, { name: "author", weight: 2 }, "tags", "meta.note"], PATHS = ["title", "author", "tags", "meta.note", "missing"];
  const strings = docs => stringsOf(docs, ["title", "author"]);

  test("object docs, weighted keys, array values", async () => {
    const r = rng(111), docs = randomDocs(r, 250);
    await check(docs, { keys: KEYS }, queries(r, strings(docs), 100, PATHS), { thresholds: [0.2, 0.4, 0.7] });
  });

  test("includeMatches, shouldSort: false, sortFn, no field norm", async () => {
    const r = rng(112), docs = randomDocs(r, 250), qs = queries(r, strings(docs), 60, PATHS), thresholds = [0.3, 0.6];
    await check(docs, { keys: KEYS, includeMatches: true }, qs, { thresholds });
    await check(docs, { keys: KEYS, includeMatches: true, shouldSort: false }, qs, { thresholds });
    await check(docs, { keys: KEYS, includeMatches: true, sortFn: (a, b) => b.score - a.score }, qs, { thresholds });
    await check(docs, { keys: KEYS, ignoreFieldNorm: true, minMatchCharLength: 3, includeMatches: true }, qs, { thresholds });
    await check(docs, { keys: KEYS, isCaseSensitive: true, ignoreDiacritics: true, includeMatches: true }, qs, { thresholds });
  });

  test("location scoring", async () => {
    const r = rng(113), docs = randomDocs(r, 200);
    await check(docs, { keys: KEYS, ignoreLocation: false, includeMatches: true, location: 3, distance: 40 }, queries(r, strings(docs), 40, PATHS), { thresholds: [0.3, 0.6] });
  });

  test("extended search", async () => {
    const r = rng(114), docs = randomDocs(r, 250), qs = queries(r, strings(docs), 60, PATHS).concat([
      { title: "^the | 'lord" }, { $and: [{ title: "!hobbit" }, { author: "'king" }] }, { $or: ["=hobbit", { tags: "!^the lord$" }] }, { author: "!a" }]);
    await check(docs, { keys: KEYS, useExtendedSearch: true, includeMatches: true }, qs, { thresholds: [0.2, 0.5] });
    await check(docs, { keys: KEYS, useExtendedSearch: true, sortFn: (a, b) => b.score - a.score, includeMatches: true }, qs, { thresholds: [0.3] });
  });

  // Fuse 7.5 throws on logical queries with token search, so a leaf is compared with the plain query it stands for. The documents of tokenMatch "all" are not dropped.
  test("token search", async () => {
    const r = rng(115), docs = randomDocs(r, 250);
    for (const backend of BACKENDS) {
      const options = { keys: ["title"], useTokenSearch: true, includeScore: true, includeMatches: true, threshold: 0.4 };
      const ff = await Fuseter.create(docs, options, { backend, fallback: "throw" });
      const all = await Fuseter.create(docs, { ...options, tokenMatch: "all" }, { backend, fallback: "throw" });
      for (const query of ["lord rings", "the of", "harry potter prisoner", "zzz"]) {
        assert.deepEqual(ff.search({ title: query }), ff.search(query));
        assert.deepEqual(ff.search({ $or: [{ $path: "title", $val: query }] }), ff.search(query));
        assert.deepEqual(all.search({ title: query }), ff.search(query));
      }
    }
  });

  test("string collections have no logical matches", async () => {
    const r = rng(116), docs = Array.from({ length: 50 }, () => randomText(r, 1, 4));
    await check(docs, {}, [{ $or: ["lord", "ring"] }, "lord"], { thresholds: [0.4] });
  });

  test("limits", async () => {
    const r = rng(117), docs = randomDocs(r, 100);
    await check(docs, { keys: KEYS }, [{ $or: [{ title: "the" }, { author: "a" }] }], { thresholds: [0.4], limits: [undefined, 0, 1, 7, 1000] });
  });
});
