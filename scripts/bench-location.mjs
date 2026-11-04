// Usage: node scripts/bench-location.mjs [books.json]   (FUSE=0 skips Fuse)
// Compares ignoreLocation: true with Fuse's location scoring (ignoreLocation: false, default location and distance) on the three tiers and Fuse.
import { readFileSync } from "node:fs";
import Fuse from "fuse.js";
import { Fuseter } from "../src/index.mjs";

const file = process.argv.slice(2).find(a => !a.startsWith("--")) ?? new URL("../../books_raw.json", import.meta.url);
const books = JSON.parse(readFileSync(file, "utf8")), withFuse = process.env.FUSE !== "0";
const keys = [{ name: "title", weight: 3 }, "author"];

function interleave(fns, rounds, targetMs = 25) {
  const names = Object.keys(fns), samples = Object.fromEntries(names.map(n => [n, []])), reps = {};
  for (const n of names) { fns[n](); fns[n](); const t = performance.now(); fns[n](); reps[n] = Math.max(1, Math.round(targetMs / Math.max(0.02, performance.now() - t))); }
  for (let r = 0; r < rounds; r++) for (const n of names) { const t = performance.now(); for (let k = 0; k < reps[n]; k++) fns[n](); samples[n].push((performance.now() - t) / reps[n]); }
  return Object.fromEntries(names.map(n => [n, Math.min(...samples[n])]));
}
const fmt = x => +x.toFixed(x < 10 ? 2 : 1);

console.log(`${books.length} docs`);
for (const threshold of [0.3, 0.6]) {
  const rows = [], fuses = withFuse && { off: new Fuse(books, { keys, threshold }), on: new Fuse(books, { keys, threshold, ignoreLocation: true }) };
  const built = {};
  for (const backend of ["simd", "wasm", "js"]) for (const ignoreLocation of [true, false]) built[`${backend} ${ignoreLocation ? "unlocated" : "located"}`] = await Fuseter.create(books, { keys, ignoreLocation }, { backend, fallback: "throw" });
  for (const query of ["harry potter", "tolkein", "the lord of the rings the fe", "zxqvkw jjqpx"]) {
    const fns = Object.fromEntries(Object.entries(built).map(([name, ff]) => [name, () => ff.search(query, { threshold })]));
    if (fuses) { fns["fuse unlocated"] = () => fuses.on.search(query); fns["fuse located"] = () => fuses.off.search(query); }
    const times = interleave(fns, fuses ? 5 : 15);
    rows.push({ query, hits: built["simd located"].search(query, { threshold }).length, ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k + " ms", fmt(v)])) });
  }
  console.log(`\nthreshold ${threshold}`);
  console.table(rows);
}
