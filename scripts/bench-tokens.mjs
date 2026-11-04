// Usage: [TIERS=simd,wasm,js] [FUSE=0] node scripts/bench-tokens.mjs [books.json]   Search time of token search against plain search and Fuse's token search.
import { readFileSync } from "node:fs";
import Fuse from "fuse.js";
import { Fuseter } from "../src/index.mjs";

const file = process.argv[2] ?? new URL("../../books_raw.json", import.meta.url);
const books = JSON.parse(readFileSync(file, "utf8"));
const keys = [{ name: "title", weight: 3 }, "author"];
const queries = ["tolkein", "harry potter", "hary poter", "lord rings tolkien", "the lord of the rings the fe", "wen co"];

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
let t = performance.now();
const fuse = withFuse && new Fuse(books, { keys, ignoreLocation: true, useTokenSearch: true });
if (withFuse) { fuse.search("warm up"); console.log(`Fuse token index + first search: ${fmt(performance.now() - t)} ms`); }
const built = {};
for (const backend of (process.env.TIERS ?? "simd,wasm,js").split(",")) {
  t = performance.now();
  built[backend] = {
    plain: await Fuseter.create(books, { keys }, { backend, fallback: "throw" }),
    token: await Fuseter.create(books, { keys, useTokenSearch: true }, { backend, fallback: "throw" }),
  };
  built[backend].token.search("warm up");
  console.log(`${backend}: create x2 + first token search ${fmt(performance.now() - t)} ms`);
}

for (const threshold of [0.3, 0.6]) {
  const rows = [];
  for (const query of queries) {
    const fns = {};
    if (withFuse) { const f = new Fuse(books, { keys, ignoreLocation: true, useTokenSearch: true, threshold }); f.search("warm up"); fns["Fuse token"] = () => f.search(query); }
    for (const [backend, { plain, token }] of Object.entries(built)) {
      fns[`${backend} plain`] = () => plain.search(query, { threshold });
      fns[`${backend} token`] = () => token.search(query, { threshold });
    }
    const times = interleave(fns);
    const { token } = Object.values(built)[0];
    rows.push({ query, hits: token.search(query, { threshold }).length, ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k + " ms", fmt(v)])) });
  }
  console.log(`\nthreshold ${threshold}`);
  console.table(rows);
}
