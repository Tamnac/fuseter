// Usage: [TIERS=simd,wasm,js] [FUSE=0] node scripts/bench-extended.mjs [books.json]   Search time of extended search against plain search and Fuse's extended search.
import { readFileSync } from "node:fs";
import Fuse from "fuse.js";
import { Fuseter } from "../src/index.mjs";

const file = process.argv[2] ?? new URL("../../books_raw.json", import.meta.url);
const books = JSON.parse(readFileSync(file, "utf8"));
const keys = [{ name: "title", weight: 3 }, "author"];
const queries = ["hary poter", "'lord", "^the lord", "=harry potter", "'lord !rings", "tolkein | christie", "hary poter !wizard", "^the !hobbit$ 'ring", "lord rings tolkien"];

// Round-robin rounds, minimum per function: differences under ~10% are noise.
function interleave(fns, rounds = 9, targetMs = 25) {
  const names = Object.keys(fns), samples = Object.fromEntries(names.map(n => [n, []])), reps = {};
  for (const n of names) { fns[n](); fns[n](); const t = performance.now(); fns[n](); reps[n] = Math.max(1, Math.round(targetMs / Math.max(0.02, performance.now() - t))); }
  for (let r = 0; r < rounds; r++) for (const n of names) { const t = performance.now(); for (let k = 0; k < reps[n]; k++) fns[n](); samples[n].push((performance.now() - t) / reps[n]); }
  return Object.fromEntries(names.map(n => [n, Math.min(...samples[n])]));
}

const fmt = x => +x.toFixed(x < 10 ? 3 : 1);
const withFuse = process.env.FUSE !== "0";
console.log(`${books.length} docs`);
const built = {};
for (const backend of (process.env.TIERS ?? "simd,wasm,js").split(",")) {
  const t = performance.now();
  built[backend] = await Fuseter.create(books, { keys, useExtendedSearch: true }, { backend, fallback: "throw" });
  built[backend].search("warm up");
  console.log(`${backend}: create + first search ${fmt(performance.now() - t)} ms`);
}

for (const threshold of [0.3, 0.6]) {
  const rows = [], fuse = withFuse && new Fuse(books, { keys, ignoreLocation: true, useExtendedSearch: true, threshold });
  for (const query of queries) {
    const fns = {};
    if (withFuse) fns.Fuse = () => fuse.search(query);
    for (const [backend, ff] of Object.entries(built)) fns[backend] = () => ff.search(query, { threshold });
    const times = interleave(fns);
    rows.push({ query, hits: Object.values(built)[0].search(query, { threshold }).length, ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k + " ms", fmt(v)])) });
  }
  console.log(`\nthreshold ${threshold}`);
  console.table(rows);
}
