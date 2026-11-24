import { fillCharTable, bucketMasks, patternBuckets } from "./kernel-js.mjs";
import { lazyModule, allocate, wasmSupported, tokenSizes, wasmTokenAccumulator } from "./wasm-util.mjs";
import scalarBase64 from "./wasm/scalar.mjs";

const module = lazyModule(async () => scalarBase64);

export const wasmBackend = {
  name: "wasm",
  async load() {   // one module holds all kernels
    if (!wasmSupported()) throw new Error("WebAssembly is not available");
    await module.load();
  },
  create(index, { transposition }) {
    const { corpus } = index;
    const { exports: ex } = module.instantiate(), mem = ex.memory, { starts } = corpus;
    const P = allocate(mem, { data: corpus.data.byteLength, starts: starts?.byteLength ?? 0, offs: corpus.offs.byteLength, table: 65536 * 4, out: corpus.n * 8, st: 512, once: corpus.n * 4, twice: corpus.n * 4, thrice: corpus.n * 4, ...tokenSizes(index) });
    new Uint16Array(mem.buffer, P.data, corpus.data.length).set(corpus.data);
    if (starts) new Uint8Array(mem.buffer, P.starts, starts.length).set(starts);
    new Uint32Array(mem.buffer, P.offs, corpus.offs.length).set(corpus.offs);
    for (const name of ["once", "twice", "thrice"]) new Int32Array(mem.buffer, P[name], corpus.n).set(bucketMasks(corpus)[name]);
    const table = new Uint32Array(mem.buffer, P.table, 65536), out = new Float64Array(mem.buffer, P.out, corpus.n), previous = [];
    let buckets;
    const scanPlain = transposition ? ex.scan_myers_t : ex.scan_myers, scanWeighted = transposition ? ex.scan2wt : ex.scan2w;
    return {
      out,
      tokens: wasmTokenAccumulator(ex, mem, P, { nStr: corpus.n, K: index.K, nDocs: index.nDocs, out }),
      prep(pattern) { fillCharTable(table, pattern, previous); buckets = patternBuckets(pattern); },
      // A missing rule (no weighted position, chunked pattern) takes the plain kernel.
      scan(patLen, kmax, rule = null) {
        if (rule) scanWeighted(P.data, P.starts, P.offs, corpus.n, P.table, patLen, kmax, P.out, P.st, rule.mask, rule.midWord, rule.denom, P.once, P.twice, P.thrice, buckets.once, buckets.twice, buckets.thrice);
        else scanPlain(P.data, P.offs, corpus.n, P.table, patLen, kmax, P.out, P.once, P.twice, P.thrice, buckets.once, buckets.twice, buckets.thrice);
        return out;
      },
    };
  },
};
