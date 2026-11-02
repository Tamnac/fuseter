// Page code for scripts/browser-check.mjs: bundled with esbuild and driven by Playwright. Everything is exposed on window.
import { Fuseter } from "../src/index.mjs";
import { rng, randomDocs, randomQueries, stringsOf, compare, fuseFor } from "../test/helpers.mjs";

const BACKENDS = ["simd", "wasm", "js"];
const KEYS = [{ name: "title", weight: 3 }, { name: "author", weight: 2 }, "meta.note"];
const TYPING = [{ firstLetter: true }, { transposition: true }, { firstLetter: true, transposition: true }, { firstLetter: { weighted: "first", midWord: 2 } }];

function corpus(seed) {
  const r = rng(seed), docs = randomDocs(r, 150);
  return { docs, queries: randomQueries(r, stringsOf(docs, ["title", "author"]), 25).filter(q => q.length <= 32) };
}

window.checkEquivalence = async () => {
  const { docs, queries } = corpus(7), errors = [];
  let checked = 0;
  for (const backend of BACKENDS) {
    const ff = await Fuseter.create(docs, { keys: KEYS, includeScore: true }, { backend, fallback: "throw" });
    if (ff.backend !== backend) errors.push(`${backend}: running ${ff.backend}`);
    for (const threshold of [0.1, 0.4, 0.8]) {
      const fuse = fuseFor(docs, { keys: KEYS, threshold });
      for (const query of queries) {
        const diff = compare(ff.search(query, { threshold }), fuse.search(query));
        checked++;
        if (diff) errors.push(`${backend} threshold=${threshold} query=${JSON.stringify(query)}: ${diff}`);
      }
    }
  }
  return { checked, errors };
};

window.checkTyping = async () => {
  const { docs, queries } = corpus(8), errors = [];
  let checked = 0;
  for (const typing of TYPING) {
    const results = {};
    for (const backend of BACKENDS) {
      const ff = await Fuseter.create(docs, { keys: KEYS, includeScore: true, typing }, { backend, fallback: "throw" });
      results[backend] = queries.map(q => ff.search(q, { threshold: 0.4 }));
    }
    for (const backend of ["simd", "wasm"]) results[backend].forEach((got, i) => {
      checked++;
      const diff = compare(got, results.js[i]);
      if (diff) errors.push(`${JSON.stringify(typing)} ${backend} vs js, query=${JSON.stringify(queries[i])}: ${diff}`);
    });
  }
  return { checked, errors };
};

window.checkFallback = async () => {
  const docs = ["Harry Potter", "Lord of the Rings"];
  const ff = await Fuseter.create(docs, { threshold: 0.4 });
  const wasm = await Fuseter.create(docs, { threshold: 0.4 }, { backend: "wasm" });
  const sync = Fuseter.createSync(docs, { threshold: 0.4 });
  const rejected = await Fuseter.create(docs, {}, { fallback: "throw" }).then(() => false, () => true);
  return {
    simd: { backend: ff.backend, requested: ff.requestedBackend, reason: String(ff.fallbackReason ?? "") },
    wasm: { backend: wasm.backend, reason: String(wasm.fallbackReason ?? "") },
    syncBackend: sync.backend,
    throwRejected: rejected,
    found: ff.search("hary poter")[0]?.item,
  };
};
