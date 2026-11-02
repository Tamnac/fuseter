// Usage: node scripts/bench.mjs [books.json] [--fuse]   (default dataset: ../books_raw.json, --fuse also times Fuse.search)
import { readFileSync } from "node:fs";
import Fuse from "fuse.js";
import { Fuseter } from "../src/index.mjs";

const args = process.argv.slice(2), withFuse = args.includes("--fuse");
const file = args.find(a => !a.startsWith("--")) ?? new URL("../../books_raw.json", import.meta.url);
const books = JSON.parse(readFileSync(file, "utf8"));
const keys = [{ name: "title", weight: 3 }, "author"];

// Round-robin rounds, minimum per function: differences under ~10% are noise.
function interleave(fns, rounds = 15, targetMs = 25) {
  const names = Object.keys(fns), samples = Object.fromEntries(names.map(n => [n, []])), reps = {};
  for (const n of names) { fns[n](); fns[n](); const t = performance.now(); fns[n](); reps[n] = Math.max(1, Math.round(targetMs / Math.max(0.02, performance.now() - t))); }
  for (let r = 0; r < rounds; r++) for (const n of names) { const t = performance.now(); for (let k = 0; k < reps[n]; k++) fns[n](); samples[n].push((performance.now() - t) / reps[n]); }
  return Object.fromEntries(names.map(n => [n, Math.min(...samples[n])]));
}

const fmt = x => +x.toFixed(x < 10 ? 2 : 1);
const built = {};
for (const backend of ["simd", "wasm", "js"]) {
  const t = performance.now();
  built[backend] = await Fuseter.create(books, { keys }, { backend, fallback: "throw" });
  console.log(`${backend}: create ${fmt(performance.now() - t)} ms for ${books.length} docs`);
}
const fuses = {};
if (withFuse) for (const threshold of [0.3, 0.6]) fuses[threshold] = new Fuse(books, { keys, threshold, ignoreLocation: true });

for (const threshold of [0.3, 0.6]) {
  const rows = [];
  for (const query of ["harry potter", "tolkein", "the lord of the rings the fe", "zxqvkw jjqpx"]) {
    const fns = Object.fromEntries(Object.entries(built).map(([name, ff]) => [name, () => ff.search(query, { threshold })]));
    if (withFuse) fns.fuse = () => fuses[threshold].search(query);
    const times = interleave(fns, withFuse ? 5 : 15);
    rows.push({ query, hits: built.simd.search(query, { threshold }).length, ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k + " ms", fmt(v)])) });
  }
  console.log(`\nthreshold ${threshold}`);
  console.table(rows);
}
