// Usage: [TIERS=simd,wasm,js] [VARIANTS=standard,both,...] node scripts/bench-typing.mjs [books.json]   Search time of the typing heuristics against the standard kernels, per backend.
import { readFileSync } from "node:fs";
import { Fuseter } from "../src/index.mjs";

const file = process.argv[2] ?? new URL("../../books_raw.json", import.meta.url);
const books = JSON.parse(readFileSync(file, "utf8"));
const keys = [{ name: "title", weight: 3 }, "author"];
const variants = {
  standard: undefined,
  firstLetter: { firstLetter: true },
  "first only": { firstLetter: { weighted: "first" } },
  transposition: { transposition: true },
  both: { firstLetter: true, transposition: true },
};

// Round-robin rounds, minimum per function: differences under ~10% are noise.
function interleave(fns, rounds = 15, targetMs = 25) {
  const names = Object.keys(fns), samples = Object.fromEntries(names.map(n => [n, []])), reps = {};
  for (const n of names) { fns[n](); fns[n](); const t = performance.now(); fns[n](); reps[n] = Math.max(1, Math.round(targetMs / Math.max(0.02, performance.now() - t))); }
  for (let r = 0; r < rounds; r++) for (const n of names) { const t = performance.now(); for (let k = 0; k < reps[n]; k++) fns[n](); samples[n].push((performance.now() - t) / reps[n]); }
  return Object.fromEntries(names.map(n => [n, Math.min(...samples[n])]));
}

const fmt = x => +x.toFixed(x < 10 ? 3 : 1);
console.log(`${books.length} docs`);
for (const backend of (process.env.TIERS ?? "simd,wasm,js").split(",")) {
  const built = {};
  for (const [name, typing] of Object.entries(variants)) {
    if (process.env.VARIANTS && !process.env.VARIANTS.split(",").includes(name)) continue;
    built[name] = await Fuseter.create(books, { keys, typing }, { backend, fallback: "throw" });
  }
  for (const threshold of [0.3, 0.6]) {
    const rows = [];
    for (const query of ["harry potter", "tolkein", "the lord of the rings the fe"]) {
      const fns = Object.fromEntries(Object.entries(built).map(([name, ff]) => [name, () => ff.search(query, { threshold })]));
      const times = interleave(fns);
      rows.push({ query, hits: built.standard.search(query, { threshold }).length, ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k + " ms", fmt(v)])) });
    }
    console.log(`\n${backend}, threshold ${threshold}`);
    console.table(rows);
  }
}
