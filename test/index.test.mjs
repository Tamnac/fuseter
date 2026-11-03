import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fuse from "fuse.js";
import { Fuseter } from "../src/index.mjs";
import { rng, randomDocs, randomText, compare } from "./helpers.mjs";

const KEYS = [{ name: "title", weight: 3 }, "author", "tags", "meta.note"];
const options = { keys: KEYS, threshold: 0.4, includeScore: true };
const QUERIES = ["a", "harry potter", "lord of", "ñandu", "the rings", "x", "worn-spine"];

function same(ff, fuse, label) {
  for (const q of QUERIES) assert.equal(compare(ff.search(q), fuse.search(q)), null, `${label}: ${q}`);
}

describe("changing the collection like Fuse", () => {
  for (const backend of ["simd", "wasm", "js"]) {
    test(`add, remove, removeAt (${backend})`, async () => {
      const r = rng(61), mine = randomDocs(r, 150), theirs = [...mine], extra = randomDocs(r, 40);
      const ff = await Fuseter.create(mine, options, { backend }), fuse = new Fuse(theirs, { ...options, ignoreLocation: true });
      same(ff, fuse, "initial");

      for (const doc of [extra[0], null, undefined, extra[1]]) { ff.add(doc); fuse.add(doc); }
      assert.deepEqual(mine, theirs);
      assert.equal(ff.size, mine.length);
      same(ff, fuse, "after add");

      const predicate = (doc, i) => i % 7 === 3 || doc.title === "x";
      assert.deepEqual(ff.remove(predicate), fuse.remove(predicate));
      assert.deepEqual(ff.remove(), fuse.remove());
      same(ff, fuse, "after remove");

      assert.equal(ff.removeAt(5), fuse.removeAt(5));
      assert.equal(ff.removeAt(0), fuse.removeAt(0));
      same(ff, fuse, "after removeAt");

      for (const bad of [-1, 1.5, ff.size, "2", undefined]) assert.throws(() => ff.removeAt(bad), RangeError);
      assert.equal(ff.backend, backend);
      same(ff, fuse, "after a rejected removeAt");
    });
  }

  test("a string collection", async () => {
    const r = rng(62), mine = Array.from({ length: 100 }, () => randomText(r, 0, 4)), theirs = [...mine];
    const ff = await Fuseter.create(mine, { includeScore: true }), fuse = new Fuse(theirs, { ignoreLocation: true, includeScore: true });
    for (const doc of ["harry potter", "   ", "lord"]) { ff.add(doc); fuse.add(doc); }
    ff.removeAt(2); fuse.removeAt(2);
    for (const q of ["harry", "lord", "a"]) assert.equal(compare(ff.search(q), fuse.search(q)), null, q);
  });

  test("an empty collection can be filled", async () => {
    const ff = await Fuseter.create([], options), fuse = new Fuse([], { ...options, ignoreLocation: true });
    assert.deepEqual(ff.search("a"), []);
    for (const doc of randomDocs(rng(63), 30)) { ff.add(doc); fuse.add(doc); }
    same(ff, fuse, "filled");
  });
});

describe("indexes", () => {
  const docs = randomDocs(rng(64), 200);
  const viaJson = value => JSON.parse(JSON.stringify(value));

  test("an index made here loads in Fuse", async () => {
    const index = Fuseter.createIndex(KEYS, docs);
    const fuse = new Fuse(docs, { ...options, ignoreLocation: true }, Fuse.parseIndex(viaJson(index)));
    same(await Fuseter.create(docs, options), fuse, "fuseter index in fuse");
    assert.equal(index.size(), docs.length);
  });

  test("an index made by Fuse loads here, as data or as the object", async () => {
    const fuseIndex = Fuse.createIndex(KEYS, docs), fuse = new Fuse(docs, { ...options, ignoreLocation: true }, fuseIndex);
    for (const index of [Fuseter.parseIndex(viaJson(fuseIndex)), fuseIndex]) {
      for (const backend of ["simd", "js"]) same(await Fuseter.create(docs, options, { backend, index }), fuse, `fuse index in ${backend}`);
    }
    const ff = await Fuseter.create([], options);
    ff.setCollection(docs, Fuseter.parseIndex(viaJson(fuseIndex)));
    same(ff, fuse, "setCollection");
    same(Fuseter.createSync(docs, options, Fuseter.parseIndex(viaJson(fuseIndex))), fuse, "createSync");
  });

  test("the records are Fuse's (apart from empty arrays)", () => {
    const plain = docs.map(d => ({ ...d, tags: d.tags?.length ? d.tags : undefined }));
    assert.deepEqual(viaJson(Fuseter.createIndex(KEYS, plain)), viaJson(Fuse.createIndex(KEYS, plain)));
    const strings = Array.from({ length: 50 }, (_, i) => (i % 9 === 0 ? " " : `book ${i} ${i % 2 ? "red" : "blue sea"}`));
    assert.deepEqual(viaJson(Fuseter.createIndex([], strings)), viaJson(Fuse.createIndex([], strings)));
  });

  test("the norms of the index are used", async () => {
    const strings = ["alpha beta", "alpha", "beta gamma delta"], index = viaJson(Fuse.createIndex([], strings));
    index.records[1].n = 0.25;
    const fuse = new Fuse(strings, { ignoreLocation: true, includeScore: true }, Fuse.parseIndex(index));
    const ff = await Fuseter.create(strings, { includeScore: true }, { index: Fuseter.parseIndex(index) });
    assert.equal(compare(ff.search("alpa"), fuse.search("alpa")), null);
  });

  test("getIndex returns the given index, or one made from the current documents", async () => {
    const given = Fuseter.createIndex(KEYS, docs), ff = await Fuseter.create(docs, options, { index: given });
    assert.equal(ff.getIndex(), given);
    const fresh = await Fuseter.create([...docs], options), index = fresh.getIndex();
    assert.deepEqual(viaJson(index), viaJson(given));
    assert.equal(fresh.getIndex(), index);
    fresh.removeAt(0);
    assert.equal(fresh.getIndex().size(), docs.length - 1);
    const copy = await Fuseter.create(docs.slice(1), options, { index: Fuseter.parseIndex(viaJson(fresh.getIndex())) });
    same(copy, new Fuse(docs.slice(1), { ...options, ignoreLocation: true }), "round trip");
  });

  test("changes made to an instance created with an index", async () => {
    const mine = [...docs], ff = await Fuseter.create(mine, options, { index: Fuseter.createIndex(KEYS, mine) });
    ff.add(docs[0]); ff.removeAt(1);
    const expected = [...mine];
    same(ff, new Fuse(expected, { ...options, ignoreLocation: true }), "after changes");
  });

  test("an index object from Fuse is updated in place and getIndex wraps it", async () => {
    const mine = [...docs], fuseIndex = Fuse.createIndex(KEYS, mine), before = fuseIndex.records.length;
    const ff = await Fuseter.create(mine, options, { index: fuseIndex });
    ff.add(docs[0]);
    assert.equal(fuseIndex.records.length, before + 1);
    assert.equal(ff.getIndex().size(), before + 1);
    assert.deepEqual(ff.getIndex().toJSON().keys, Fuse.createIndex(KEYS, docs).toJSON().keys);
    ff.removeAt(0);
    assert.equal(fuseIndex.records.length, before);
  });

  test("a Fuse index keeps its getFn and norm for new documents", async () => {
    const getFn = (doc, path) => { const v = path.reduce((o, p) => o?.[p], doc); return typeof v === "string" ? v + " baz" : v; };
    const mine = randomDocs(rng(67), 60), theirs = [...mine], extra = randomDocs(rng(68), 5);
    const opts = { keys: ["title", "author"], includeScore: true };
    const ff = await Fuseter.create(mine, opts, { index: Fuse.createIndex(opts.keys, mine, { getFn, fieldNormWeight: 2 }) });
    const fuse = new Fuse(theirs, { ...opts, ignoreLocation: true }, Fuse.createIndex(opts.keys, theirs, { getFn, fieldNormWeight: 2 }));
    for (const doc of extra) { ff.add(doc); fuse.add(doc); }
    same(ff, fuse, "after add");
  });

  test("the keys of a string collection are kept", async () => {
    assert.deepEqual(viaJson(Fuseter.createIndex(["name"], ["first"])), viaJson(Fuse.createIndex(["name"], ["first"])));
    const ff = await Fuseter.create(["first"], { keys: ["name"] });
    ff.add({ name: "needle" }); ff.removeAt(0);
    assert.equal(ff.search("needle").length, 1);
  });

  test("invalid indexes are rejected", async () => {
    for (const bad of [{}, { keys: [] }, "{}", 5, { keys: {}, records: [] }]) {
      assert.throws(() => Fuseter.parseIndex(bad), TypeError);
      await assert.rejects(Fuseter.create(docs, options, { index: bad }), TypeError);
    }
    await assert.rejects(Fuseter.create(["a"], {}, { index: { keys: [], records: [{ v: "a", i: 3, n: 1 }] } }), RangeError);
  });
});

describe("indexed strings are what is searched, matched and sorted", () => {
  const docs = randomDocs(rng(65), 120), KEYS2 = ["title", "tags"];
  const suffix = (doc, path) => {
    const value = path.reduce((o, p) => o?.[p], doc);
    return typeof value === "string" ? value + " baz" : Array.isArray(value) ? value.map(v => (typeof v === "string" ? v + " baz" : v)) : value;
  };

  test("an index made with a getFn keeps working without it, also after changes", async () => {
    const opts = { keys: KEYS2, threshold: 0.4, includeScore: true, includeMatches: true };
    const mine = [...docs], theirs = [...docs];
    const ff = await Fuseter.create(mine, opts, { index: Fuseter.createIndex(KEYS2, mine, { getFn: suffix }) });
    const fuse = new Fuse(theirs, { ...opts, ignoreLocation: true }, Fuse.createIndex(KEYS2, theirs, { getFn: suffix }));
    same(ff, fuse, "index only");
    const extra = randomDocs(rng(66), 5);
    for (const doc of extra) { ff.add(doc); fuse.add(doc); }
    ff.removeAt(3); fuse.removeAt(3);
    same(ff, fuse, "after changes");
    assert.equal(ff.search("baz").length > 0, true);
  });

  test("getFn runs once per document and key", async () => {
    let calls = 0;
    const getFn = (doc, path) => { calls++; return path.reduce((o, p) => o?.[p], doc); };
    const ff = await Fuseter.create(docs, { keys: KEYS2, getFn, includeMatches: true });
    const built = calls;
    for (const q of ["a", "lord", "harry"]) ff.search(q);
    ff.search("a", { limit: 5 });
    assert.equal(calls, built);
    assert.equal(built, docs.length * KEYS2.length);
  });

  test("matches report the indexed strings with a getFn", async () => {
    const opts = { keys: KEYS2, getFn: suffix, includeMatches: true, includeScore: true };
    same(await Fuseter.create(docs, opts), new Fuse(docs, { ...opts, ignoreLocation: true }), "getFn");
  });

  test("{ v } records without a position", async () => {
    const getFn = doc => [{ v: doc.title }, { v: "second " + doc.title }];
    const opts = { keys: [{ name: "title", getFn }], includeMatches: true, includeScore: true };
    const ff = await Fuseter.create(docs, opts), fuse = new Fuse(docs, { ...opts, ignoreLocation: true });
    same(ff, fuse, "search");
    const index = Fuseter.createIndex(opts.keys, docs);
    assert.deepEqual(JSON.parse(JSON.stringify(index.records[0])).$[0].length, 2);
  });

  test("the weights are those of the options", async () => {
    const index = Fuse.createIndex([{ name: "title", weight: 3 }, "author"], docs), opts = { keys: [{ name: "title", weight: 2 }, "meta.note"], includeScore: true };
    same(await Fuseter.create(docs, opts, { index }), new Fuse(docs, { ...opts, ignoreLocation: true }, index), "options keys differ from the index");
    const onlyTitle = { keys: ["title"], includeScore: true };
    same(await Fuseter.create(docs, { ...onlyTitle, keys: ["title", "author"] }, { index: Fuse.createIndex(["title"], docs) }), new Fuse(docs, { ...onlyTitle, keys: ["title", "author"], ignoreLocation: true }, Fuse.createIndex(["title"], docs)), "index lacks a key");
  });

  test("sortFn gets Fuse's records and is ignored without shouldSort", async () => {
    const shapes = (set) => (a, b) => {
      for (const r of [a, b]) { set.add(Object.keys(r).join()); for (const m of r.matches) set.add(Object.keys(m).join()); }
      return a.score - b.score;
    };
    const mine = new Set(), theirs = new Set();
    const opts = { keys: ["title", "tags"], includeScore: true };
    (await Fuseter.create(docs, { ...opts, sortFn: shapes(mine) })).search("a");
    new Fuse(docs, { ...opts, ignoreLocation: true, sortFn: shapes(theirs) }).search("a");
    assert.deepEqual([...mine].sort(), [...theirs].sort());

    const reversed = (a, b) => b.idx - a.idx;
    const ff = await Fuseter.create(docs, { ...opts, shouldSort: false, sortFn: reversed });
    same(ff, new Fuse(docs, { ...opts, ignoreLocation: true, shouldSort: false, sortFn: reversed }), "shouldSort false");
  });

  test("Fuseter.config.getFn is Fuse's default getFn", async () => {
    for (const path of [["title"], ["tags"], ["meta", "note"], ["meta", "n"], ["nothing"]]) {
      for (const doc of docs) assert.deepEqual(Fuseter.config.getFn(doc, path), Fuse.config.getFn(doc, path));
    }
    const wrapped = (doc, path) => Fuseter.config.getFn(doc, path);
    const opts = { keys: ["title", "tags", "meta.note"], includeMatches: true, includeScore: true };
    same(await Fuseter.create(docs, { ...opts, getFn: wrapped }), new Fuse(docs, { ...opts, ignoreLocation: true }), "wrapped default");
  });
});

describe("static members", () => {
  test("version is the package version", () => {
    assert.equal(Fuseter.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });

  test("config holds the defaults of new instances", async () => {
    assert.equal(Fuseter.config.threshold, 0.6);
    const before = Fuseter.config.threshold;
    Fuseter.config.threshold = 0.1;
    try { assert.equal((await Fuseter.create(["abc"])).options.threshold, 0.1); } finally { Fuseter.config.threshold = before; }
  });
});
