import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fuseter } from "../src/index.mjs";
import { Fuseter as JsOnly } from "../src/js.mjs";
import { Fuseter as WasmEntry } from "../src/wasm.mjs";
import { rng, randomDocs, compare, fuseFor } from "./helpers.mjs";

const docs = randomDocs(rng(5), 120), options = { keys: ["title", "author"], includeScore: true };

async function withPatched(patch, run) {
  const saved = { validate: WebAssembly.validate, compile: WebAssembly.compile };
  Object.assign(WebAssembly, patch);
  try { return await run(); } finally { Object.assign(WebAssembly, saved); }
}

describe("backend selection and fallback", () => {
  test("requested backend is used and reported", async () => {
    for (const backend of ["simd", "wasm", "js"]) assert.equal((await Fuseter.create(docs, options, { backend })).backend, backend);
  });

  test("default backend is the best one in the entry point", async () => {
    assert.equal((await Fuseter.create(docs, options)).backend, "simd");
    assert.equal((await WasmEntry.create(docs, options)).backend, "wasm");
    assert.equal((await JsOnly.create(docs, options)).backend, "js");
  });

  test("simd unavailable degrades to wasm, results still match Fuse", async () => {
    await withPatched({ validate: () => false }, async () => {
      const ff = await Fuseter.create(docs, options);
      assert.equal(ff.backend, "wasm");
      assert.equal(ff.requestedBackend, "simd");
      assert.match(ff.fallbackReason.message, /SIMD/);
      assert.equal(compare(ff.search("harry"), fuseFor(docs, options).search("harry")), null);
    });
  });

  test("fallback 'wasm' does not drop to js", async () => {
    const loaded = await Fuseter.create(docs, options, { backend: "wasm" });
    assert.equal(loaded.backend, "wasm");
    await withPatched({ validate: () => false }, async () => {
      assert.equal((await Fuseter.create(docs, options, { fallback: "wasm" })).backend, "wasm");
    });
  });

  test("fallback 'throw' rejects", async () => {
    await withPatched({ validate: () => false }, async () => {
      await assert.rejects(Fuseter.create(docs, options, { fallback: "throw" }), /SIMD/);
    });
  });

  test("no WebAssembly at all", async () => {
    const saved = globalThis.WebAssembly;
    globalThis.WebAssembly = undefined;
    try {
      const ff = await Fuseter.create(docs, options);
      assert.equal(ff.backend, "js");
      assert.equal(compare(ff.search("tolkien"), fuseFor(docs, options).search("tolkien")), null);
      await assert.rejects(Fuseter.create(docs, options, { fallback: "wasm" }), /no fallback/);
    } finally { globalThis.WebAssembly = saved; }
  });

  test("a backend missing from the entry point is rejected", async () => {
    await assert.rejects(JsOnly.create(docs, options, { backend: "simd" }), /not available/);
  });

  test("createSync is js", () => {
    assert.equal(JsOnly.createSync(docs, options).backend, "js");
    assert.equal(Fuseter.createSync(docs, options).backend, "js");
  });
});

describe("collection and options", () => {
  test("setCollection replaces the data on every backend", async () => {
    const next = randomDocs(rng(6), 90);
    for (const backend of ["simd", "wasm", "js"]) {
      const ff = await Fuseter.create(docs, options, { backend });
      ff.search("a");
      ff.setCollection(next);
      assert.equal(ff.backend, backend);
      assert.equal(compare(ff.search("lord"), fuseFor(next, options).search("lord")), null, backend);
    }
  });

  test("repeated searches on one instance stay correct", async () => {
    const ff = await Fuseter.create(docs, options), fuse = fuseFor(docs, options);
    for (const q of ["harry potter", "x", "the lord of the rings the fellowship of the ring and more", "harry potter", "ab", "harry potter"]) {
      assert.equal(compare(ff.search(q), fuse.search(q)), null, q);
    }
  });

  test("unsupported options are rejected, not ignored", async () => {
    for (const bad of [{ useExtendedSearch: true }, { ignoreLocation: false }, { tokenMatch: "some" }, { tokenize: "\w+" }, { tokenize: /w+/ }, { sortFn: "score" }, { getFn: 1 }, { minMatchCharLength: "2" }, { typo: 1 }]) {
      await assert.rejects(Fuseter.create(docs, { ...options, ...bad }), TypeError, JSON.stringify(Object.keys(bad)));
    }
    await assert.rejects(Fuseter.create(docs, { keys: [{ name: "title", weight: 0 }] }), RangeError);
    await assert.rejects(Fuseter.create({}, {}), TypeError);
  });

  test("accepted no-op options", async () => {
    const ff = await Fuseter.create(docs, { ...options, ignoreLocation: true, distance: 100, location: 0, minMatchCharLength: 1, shouldSort: true });
    assert.ok(ff.search("harry").length >= 0);
  });
});

describe("token search with typing heuristics", () => {
  test("applies the heuristics to each term on every backend", async () => {
    const books = [{ title: "The Hobbit" }, { title: "Harry Potter and the Chamber of Secrets" }, { title: "Lord of the Rings" }];
    const typing = { firstLetter: true, transposition: true };
    for (const backend of ["simd", "wasm", "js"]) {
      const ff = await Fuseter.create(books, { keys: ["title"], useTokenSearch: true, typing, threshold: 0.4 }, { backend, fallback: "throw" });
      assert.equal(ff.search("hary poter")[0]?.item, books[1], backend);
      assert.equal(ff.search("hobbti")[0]?.item, books[0], backend);
    }
  });
});
