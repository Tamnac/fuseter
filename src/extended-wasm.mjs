import { fillCharTable } from "./kernel-js.mjs";
import { allocate, lazyModule } from "./wasm-util.mjs";
import { denseSizes, wasmDenseState } from "./dense.mjs";

export const extendedModule = lazyModule(async () => (await import("./wasm/extended.mjs")).default);
const MAX_PATTERN = 1024;

// The wasm side of extended search on the simd tier, for a built index. It holds the strings and works on `cand`, the list of string ids a sparse search is
// narrowing down, and `bits`, a byte per string. The pattern functions return the number of ids now in cand, or -1 for a pattern longer than the module takes.
//   find(pattern)                          the strings that contain the pattern (substring search)
//   setBuckets(last, order)                the strings grouped by first (last) character, see createStringMatchers
//   listBucket(kind, last, from, to, pattern)   those of order[from..to) that match (kind: 0 includes, 1 starts with, 2 ends with, 3 equals)
//   narrow(kind, inverted, pattern, count) the strings of cand[0..count) for which the term holds; an inverse operator sets bits on them
// clear(count) starts a group over cand[0..count): bits and sum (a float per string, adding up fuzzy scores) are zeroed there.
// subset.narrowFuzzy(patLen, kmax, count) keeps the strings of cand that match a fuzzy pattern (prepared with subset.prep) and adds their scores to sum.
// dense is the wasm version of jsDenseState (dense.mjs).
export function createExtendedWasm({ corpus: { data, offs, n }, present }, { transposition }) {
  const { exports: ex } = extendedModule.instantiate(), mem = ex.memory;
  const P = allocate(mem, {
    text: data.byteLength, offs: offs.byteLength, pat: MAX_PATTERN * 2, cand: n * 4, bits: n, first: n * 4, last: n * 4,
    table: 65536 * 4, st: 256, ...denseSizes(n),
  });
  new Uint16Array(mem.buffer, P.text, data.length).set(data);
  new Uint32Array(mem.buffer, P.offs, offs.length).set(offs);
  const pat = new Uint16Array(mem.buffer, P.pat, MAX_PATTERN), cand = new Int32Array(mem.buffer, P.cand, n);
  const table = new Uint32Array(mem.buffer, P.table, 65536), previous = [];
  const setPattern = pattern => {
    if (pattern.length > MAX_PATTERN) return false;
    for (let i = 0; i < pattern.length; i++) pat[i] = pattern.charCodeAt(i);
    return true;
  };
  return {
    cand, bits: new Uint8Array(mem.buffer, P.bits, n), sum: new Float64Array(mem.buffer, P.dSum, n),
    clear: count => ex.clear_candidates(P.cand, count, P.bits, P.dSum),
    find: pattern => setPattern(pattern) ? ex.find(P.text, data.length, P.offs, P.pat, pattern.length, P.cand) : -1,
    setBuckets: (last, order) => new Uint32Array(mem.buffer, last ? P.last : P.first, n).set(order),
    listBucket: (kind, last, from, to, pattern) => setPattern(pattern) ? ex.list_bucket(kind, P.text, P.offs, last ? P.last : P.first, from, to, P.pat, pattern.length, P.cand) : -1,
    narrow: (kind, inverted, pattern, count) => setPattern(pattern) ? ex.narrow(kind, inverted, P.text, P.offs, P.cand, count, P.pat, pattern.length, P.bits) : -1,
    subset: {
      prep(pattern) { fillCharTable(table, pattern, previous); },
      narrowFuzzy: (patLen, kmax, count) => ex.narrow_fuzzy(P.text, P.offs, P.cand, count, P.table, patLen, kmax, transposition ? 1 : 0, P.dSum, P.st),
    },
    dense: wasmDenseState(ex, mem, P, n, present),
  };
}
