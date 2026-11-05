import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Fuse from "fuse.js";
import { Fuseter } from "../src/index.mjs";
import { rng, randomText } from "./helpers.mjs";

// Fuse is compared with ignoreLocation: true, the default here.
const LOCATION = { ignoreLocation: true };

describe("Fuseter.match", () => {
  const r = rng(201), texts = Array.from({ length: 25 }, () => randomText(r, 1, 6)).concat(["", "x", "Straße"]);
  const patterns = ["lord", "hobit", "the rings", " ", "  ", "'lord", "^the", "!hobbit", "=hobbit", "potter | rings", "ss", "a", "", "a pattern that is longer than thirty-two characters"];
  const configs = [{}, { includeMatches: true }, { useExtendedSearch: true, includeMatches: true }, { threshold: 0.3, minMatchCharLength: 2, includeMatches: true },
    { isCaseSensitive: true, ignoreDiacritics: true, includeMatches: true }, { ignoreLocation: false, location: 4, distance: 20, includeMatches: true }];

  test("matches Fuse.match", () => {
    for (const config of configs) for (const pattern of patterns) for (const text of texts) {
      if (!text) continue;   // blank strings are not indexed, so a search never reaches one
      const options = { ...LOCATION, ...config }, want = Fuse.match(pattern, text, options);
      delete want.hasInverse;
      assert.deepEqual(Fuseter.match(pattern, text, options), want, `${JSON.stringify(config)} ${JSON.stringify(pattern)} in ${JSON.stringify(text)}`);
    }
  });

  test("token search is rejected, as in Fuse", () => {
    assert.throws(() => Fuseter.match("lord", "the lord", { useTokenSearch: true }), /useTokenSearch/);
    Fuseter.config.useTokenSearch = true;
    try { assert.throws(() => Fuseter.match("lord", "the lord"), /useTokenSearch/); } finally { Fuseter.config.useTokenSearch = false; }
  });
});

describe("Fuseter.parseQuery", () => {
  const queries = [{ title: "a" }, { $and: [{ title: "a" }, { $or: [{ $path: ["x", "y"], $val: "b" }, "c"] }] }, { a: "x", b: "y" }, { $or: ["lord", { $and: [{ k: "1" }] }] }];

  test("builds Fuse's tree", () => {
    for (const query of queries) assert.deepEqual(Fuseter.parseQuery(query, {}, { auto: false }), Fuse.parseQuery(query, {}, { auto: false }));
  });

  test("leaves get a searcher by default", () => {
    const [leaf] = Fuseter.parseQuery({ title: "lord" }, LOCATION).children, [want] = Fuse.parseQuery({ title: "lord" }, LOCATION).children;
    assert.deepEqual(Object.keys(leaf), Object.keys(want));
    for (const text of ["the lord", "lard", "nothing"]) assert.deepEqual(leaf.searcher.searchIn(text), want.searcher.searchIn(text));
    assert.equal(Fuseter.parseQuery({ title: "lord" }, LOCATION, { auto: false }).children[0].searcher, undefined);
  });

  test("a leaf keeps the searcher chosen when it was parsed", () => {
    const [leaf] = Fuseter.parseQuery({ title: "zzqq" }, LOCATION).children;
    Fuseter.use(class { static condition(pattern) { return pattern === "zzqq"; } searchIn() { return { isMatch: false, score: 1 }; } });
    assert.equal(leaf.searcher.searchIn("zzqq").isMatch, true);
  });

  test("invalid queries are rejected", () => {
    assert.throws(() => Fuseter.parseQuery({ title: 5 }), TypeError);
    assert.throws(() => Fuseter.parseQuery(null), TypeError);
  });
});

// A searcher for patterns starting with "~": the text includes the pattern ("~!": it does not, which counts as an inverse match).
class Includes {
  static condition(pattern) { return pattern.startsWith("~"); }
  constructor(pattern) { this.inverse = pattern.startsWith("~!"); this.pattern = pattern.slice(this.inverse ? 2 : 1); }
  searchIn(text) {
    const at = text.toLowerCase().indexOf(this.pattern);
    if (this.inverse) return at < 0 ? { isMatch: true, score: 0.3, indices: [[0, text.length - 1]], hasInverse: true } : { isMatch: false, score: 1 };
    if (at < 0) return { isMatch: false, score: 1 };
    return { isMatch: true, score: text.length === this.pattern.length ? 0 : 0.1 + at / (text.length * 3), indices: [[at, at + this.pattern.length - 1]] };
  }
}

describe("Fuseter.use", () => {
  Fuse.use(Includes);
  Fuseter.use(Includes);
  const docs = [
    { title: "The Lord of the Rings", author: "Tolkien", tags: ["epic", "fantasy"] }, { title: "Hobbit", author: "tolkien" }, { title: "Harry Potter", author: "Rowling", tags: ["fantasy", "kids"] },
    { title: "lord", author: "x" }, { title: "Dune", tags: ["scifi"] }, { title: "Rings", author: "ring" }, { title: "Ring a ring", author: "Tolkien" },
  ];
  const strings = ["The Lord", "hobbit", "lord", "ring a ring", "x"];
  const queries = ["~lord", "~ring", "~!tolkien", "~!lord", "~zzz", "lord", { author: "~tolkien" }, { $or: [{ title: "~lord" }, { author: "~!tolkien" }] }, { $and: ["~o", { title: "~r" }] }];
  const configs = [{}, { includeMatches: true, includeScore: true }, { includeMatches: true, sortFn: (a, b) => b.score - a.score }, { shouldSort: false }, { ignoreFieldNorm: true, includeScore: true }, { useExtendedSearch: true }];

  for (const [name, collection, base] of [["objects", docs, { keys: ["title", { name: "author", weight: 2 }, "tags"] }], ["strings", strings, {}]]) {
    test(`plugin searchers match Fuse, ${name}`, async () => {
      for (const config of configs) {
        const options = { ...LOCATION, ...base, ...config }, fuse = new Fuse(collection, options);
        for (const backend of ["simd", "js"]) {
          const ff = await Fuseter.create(collection, options, { backend });
          for (const query of queries) for (const limit of [undefined, 0, 1, 2.5, 4]) {
            assert.deepEqual(ff.search(query, { limit }), fuse.search(query, { limit }), `${backend} ${JSON.stringify(config)} ${JSON.stringify(query)} limit=${limit}`);
          }
        }
      }
    });
  }

  test("a custom sortFn sees the hasInverse a plugin returned", () => {
    const seenBy = make => {
      const seen = [], sortFn = (a, b) => { seen.push(a.matches.map(m => m.hasInverse)); return a.score - b.score; };
      const searcher = make({ ...LOCATION, keys: ["title", "author"], sortFn });
      for (const query of ["~!tolkien", "~ring", "~!zzz"]) searcher.search(query);
      return seen;
    };
    const seen = seenBy(options => Fuseter.createSync(docs, options));
    assert.ok(seen.flat().includes(true));
    assert.deepEqual(seen, seenBy(options => new Fuse(docs, options)));
  });

  test("match and parseQuery use plugins", () => {
    assert.deepEqual(Fuseter.match("~ring", "a ring"), Fuse.match("~ring", "a ring"));
    assert.deepEqual(Fuseter.parseQuery({ a: "~ring" }).children[0].searcher.searchIn("a ring"), Fuse.match("~ring", "a ring"));
  });

  test("a plugin needs a condition", () => {
    assert.throws(() => Fuseter.use({}), TypeError);
    assert.throws(() => Fuseter.use(null), TypeError);
  });
});
