import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Fuseter } from "../src/index.mjs";
import { rng, randomDocs, randomQueries, stringsOf, compare, fuseFor, randomText } from "./helpers.mjs";

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

  test("non-string queries are rejected", async () => {
    const ff = await Fuseter.create([{ a: "abc" }], { keys: ["a"] });
    assert.throws(() => ff.search({ a: "abc" }), TypeError);
  });

  test("score is omitted unless includeScore", async () => {
    const ff = await Fuseter.create([{ a: "abc" }], { keys: ["a"] });
    assert.deepEqual(Object.keys(ff.search("abc")[0]).sort(), ["item", "refIndex"]);
  });
});

